const WhatsAppOrderDraftStore =
    require('./WhatsAppOrderDraftStore');
const WhatsAppProductContextStore =
    require('./WhatsAppProductContextStore');
const WhatsAppProductContextResolver =
    require('./WhatsAppProductContextResolver');
const ProductOrderDraftHandler =
    require('./ProductOrderDraftHandler');
const WhatsAppOrderDraftQuantityService =
    require('./WhatsAppOrderDraftQuantityService');
const FulfillmentSelectionHandler =
    require('./FulfillmentSelectionHandler');
const PickupPaymentSelectionHandler =
    require('./PickupPaymentSelectionHandler');
const DeliveryPaymentSelectionHandler =
    require('./DeliveryPaymentSelectionHandler');
const WhatsAppCartStore =
    require('./WhatsAppCartStore');
const PasarPintarSemanticCatalogService =
    require('./PasarPintarSemanticCatalogService');
const PasarPintarProductResolver =
    require('./PasarPintarProductResolver');

class PasarPintarAIOperationExecutor {
    constructor(pool) {
        this.orderDraftStore =
            new WhatsAppOrderDraftStore(pool);

        this.productContextStore =
            new WhatsAppProductContextStore(pool);

        this.productContextResolver =
            new WhatsAppProductContextResolver();

        this.productOrderDraftHandler =
            new ProductOrderDraftHandler(pool);

        this.quantityService =
            new WhatsAppOrderDraftQuantityService(
                pool
            );

        this.fulfillmentHandler =
            new FulfillmentSelectionHandler(pool);

        this.pickupPaymentHandler =
            new PickupPaymentSelectionHandler(pool);

        this.deliveryPaymentHandler =
            new DeliveryPaymentSelectionHandler(pool);
        this.cartStore =
            new WhatsAppCartStore(pool);
        this.semanticCatalogService =
            new PasarPintarSemanticCatalogService(
                pool
            );
        this.productResolver =
            new PasarPintarProductResolver(
                this.semanticCatalogService
            );
    }

    async execute({
        operations,
        customer,
        messageId = null,
        conversationLanguage = null
    }) {
        const customerId =
            customer?.customer_id || null;

        const requestedLanguage =
            String(
                conversationLanguage || ''
            )
                .trim()
                .toLowerCase();

        const safeConversationLanguage =
            [
                'id',
                'su',
                'en'
            ].includes(requestedLanguage)
                ? requestedLanguage
                : null;

        if (
            !customerId ||
            !Array.isArray(operations)
        ) {
            return {
                status: 'invalid_input',
                results: []
            };
        }

        const planValidation =
            this.validatePlan(operations);

        if (!planValidation.valid) {
            return {
                status: 'invalid_plan',
                reason: planValidation.reason,
                results: []
            };
        }

        const results = [];

        let clarificationRequired = false;
        for (let index = 0;
            index < operations.length;
            index++
        ) {
            const operation =
                operations[index];

            if (
                operation?.type ===
                    'SET_QUANTITY' &&
                results.some(item =>
                    item?.result
                        ?.consumedQuantity ===
                        true
                )
            ) {
                results.push({
                    operation,
                    result: {
                        status:
                            'quantity_already_consumed'
                    }
                });

                continue;
            }

            const result =
                await this.executeOne({
                    operation,
                    customer,
                    messageId,
                    operations,
                    index,
                    conversationLanguage:
                        safeConversationLanguage
                });

            results.push({
                operation,
                result
            });

            /*
             * Fail closed.
             * Jangan teruskan operation berikutnya
             * bila operation sekarang gagal.
             */
            if (
                !this.isSuccessful(
                    operation,
                    result
                )
            ) {
                /*
                 * ADD_PRODUCT boleh fail-soft hanya
                 * untuk masalah resolusi katalog.
                 *
                 * Item lain pada pesan yang sama
                 * tetap diproses. Error validasi,
                 * stok, database, dan transaksi
                 * tetap fail-closed.
                 */
                if (
                    this.isRecoverableCartResolution(
                        operation,
                        result
                    )
                ) {
                    clarificationRequired = true;
                    continue;
                }

                return {
                    status:
                        'operation_stopped',
                    stoppedAt:
                        index,
                    results
                };
            }
        }

        return {
            status:
                clarificationRequired
                    ? 'executed_with_clarification'
                    : 'executed',
            results
        };
    }

    validatePlan(operations) {
        if (!Array.isArray(operations)) {
            return {
                valid: false,
                reason: 'operations_invalid'
            };
        }

        const fulfillments =
            operations
                .filter(
                    item =>
                        item?.type ===
                        'SET_FULFILLMENT'
                )
                .map(
                    item =>
                        String(
                            item.fulfillment || ''
                        ).toUpperCase()
                );

        const payments =
            operations
                .filter(
                    item =>
                        item?.type ===
                        'SET_PAYMENT'
                )
                .map(
                    item =>
                        String(
                            item.paymentPreference || ''
                        ).toUpperCase()
                );

        if (
            new Set(fulfillments).size > 1
        ) {
            return {
                valid: false,
                reason: 'conflicting_fulfillment'
            };
        }

        if (
            new Set(payments).size > 1
        ) {
            return {
                valid: false,
                reason: 'conflicting_payment'
            };
        }

        if (
            fulfillments.includes('DELIVERY') &&
            payments.includes('OUTLET')
        ) {
            return {
                valid: false,
                reason:
                    'outlet_payment_requires_pickup'
            };
        }

        return {
            valid: true,
            reason: null
        };
    }

    async executeOne({
        operation,
        customer,
        messageId,
        operations,
        index,
        conversationLanguage = null
    }) {
        if (
            !operation ||
            typeof operation !== 'object'
        ) {
            return {
                status:
                    'invalid_operation'
            };
        }

        switch (operation.type) {
            case 'LEGACY_INTENT':
                return {
                    status:
                        'legacy_intent_ready',
                    intent:
                        operation.intent
                };

            case 'SELECT_PRODUCT':
            case 'SELECT_VARIANT':
                return this.executeProductSelection({
                    operation,
                    customer,
                    messageId,
                    operations,
                    index
                });

            case 'SET_QUANTITY':
                if (operation.productQuery) {
                    return this.executeCartSetQuantity({
                        operation,
                        customer,
                        messageId,
                        operationIndex: index
                    });
                }

                /*
                 * Kompatibilitas jalur draft lama.
                 */
                return this.quantityService.update({
                    customerId:
                        customer.customer_id,
                    quantity:
                        operation.quantity
                });

            case 'SET_FULFILLMENT':
                return this.fulfillmentHandler.handle({
                    customer,
                    action:
                        operation.fulfillment ===
                            'PICKUP'
                            ? 'SET_PICKUP'
                            : 'SET_DELIVERY'
                });

            case 'SET_PAYMENT':
                return this.executePayment({
                    operation,
                    customer
                });

            case 'ADD_PRODUCT':
                return this.executeAddProduct({
                    operation,
                    customer,
                    messageId,
                    operationIndex: index,
                    conversationLanguage
                });

            case 'REMOVE_PRODUCT':
                return this.executeCartRemoveProduct({
                    operation,
                    customer,
                    messageId,
                    operationIndex: index
                });

            case 'SHOW_CART':
                return this.executeShowCart({
                    customer
                });

            /*
             * Sengaja belum diberi hak eksekusi.
             */
            case 'CONFIRM_ORDER':
            case 'CANCEL_ORDER':
            case 'SET_ADDRESS':
                return {
                    status:
                        'not_executable_yet'
                };

            default:
                return {
                    status:
                        'unsupported_operation'
                };
        }
    }

    normalizeProductResolutionText(value) {
        return String(value || '')
            .trim()
            .toLowerCase()
            .replace(/[.,]/g, ' ')
            .replace(/\s+/g, ' ');
    }

    resolveCartItem({
        query,
        variant = null,
        items = []
    }) {
        if (
            !Array.isArray(items) ||
            items.length === 0
        ) {
            return {
                status: 'cart_item_not_found',
                item: null,
                candidates: []
            };
        }

        const requested =
            this.normalizeProductResolutionText(
                [query, variant]
                    .filter(Boolean)
                    .join(' ')
            );

        if (!requested) {
            return {
                status: 'cart_item_query_required',
                item: null,
                candidates: []
            };
        }

        const exact =
            items.filter(item =>
                this.normalizeProductResolutionText(
                    item?.product_name
                ) === requested
            );

        if (exact.length === 1) {
            return {
                status: 'cart_item_resolved',
                item: exact[0],
                candidates: exact
            };
        }

        const partial =
            items.filter(item => {
                const name =
                    this.normalizeProductResolutionText(
                        item?.product_name
                    );

                return (
                    name.includes(requested) ||
                    requested.includes(name)
                );
            });

        if (partial.length === 1) {
            return {
                status: 'cart_item_resolved',
                item: partial[0],
                candidates: partial
            };
        }

        if (partial.length > 1) {
            return {
                status: 'cart_item_ambiguous',
                item: null,
                candidates: partial
            };
        }

        /*
         * Token containment fallback.
         *
         * Nama customer tidak harus identik dengan nama
         * authoritative di cart.
         *
         * Contoh:
         *   request: "bihun tanam jagung"
         *   cart:    "Bihun Cap Tanam Jagung"
         *
         * Semua token yang diminta harus ada pada nama item.
         * Tidak ada kamus produk, alias kategori, atau tebakan AI.
         */
        const requestedTokens =
            requested
                .split(/\s+/)
                .map(token => token.trim())
                .filter(Boolean);

        const tokenMatches =
            requestedTokens.length > 0
                ? items.filter(item => {
                    const nameTokens =
                        new Set(
                            this
                                .normalizeProductResolutionText(
                                    item?.product_name
                                )
                                .split(/\s+/)
                                .map(token => token.trim())
                                .filter(Boolean)
                        );

                    return requestedTokens.every(
                        token =>
                            nameTokens.has(token)
                    );
                })
                : [];

        if (tokenMatches.length === 1) {
            return {
                status: 'cart_item_resolved',
                item: tokenMatches[0],
                candidates: tokenMatches
            };
        }

        if (tokenMatches.length > 1) {
            return {
                status: 'cart_item_ambiguous',
                item: null,
                candidates: tokenMatches
            };
        }

        return {
            status: 'cart_item_not_found',
            item: null,
            candidates: []
        };
    }

    async executeCartSetQuantity({
        operation,
        customer,
        messageId = null,
        operationIndex = null
    }) {
        const customerId =
            customer?.customer_id;

        const quantity =
            Number(operation?.quantity);

        if (
            !customerId ||
            !Number.isInteger(quantity) ||
            quantity < 1 ||
            quantity > 100
        ) {
            return {
                status: 'invalid_quantity'
            };
        }

        const cart =
            await this.cartStore.getCart(
                customerId
            );

        if (cart.status !== 'cart_ready') {
            return {
                status: cart.status
            };
        }

        const resolution =
            this.resolveCartItem({
                query:
                    operation.productQuery,
                variant:
                    operation.variant,
                items:
                    cart.items
            });

        if (
            resolution.status !==
                'cart_item_resolved' ||
            !resolution.item?.product_id
        ) {
            return {
                status: resolution.status,
                productQuery:
                    operation.productQuery,
                candidates:
                    resolution.candidates.map(
                        item => ({
                            id: item.product_id,
                            name:
                                item.product_name,
                            quantity:
                                item.quantity
                        })
                    )
            };
        }

        const updated =
            await this.cartStore.setQuantity({
                customerId,
                productId:
                    resolution.item.product_id,
                quantity,
                sourceMessageId:
                    messageId || null,
                operationIndex,
                operationType:
                    'SET_QUANTITY'
            });

        if (updated.status !== 'cart_ready') {
            return {
                status:
                    updated.status ||
                    'cart_quantity_failed',
                productId:
                    resolution.item.product_id,
                productName:
                    resolution.item.product_name
            };
        }

        return {
            status: 'cart_quantity_updated',
            productId:
                resolution.item.product_id,
            productName:
                resolution.item.product_name,
            quantity,
            cart: updated
        };
    }

    async executeCartRemoveProduct({
        operation,
        customer,
        messageId = null,
        operationIndex = null
    }) {
        const customerId =
            customer?.customer_id;

        if (!customerId) {
            return {
                status: 'invalid_customer'
            };
        }

        const completedOperation =
            await this.cartStore
                .getCompletedOperation({
                    customerId,
                    sourceMessageId:
                        messageId || null,
                    operationIndex,
                    operationType:
                        'REMOVE_PRODUCT'
                });

        if (completedOperation) {
            const replayCart =
                await this.cartStore.getCart(
                    customerId
                );

            return {
                status:
                    'product_removed_from_cart',
                idempotentReplay: true,
                cart: replayCart
            };
        }

        const cart =
            await this.cartStore.getCart(
                customerId
            );

        if (cart.status !== 'cart_ready') {
            return {
                status: cart.status
            };
        }

        const resolution =
            this.resolveCartItem({
                query:
                    operation.productQuery,
                variant:
                    operation.variant,
                items:
                    cart.items
            });

        if (
            resolution.status !==
                'cart_item_resolved' ||
            !resolution.item?.product_id
        ) {
            return {
                status: resolution.status,
                productQuery:
                    operation.productQuery,
                candidates:
                    resolution.candidates.map(
                        item => ({
                            id: item.product_id,
                            name:
                                item.product_name,
                            quantity:
                                item.quantity
                        })
                    )
            };
        }

        const removed =
            await this.cartStore.removeItem({
                customerId,
                productId:
                    resolution.item.product_id,
                sourceMessageId:
                    messageId || null,
                operationIndex,
                operationType:
                    'REMOVE_PRODUCT'
            });

        if (removed.status !== 'cart_ready') {
            return {
                status:
                    removed.status ||
                    'cart_remove_failed',
                productId:
                    resolution.item.product_id,
                productName:
                    resolution.item.product_name
            };
        }

        return {
            status: 'product_removed_from_cart',
            productId:
                resolution.item.product_id,
            productName:
                resolution.item.product_name,
            cart: removed
        };
    }

    async executeShowCart({
        customer
    }) {
        const customerId =
            customer?.customer_id;

        if (!customerId) {
            return {
                status: 'invalid_customer'
            };
        }

        const cart =
            await this.cartStore.getCart(
                customerId
            );

        if (cart.status === 'cart_not_found') {
            return {
                status: 'cart_empty',
                cart
            };
        }

        if (cart.status !== 'cart_ready') {
            return {
                status:
                    cart.status ||
                    'cart_read_failed'
            };
        }

        return {
            status: 'cart_shown',
            cart
        };
    }

    async executeAddProduct({
        operation,
        customer,
        messageId,
        operationIndex = null,
        conversationLanguage = null
    }) {
        const customerId =
            customer?.customer_id;

        const productQuery =
            String(
                operation?.productQuery || ''
            ).trim();

        const variant =
            String(
                operation?.variant || ''
            ).trim();

        const quantity =
            Number(operation?.quantity || 1);

        if (
            !customerId ||
            !productQuery ||
            !Number.isInteger(quantity) ||
            quantity < 1 ||
            quantity > 100
        ) {
            return {
                status: 'add_product_invalid'
            };
        }

        const resolution =
            await this.productResolver.resolve({
                query: productQuery,
                variant
            });

        if (
            resolution.status !==
                'product_resolved' ||
            !resolution.product?.id
        ) {
            return {
                status:
                    resolution.status,
                productQuery,
                candidates:
                    resolution.candidates
                        .map(product => ({
                            id: product.id,
                            name: product.name,
                            price: product.price,
                            stock: product.stock
                        }))
            };
        }

        /*
         * Catalog hanya resolver.
         * Harga/stok/satuan tetap divalidasi ulang
         * melalui handler canonical.
         */
        const validated =
            await this.productOrderDraftHandler
                .handleSelectedProduct({
                    productId:
                        resolution.product.id,
                    quantity
                });

        if (
            validated.status !==
                'draft_ready' ||
            !validated.draft
        ) {
            return {
                status:
                    validated.status ||
                    'product_validation_failed',
                productId:
                    resolution.product.id,
                productName:
                    resolution.product.name
            };
        }

        const cartResult =
            await this.cartStore.addItem({
                customerId,
                draft:
                    validated.draft,
                sourceMessageId:
                    messageId || null,
                language:
                    conversationLanguage,
                operationIndex,
                operationType:
                    'ADD_PRODUCT'
            });

        if (
            cartResult.status !==
                'cart_ready'
        ) {
            return {
                status:
                    cartResult.status ||
                    'cart_add_failed',
                productId:
                    resolution.product.id,
                productName:
                    resolution.product.name
            };
        }

        return {
            status: 'product_added_to_cart',
            productId:
                resolution.product.id,
            productName:
                resolution.product.name,
            quantity,
            cart:
                cartResult
        };
    }

    async executeProductSelection({
        operation,
        customer,
        messageId,
        operations,
        index
    }) {
        const customerId =
            customer.customer_id;

        const context =
            await this.productContextStore
                .getActive(customerId);

        if (!context) {
            return {
                status:
                    'product_context_missing'
            };
        }

        const contextType =
            String(
                context.context_type || ''
            ).toUpperCase();

        /*
         * Mutating product selection hanya boleh
         * berasal dari konteks order ambiguity.
         *
         * PRODUCT_REFERENCE hanyalah konteks
         * percakapan/catalog dan tidak boleh
         * diam-diam membuat draft pesanan.
         */
        if (
            contextType !==
                'PRODUCT_ORDER_SELECTION'
        ) {
            return {
                status:
                    'product_order_context_required'
            };
        }

        const products =
            context.context_payload
                ?.products || [];

        if (
            !Array.isArray(products) ||
            products.length === 0
        ) {
            return {
                status:
                    'product_context_empty'
            };
        }

        let resolverText = '';

        if (
            operation.type ===
                'SELECT_PRODUCT' &&
            operation.selectionNumber
        ) {
            resolverText =
                `nomor ${operation.selectionNumber}`;
        } else if (
            operation.type ===
                'SELECT_VARIANT' &&
            operation.variant
        ) {
            resolverText =
                String(operation.variant);
        } else {
            return {
                status:
                    'product_selection_invalid'
            };
        }

        const resolution =
            this.productContextResolver.resolve(
                resolverText,
                products
            );

        if (
            resolution?.action !==
                'SELECT' ||
            !resolution.product?.id
        ) {
            return {
                status:
                    'product_selection_unresolved'
            };
        }

        /*
         * Quantity:
         * 1. SET_QUANTITY berikutnya pada pesan
         *    yang sama.
         * 2. quantity dari order-selection context.
         * 3. default 1.
         */
        const nextQuantityOperation =
            operations
                .slice(index + 1)
                .find(item =>
                    item?.type ===
                        'SET_QUANTITY'
                );

        const contextQuantity =
            Number(
                context.context_payload
                    ?.quantity || 1
            );

        const quantity =
            nextQuantityOperation
                ?.quantity ||
            (
                Number.isInteger(
                    contextQuantity
                ) &&
                contextQuantity > 0
                    ? contextQuantity
                    : 1
            );

        const selected =
            await this.productOrderDraftHandler
                .handleSelectedProduct({
                    productId:
                        resolution.product.id,
                    quantity
                });

        if (
            selected.status !==
                'draft_ready' ||
            !selected.draft
        ) {
            return selected;
        }

        if (!messageId) {
            return {
                status:
                    'source_message_missing'
            };
        }

        const stored =
            await this.orderDraftStore
                .createOrReplace({
                    customerId,
                    draft:
                        selected.draft,
                    sourceMessageId:
                        messageId
                });

        await this.productContextStore
            .clear(customerId);

        return {
            ...selected,
            status:
                'product_selected',
            draftStorageStatus:
                stored.status,
            draftId:
                stored.draft?.id || null,
            consumedQuantity:
                Boolean(
                    nextQuantityOperation
                )
        };
    }

    async executePayment({
        operation,
        customer
    }) {
        const draft =
            await this.orderDraftStore
                .getPending(
                    customer.customer_id
                );

        if (!draft) {
            return {
                status:
                    'draft_not_found'
            };
        }

        if (
            draft
                .fulfillment_selection_explicit !==
                true
        ) {
            return {
                status:
                    'fulfillment_required'
            };
        }

        const fulfillment =
            String(
                draft.fulfillment_type || ''
            )
                .trim()
                .toUpperCase();

        const payment =
            String(
                operation.paymentPreference ||
                ''
            )
                .trim()
                .toUpperCase();

        if (
            fulfillment === 'PICKUP'
        ) {
            if (
                ![
                    'OUTLET',
                    'ONLINE'
                ].includes(payment)
            ) {
                return {
                    status:
                        'invalid_pickup_payment'
                };
            }

            return this.pickupPaymentHandler
                .handle({
                    customer,
                    action:
                        payment === 'OUTLET'
                            ? 'SET_OUTLET_PAYMENT'
                            : 'SET_ONLINE_PAYMENT'
                });
        }

        if (
            fulfillment === 'DELIVERY'
        ) {
            if (payment !== 'ONLINE') {
                return {
                    status:
                        'invalid_delivery_payment'
                };
            }

            return this.deliveryPaymentHandler
                .handle({
                    customer,
                    action:
                        'SET_ONLINE_PAYMENT'
                });
        }

        return {
            status:
                'invalid_fulfillment'
        };
    }

    isRecoverableCartResolution(
        operation,
        result
    ) {
        const type =
            String(
                operation?.type || ''
            );

        const status =
            String(
                result?.status || ''
            );

        if (type === 'ADD_PRODUCT') {
            return [
                'product_not_found',
                'product_ambiguous'
            ].includes(status);
        }

        if (
            type === 'SET_QUANTITY' ||
            type === 'REMOVE_PRODUCT'
        ) {
            return [
                'cart_item_not_found',
                'cart_item_ambiguous',
                'cart_item_query_required'
            ].includes(status);
        }

        return false;
    }

    isSuccessful(operation, result) {
        const status =
            String(
                result?.status || ''
            );

        if (
            operation.type ===
                'LEGACY_INTENT'
        ) {
            return status ===
                'legacy_intent_ready';
        }

        if (
            operation.type ===
                'SELECT_PRODUCT' ||
            operation.type ===
                'SELECT_VARIANT'
        ) {
            return status ===
                'product_selected';
        }

        if (
            operation.type ===
                'ADD_PRODUCT'
        ) {
            return status ===
                'product_added_to_cart';
        }

        if (
            operation.type ===
                'REMOVE_PRODUCT'
        ) {
            return status ===
                'product_removed_from_cart';
        }

        if (
            operation.type ===
                'SHOW_CART'
        ) {
            return [
                'cart_shown',
                'cart_empty'
            ].includes(status);
        }

        if (
            operation.type ===
                'SET_QUANTITY'
        ) {
            if (operation.productQuery) {
                return status ===
                    'cart_quantity_updated';
            }

            /*
             * Jika quantity sudah dikonsumsi oleh
             * product selection sebelumnya, executor
             * tahap berikutnya akan kita optimalkan.
             */
            return status ===
                'quantity_updated';
        }

        if (
            operation.type ===
                'SET_FULFILLMENT'
        ) {
            return [
                'delivery_selected',
                'pickup_selected'
            ].includes(status);
        }

        if (
            operation.type ===
                'SET_PAYMENT'
        ) {
            return [
                'outlet_payment_selected',
                'online_payment_selected'
            ].includes(status);
        }

        return false;
    }
}

module.exports =
    PasarPintarAIOperationExecutor;
