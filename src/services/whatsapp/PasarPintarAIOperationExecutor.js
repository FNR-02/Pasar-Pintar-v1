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
    }

    async execute({
        operations,
        customer,
        messageId = null
    }) {
        const customerId =
            customer?.customer_id || null;

        if (
            !customerId ||
            !Array.isArray(operations)
        ) {
            return {
                status: 'invalid_input',
                results: []
            };
        }

        const results = [];

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
                    index
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
            status: 'executed',
            results
        };
    }

    async executeOne({
        operation,
        customer,
        messageId,
        operations,
        index
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

            /*
             * Sengaja belum diberi hak eksekusi.
             */
            case 'CONFIRM_ORDER':
            case 'CANCEL_ORDER':
            case 'SET_ADDRESS':
            case 'ADD_PRODUCT':
            case 'REMOVE_PRODUCT':
            case 'SHOW_CART':
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
                'SET_QUANTITY'
        ) {
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
