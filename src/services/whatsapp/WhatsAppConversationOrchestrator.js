const WhatsAppIntentClassifier =
    require('./WhatsAppIntentClassifier');

const WhatsAppIntentRouter =
    require('./WhatsAppIntentRouter');

const ProductInquiryHandler =
    require('./ProductInquiryHandler');
const ProductImageHandler =
    require('./ProductImageHandler');

const GreetingHandler =
    require('./GreetingHandler');

const OrderStatusHandler =
    require('./OrderStatusHandler');

const ProductOrderDraftHandler =
    require('./ProductOrderDraftHandler');

const WhatsAppOrderDraftStore =
    require('./WhatsAppOrderDraftStore');
const WhatsAppOrderDraftProductReplacementService =
    require('./WhatsAppOrderDraftProductReplacementService');
const WhatsAppOrderDraftQuantityService =
    require('./WhatsAppOrderDraftQuantityService');
const WhatsAppProductContextStore =
    require('./WhatsAppProductContextStore');
const WhatsAppProductContextResolver =
    require('./WhatsAppProductContextResolver');

const OrderConfirmationHandler =
    require('./OrderConfirmationHandler');

const OrderCancelHandler =
    require('./OrderCancelHandler');

const WhatsAppOrderConfirmationService =
    require('./WhatsAppOrderConfirmationService');

const WhatsAppPaymentRequestHandler =
    require('./WhatsAppPaymentRequestHandler');

const PaymentIntentService =
    require('../payments/PaymentIntentService');

const MultiCommandHandler =
    require('./MultiCommandHandler');
const AddressUpdateHandler =
    require('./AddressUpdateHandler');

const FulfillmentSelectionHandler =
    require('./FulfillmentSelectionHandler');

const PickupPaymentSelectionHandler =
    require('./PickupPaymentSelectionHandler');

const DeliveryPaymentSelectionHandler =
    require('./DeliveryPaymentSelectionHandler');
const EmptyMessageHandler =
    require('./EmptyMessageHandler');
const FallbackHandler =
    require('./FallbackHandler');
const PasarPintarGeminiConversationAI =
    require('./PasarPintarGeminiConversationAI');
const PasarPintarAIUnderstandingAdapter =
    require('./PasarPintarAIUnderstandingAdapter');
const PasarPintarAIOperationExecutor =
    require('./PasarPintarAIOperationExecutor');
const PasarPintarAIResponseBuilder =
    require('./PasarPintarAIResponseBuilder');
const PasarPintarSemanticCatalogService =
    require('./PasarPintarSemanticCatalogService');


class WhatsAppConversationOrchestrator {
    constructor(pool, CommerceKernel = null) {
        this.intentClassifier =
            new WhatsAppIntentClassifier();

        this.intentRouter =
            new WhatsAppIntentRouter();

        this.productInquiryHandler =
            new ProductInquiryHandler(pool);
        this.productImageHandler =
            new ProductImageHandler(pool);

        this.greetingHandler =
            new GreetingHandler();

        this.orderStatusHandler =
            new OrderStatusHandler(pool);

        this.productOrderDraftHandler =
            new ProductOrderDraftHandler(pool);

        this.orderDraftStore =
            new WhatsAppOrderDraftStore(pool);
        this.orderDraftProductReplacementService =
            new WhatsAppOrderDraftProductReplacementService(
                pool
            );
        this.orderDraftQuantityService =
            new WhatsAppOrderDraftQuantityService(
                pool
            );
        this.productContextStore =
            new WhatsAppProductContextStore(pool);
        this.productContextResolver =
            new WhatsAppProductContextResolver();

        this.orderConfirmationHandler =
            new OrderConfirmationHandler(pool);

        this.orderCancelHandler =
            new OrderCancelHandler(pool);

        this.orderConfirmationService =
            new WhatsAppOrderConfirmationService(
                pool,
                CommerceKernel
            );

        this.paymentRequestHandler =
            new WhatsAppPaymentRequestHandler(pool);

        this.paymentIntentService =
            new PaymentIntentService(pool);

        this.multiCommandHandler =
            new MultiCommandHandler();
        this.addressUpdateHandler =
            new AddressUpdateHandler(pool);

        this.fulfillmentSelectionHandler =
            new FulfillmentSelectionHandler(pool);

        this.pickupPaymentSelectionHandler =
            new PickupPaymentSelectionHandler(pool);

        this.deliveryPaymentSelectionHandler =
            new DeliveryPaymentSelectionHandler(pool);
        this.emptyMessageHandler =
            new EmptyMessageHandler();
        this.fallbackHandler =
            new FallbackHandler();

        /*
         * Conversation AI hanya menjadi lapisan
         * pemahaman tambahan.
         *
         * Feature flag tetap menentukan apakah
         * provider boleh dipanggil.
         */
        this.conversationAI =
            new PasarPintarGeminiConversationAI();

        this.aiUnderstandingAdapter =
            new PasarPintarAIUnderstandingAdapter();

        this.aiOperationExecutor =
            new PasarPintarAIOperationExecutor(
                pool
            );

        this.aiResponseBuilder =
            new PasarPintarAIResponseBuilder();
        this.semanticCatalogService =
            new PasarPintarSemanticCatalogService(
                pool
            );
    }


    parseContextualQuantity(text) {
        const normalized =
            this.productContextResolver
                .normalizer
                .normalize(text)
                .trim()
                .toLowerCase();

        const value = normalized
            .replace(
                /\s+(?:aa|a|akang|kang|teteh|teh|kak|pak|bu)[?!.]*$/i,
                ''
            )
            .trim();

        const words = {
            satu: 1,
            dua: 2,
            tiga: 3,
            empat: 4,
            lima: 5,
            enam: 6,
            tujuh: 7,
            delapan: 8,
            sembilan: 9,
            sepuluh: 10
        };

        /*
         * Bare conversational quantity:
         *   "2 aja"
         *   "dua aja"
         *   "satu aja kak"
         *
         * Kata "nomor/no" sengaja tidak diterima.
         */
        let match =
            value.match(
                /^(\d{1,3}|satu|dua|tiga|empat|lima|enam|tujuh|delapan|sembilan|sepuluh)(?:\s+(?:pcs?|buah|bungkus|pack))?(?:\s+(?:aja|saja|deh|dong|ya))*[?!.]*$/i
            );

        if (!match) {
            /*
             * Explicit buy quantity:
             *   "beli dua"
             *   "beli 2 aja"
             *
             * Ini dibedakan kemudian oleh arbitration:
             * focused product dapat mengalahkan draft lama.
             */
            match =
                value.match(
                    /^(?:beli|pesan|order)\s+(\d{1,3}|satu|dua|tiga|empat|lima|enam|tujuh|delapan|sembilan|sepuluh)(?:\s+(?:pcs?|buah|bungkus|pack))?(?:\s+(?:aja|saja|deh|dong|ya))*[?!.]*$/i
                );
        }

        if (!match) {
            return null;
        }

        const raw =
            String(match[1]).toLowerCase();

        const quantity =
            Object.prototype
                .hasOwnProperty.call(words, raw)
                ? words[raw]
                : Number(raw);

        return (
            Number.isInteger(quantity) &&
            quantity >= 1 &&
            quantity <= 100
        )
            ? quantity
            : null;
    }

    async handle({
        text,
        messageId,
        customer
    }) {
        let classifiedIntent =
            this.intentClassifier.classify(text);

        let contextualProductImageResult = null;
        let contextualProductDirectResult = null;
        let inheritedProductAlternatives = [];

        /*
         * Contextual quantity correction.
         *
         * Kalimat seperti "jadi 3 aja" secara lexical
         * terlihat seperti PRODUCT_ORDER karena pola
         * <teks> <angka>.
         *
         * Jika Customer memang mempunyai pending draft,
         * izinkan Conversation AI memahami kalimat
         * koreksi tersebut sebagai SET_QUANTITY.
         *
         * Tidak mengeksekusi mutation di sini.
         * Canonical quantity service tetap menjadi
         * authority untuk harga, stok, dan draft.
         */
        if (
            classifiedIntent.intent ===
                'PRODUCT_ORDER' &&
            customer?.customer_id &&
            /^(?:(?:eh|oh)\s+)?(?:(?:jadi|ubah\s+jadi|ganti\s+jadi)\s+\d{1,3}(?:\s+(?:pcs?|buah|bungkus|pack))?|\d{1,3}\s+(?:pcs?|buah|bungkus|pack))(?:\s+(?:aja|saja|ya|deh|dong))*[?!.]*$/i
                .test(String(text || '').trim())
        ) {
            const pendingQuantityDraft =
                await this.orderDraftStore
                    .getPending(
                        customer.customer_id
                    );

            if (pendingQuantityDraft) {
                classifiedIntent = {
                    intent: 'UNKNOWN',
                    confidence: 0,
                    contextual: true,
                    quantityCorrectionCandidate:
                        true
                };
            }
        }

        /*
         * Contextual product-image arbitration.
         *
         * "boleh lihat fotonya"
         * "ningal fotona a"
         *
         * Prioritas:
         * 1. focused single PRODUCT_REFERENCE yang lebih baru
         *    daripada pending draft;
         * 2. pending draft;
         * 3. focused single PRODUCT_REFERENCE jika draft tidak ada.
         *
         * List/reference lama tidak boleh membajak "fotonya".
         */
        if (
            customer?.customer_id &&
            !contextualProductImageResult &&
            !contextualProductDirectResult
        ) {
            const normalizedImageFollowup =
                this.productContextResolver
                    .normalizer
                    .normalize(text)
                    .trim()
                    .toLowerCase()
                    .replace(
                        /\s+(?:aa|a|akang|kang|teteh|teh|kak|pak|bu)[?!.]*$/i,
                        ''
                    )
                    .trim();

            const imageFollowup =
                /^(?:(?:boleh|mau|pengen|ingin)\s+)?(?:lihat|liat)\s+(?:foto|fotonya|gambar|gambarnya)(?:\s+(?:aja|dong|ya))?$/i
                    .test(normalizedImageFollowup) ||
                /^(?:foto|fotonya|gambar|gambarnya)(?:\s+(?:aja|dong|ya))?$/i
                    .test(normalizedImageFollowup);

            if (imageFollowup) {
                const pendingImageDraft =
                    await this.orderDraftStore
                        .getPending(
                            customer.customer_id
                        );

                const focusedImageContext =
                    await this.productContextStore
                        .getActive(
                            customer.customer_id
                        );

                const focusedProducts =
                    focusedImageContext
                        ?.context_type ===
                        'PRODUCT_REFERENCE' &&
                    Array.isArray(
                        focusedImageContext
                            ?.context_payload
                            ?.products
                    )
                        ? focusedImageContext
                            .context_payload
                            .products
                        : [];

                const focusedProduct =
                    focusedProducts.length === 1
                        ? focusedProducts[0]
                        : null;

                let imageProductId =
                    pendingImageDraft
                        ?.product_id ||
                    null;

                if (focusedProduct?.id) {
                    const focusedTime =
                        new Date(
                            focusedImageContext
                                .created_at || 0
                        ).getTime();

                    const draftTime =
                        new Date(
                            pendingImageDraft
                                ?.created_at || 0
                        ).getTime();

                    if (
                        !pendingImageDraft ||
                        (
                            Number.isFinite(
                                focusedTime
                            ) &&
                            Number.isFinite(
                                draftTime
                            ) &&
                            focusedTime >
                                draftTime
                        )
                    ) {
                        imageProductId =
                            focusedProduct.id;
                    }
                }

                if (imageProductId) {
                    contextualProductImageResult =
                        await this.productImageHandler
                            .handleSelectedProduct({
                                productId:
                                    imageProductId
                            });

                    classifiedIntent = {
                        intent: 'PRODUCT_IMAGE',
                        confidence: 0.99,
                        contextual: true,
                        contextArbitrated: true
                    };
                }
            }
        }

        /*
         * Pending-draft quantity arbitration.
         *
         * Bare quantity seperti:
         *   "2 aja"
         *   "dua aja"
         *   "hiji we"
         *
         * berarti koreksi jumlah ketika draft aktif ada.
         *
         * Explicit buy seperti "beli dua" TIDAK masuk
         * blok ini karena mungkin merujuk focused product
         * yang berbeda dari draft lama.
         *
         * "nomor 2" juga tidak pernah masuk parser ini.
         */
        if (
            customer?.customer_id &&
            !contextualProductDirectResult
        ) {
            const normalizedDraftFollowup =
                this.productContextResolver
                    .normalizer
                    .normalize(text)
                    .trim()
                    .toLowerCase();

            const explicitBuyQuantity =
                /^(?:beli|pesan|order)\b/i
                    .test(
                        normalizedDraftFollowup
                    );

            const contextualQuantity =
                this.parseContextualQuantity(
                    text
                );

            let reservedForImageSelection = false;

            if (
                contextualQuantity !== null &&
                !explicitBuyQuantity
            ) {
                const activeSelectionContext =
                    await this.productContextStore
                        .getActive(
                            customer.customer_id
                        );

                if (
                    activeSelectionContext &&
                    (
                        activeSelectionContext
                            .context_type ===
                            'PRODUCT_IMAGE_SELECTION' ||
                        activeSelectionContext
                            .context_type ===
                            'PRODUCT_MULTI_IMAGE_SELECTION'
                    )
                ) {
                    const selectionProducts =
                        activeSelectionContext
                            .context_payload
                            ?.products || [];

                    reservedForImageSelection =
                        Boolean(
                            this.productImageHandler
                                .resolveSelection(
                                    text,
                                    selectionProducts
                                )
                        );
                }
            }

            if (
                contextualQuantity !== null &&
                !explicitBuyQuantity &&
                !reservedForImageSelection
            ) {
                const pendingDraft =
                    await this.orderDraftStore
                        .getPending(
                            customer.customer_id
                        );

                if (pendingDraft) {
                    contextualProductDirectResult =
                        await this
                            .orderDraftQuantityService
                            .update({
                                customerId:
                                    customer.customer_id,
                                quantity:
                                    contextualQuantity
                            });

                    classifiedIntent = {
                        intent: 'PRODUCT_ORDER',
                        confidence: 0.99,
                        contextual: true,
                        draftQuantityCorrection:
                            true
                    };
                }
            }
        }

        if (
            customer?.customer_id &&
            !contextualProductDirectResult &&
            !contextualProductImageResult
        ) {
            const activeProductContext =
                await this.productContextStore
                    .getActive(customer.customer_id);

            if (
                activeProductContext?.context_type ===
                    'PRODUCT_MULTI_IMAGE_SELECTION'
            ) {
                const contextProducts =
                    activeProductContext
                        .context_payload
                        ?.products || [];

                const resolvedProducts =
                    activeProductContext
                        .context_payload
                        ?.resolvedProducts || [];

                const selectedProduct =
                    this.productImageHandler
                        .resolveSelection(
                            text,
                            contextProducts
                        );

                if (selectedProduct) {
                    const finalProducts = [
                        ...resolvedProducts,
                        selectedProduct
                    ];

                    const mediaItems = [];

                    for (const product of finalProducts) {
                        const result =
                            await this.productImageHandler
                                .handleSelectedProduct({
                                    productId:
                                        product.id
                                });

                        if (
                            result.status === 'found' &&
                            result.media
                        ) {
                            mediaItems.push({
                                productId:
                                    product.id,
                                name:
                                    product.name,
                                media:
                                    result.media,
                                responseText:
                                    result.responseText
                            });
                        }
                    }

                    if (
                        mediaItems.length ===
                        finalProducts.length
                    ) {
                        contextualProductImageResult = {
                            status:
                                'multi_product_ready',
                            products:
                                finalProducts,
                            mediaItems,
                            responseText:
                                'Oke, ini fotonya ya.'
                        };

                        classifiedIntent = {
                            intent: 'PRODUCT_IMAGE',
                            confidence: 0.99,
                            contextual: true
                        };

                        await this.productContextStore
                            .clear(
                                customer.customer_id
                            );
                    }
                }
            } else if (
                activeProductContext?.context_type ===
                    'PRODUCT_IMAGE_SELECTION'
            ) {
                const contextProducts =
                    activeProductContext
                        .context_payload
                        ?.products || [];

                const selectedProduct =
                    this.productImageHandler
                        .resolveSelection(
                            text,
                            contextProducts
                        );

                if (selectedProduct) {
                    contextualProductImageResult =
                        await this.productImageHandler
                            .handleSelectedProduct({
                                productId:
                                    selectedProduct.id
                            });

                    if (
                        contextualProductImageResult
                            .status === 'found'
                    ) {
                        classifiedIntent = {
                            intent: 'PRODUCT_IMAGE',
                            confidence: 0.99,
                            contextual: true
                        };

                        await this.productContextStore
                            .clear(
                                customer.customer_id
                            );
                    }
                }
            } else if (
                activeProductContext?.context_type ===
                    'DRAFT_PRODUCT_ALTERNATIVES'
            ) {
                const contextProducts =
                    activeProductContext
                        .context_payload
                        ?.products || [];

                let replacementProducts =
                    contextProducts;

                /*
                 * Variant replacement is family-aware.
                 *
                 * Size language such as "yang 500gr"
                 * stays inside the product family already
                 * present in the pending draft.
                 *
                 * Explicit list numbers still address
                 * the complete alternatives list.
                 */
                const explicitListSelection =
                    /^(?:yang\s+)?(?:nomor\s+|no\.?\s*)?(?:pertama|kedua|ketiga|keempat|satu|dua|tiga|empat|\d{1,2})(?:\s+(?:aja|saja|deh|dong|ya))?[?!.]*$/i
                        .test(
                            String(text || '')
                                .trim()
                        );

                if (!explicitListSelection) {
                    const pendingDraft =
                        await this.orderDraftStore
                            .getPending(
                                customer.customer_id
                            );

                    const familyName = value =>
                        String(value || '')
                            .toLowerCase()
                            .replace(
                                /\b\d+(?:[.,]\d+)?\s*(?:kg|kilogram|gr|g|gram|grams|ml|l|liter)\b/gi,
                                ''
                            )
                            .replace(
                                /\s+/g,
                                ' '
                            )
                            .trim();

                    const currentFamily =
                        familyName(
                            pendingDraft
                                ?.product_name
                        );

                    if (currentFamily) {
                        const familyProducts =
                            contextProducts.filter(
                                product =>
                                    familyName(
                                        product?.name
                                    ) ===
                                    currentFamily
                            );

                        if (
                            familyProducts.length >= 2
                        ) {
                            replacementProducts =
                                familyProducts;
                        }
                    }
                }

                const contextualResolution =
                    this.productContextResolver
                        .resolve(
                            text,
                            replacementProducts
                        );

                if (
                    contextualResolution?.action ===
                        'SELECT' &&
                    contextualResolution.product?.id
                ) {
                    const replacementResult =
                        await this
                            .orderDraftProductReplacementService
                            .replace({
                                customerId:
                                    customer.customer_id,
                                productId:
                                    contextualResolution
                                        .product.id
                            });

                    contextualProductDirectResult =
                        replacementResult;

                    classifiedIntent = {
                        intent: 'PRODUCT_ORDER',
                        confidence: 0.99,
                        contextual: true,
                        draftProductReplacement:
                            true
                    };
                }
            } else if (
                activeProductContext?.context_type ===
                    'PRODUCT_ORDER_SELECTION'
            ) {
                const contextProducts =
                    activeProductContext
                        .context_payload
                        ?.products || [];

                const quantity =
                    Number(
                        activeProductContext
                            .context_payload
                            ?.quantity || 1
                    );

                const contextualResolution =
                    this.productContextResolver
                        .resolve(
                            text,
                            contextProducts
                        );

                if (
                    contextualResolution?.action ===
                        'SELECT' &&
                    contextualResolution.product?.id
                ) {
                    const selectedResult =
                        await this.productOrderDraftHandler
                            .handleSelectedProduct({
                                productId:
                                    contextualResolution
                                        .product.id,
                                quantity
                            });

                    if (
                        selectedResult.status ===
                            'draft_ready' &&
                        selectedResult.draft
                    ) {
                        const storedDraft =
                            await this.orderDraftStore
                                .createOrReplace({
                                    customerId:
                                        customer.customer_id,
                                    draft:
                                        selectedResult.draft,
                                    sourceMessageId:
                                        messageId || null
                                });

                        selectedResult.draftStorageStatus =
                            storedDraft.status;

                        selectedResult.draftId =
                            storedDraft.draft?.id || null;

                        contextualProductDirectResult =
                            selectedResult;

                        classifiedIntent = {
                            intent: 'PRODUCT_ORDER',
                            confidence: 0.99,
                            contextual: true
                        };

                        if (
                            Array.isArray(contextProducts) &&
                            contextProducts.length > 1
                        ) {
                            await this.productContextStore
                                .saveDraftAlternativesContext({
                                    customerId:
                                        customer.customer_id,
                                    products:
                                        contextProducts,
                                    sourceMessageId:
                                        messageId || null
                                });
                        } else {
                            await this.productContextStore
                                .clear(
                                    customer.customer_id
                                );
                        }
                    } else if (
                        selectedResult.status ===
                            'product_not_found' ||
                        selectedResult.status ===
                            'insufficient_stock' ||
                        selectedResult.status ===
                            'invalid_quantity'
                    ) {
                        contextualProductDirectResult =
                            selectedResult;

                        classifiedIntent = {
                            intent: 'PRODUCT_ORDER',
                            confidence: 0.99,
                            contextual: true
                        };

                        await this.productContextStore
                            .clear(
                                customer.customer_id
                            );
                    }
                }
            } else if (
                activeProductContext?.context_type ===
                    'PRODUCT_REFERENCE' &&
                Array.isArray(
                    activeProductContext
                        .context_payload
                        ?.products
                ) &&
                activeProductContext
                    .context_payload
                    .products.length === 1 &&
                (
                    (
                        /\b(?:beli|pesan|order)\b/i
                            .test(
                                String(text || '')
                            ) &&
                        /\b(?:(?:yang|yg)\s+)?(?:itu|tadi|tersebut)\b/i
                            .test(
                                String(text || '')
                            )
                    ) ||
                    (
                        /^(?:beli|pesan|order)\b/i
                            .test(
                                this.productContextResolver
                                    .normalizer
                                    .normalize(text)
                                    .trim()
                            ) &&
                        this.parseContextualQuantity(
                            text
                        ) !== null
                    )
                )
            ) {
                const referencedProduct =
                    activeProductContext
                        .context_payload
                        .products[0];

                const parsedOrder =
                    this.productOrderDraftHandler
                        .parseOrderRequest(text);

                const contextualOrderQuantity =
                    this.parseContextualQuantity(
                        text
                    );

                const selectedResult =
                    await this.productOrderDraftHandler
                        .handleSelectedProduct({
                            productId:
                                referencedProduct.id,
                            quantity:
                                contextualOrderQuantity ||
                                parsedOrder.quantity ||
                                1
                        });

                if (
                    selectedResult.status ===
                        'draft_ready' &&
                    selectedResult.draft
                ) {
                    const storedDraft =
                        await this.orderDraftStore
                            .createOrReplace({
                                customerId:
                                    customer.customer_id,
                                draft:
                                    selectedResult.draft,
                                sourceMessageId:
                                    messageId || null
                            });

                    selectedResult.draftStorageStatus =
                        storedDraft.status;

                    selectedResult.draftId =
                        storedDraft.draft?.id || null;

                    contextualProductDirectResult =
                        selectedResult;

                    classifiedIntent = {
                        intent: 'PRODUCT_ORDER',
                        confidence: 0.99,
                        contextual: true
                    };

                    const referenceAlternatives =
                        activeProductContext
                            .context_payload
                            ?.alternatives || [];

                    if (
                        Array.isArray(
                            referenceAlternatives
                        ) &&
                        referenceAlternatives.length > 1
                    ) {
                        await this.productContextStore
                            .saveDraftAlternativesContext({
                                customerId:
                                    customer.customer_id,
                                products:
                                    referenceAlternatives,
                                sourceMessageId:
                                    messageId || null
                            });
                    } else {
                        await this.productContextStore
                            .clear(
                                customer.customer_id
                            );
                    }
                } else if (
                    selectedResult.status ===
                        'product_not_found' ||
                    selectedResult.status ===
                        'insufficient_stock' ||
                    selectedResult.status ===
                        'invalid_quantity'
                ) {
                    contextualProductDirectResult =
                        selectedResult;

                    classifiedIntent = {
                        intent: 'PRODUCT_ORDER',
                        confidence: 0.99,
                        contextual: true
                    };

                    await this.productContextStore
                        .clear(
                            customer.customer_id
                        );
                }
            } else if (
                activeProductContext?.context_type ===
                    'PRODUCT_REFERENCE'
            ) {
                const contextProducts =
                    activeProductContext
                        .context_payload
                        ?.products || [];

                const contextualResolution =
                    this.productContextResolver
                        .resolve(
                            text,
                            contextProducts
                        );

                if (
                    contextualResolution?.action ===
                        'SELECT' &&
                    contextualResolution.product?.name
                ) {
                    inheritedProductAlternatives =
                        Array.isArray(
                            activeProductContext
                                .context_payload
                                ?.alternatives
                        ) &&
                        activeProductContext
                            .context_payload
                            .alternatives.length > 1
                            ? activeProductContext
                                .context_payload
                                .alternatives
                            : (
                                contextProducts.length > 1
                                    ? contextProducts
                                    : []
                            );

                    text =
                        contextualResolution.product.name;

                    classifiedIntent = {
                        intent: 'PRODUCT_INQUIRY',
                        confidence: 0.99,
                        contextual: true
                    };
                } else if (
                    contextualResolution?.action ===
                        'INQUIRY' &&
                    contextualResolution.product?.name
                ) {
                    inheritedProductAlternatives =
                        Array.isArray(
                            activeProductContext
                                .context_payload
                                ?.alternatives
                        ) &&
                        activeProductContext
                            .context_payload
                            .alternatives.length > 1
                            ? activeProductContext
                                .context_payload
                                .alternatives
                            : (
                                contextProducts.length > 1
                                    ? contextProducts
                                    : []
                            );

                    text =
                        contextualResolution.product.name;

                    classifiedIntent = {
                        intent: 'PRODUCT_INQUIRY',
                        confidence: 0.99,
                        contextual: true
                    };
                } else if (
                    contextualResolution?.action ===
                        'IMAGE' &&
                    contextualResolution.product?.id
                ) {
                    contextualProductImageResult =
                        await this.productImageHandler
                            .handleSelectedProduct({
                                productId:
                                    contextualResolution
                                        .product.id
                            });

                    if (
                        contextualProductImageResult
                            .status === 'found'
                    ) {
                        classifiedIntent = {
                            intent: 'PRODUCT_IMAGE',
                            confidence: 0.99,
                            contextual: true
                        };
                    }
                } else if (
                    contextualResolution?.action ===
                        'AMBIGUOUS_INQUIRY' ||
                    contextualResolution?.action ===
                        'AMBIGUOUS_IMAGE'
                ) {
                    const names =
                        contextProducts.map(
                            (product, index) =>
                                `${index + 1}. ${product.name}`
                        );

                    classifiedIntent = {
                        intent:
                            contextualResolution.action ===
                                'AMBIGUOUS_IMAGE'
                                ? 'PRODUCT_IMAGE'
                                : 'PRODUCT_INQUIRY',
                        confidence: 0.99,
                        contextual: true
                    };

                    contextualProductDirectResult = {
                        status:
                            'need_product_selection',
                        responseText:
                            'Yang mana ya?\n\n' +
                            names.join('\n')
                    };
                }
            }
        }

        /*
         * =========================================================
         * CONTEXTUAL DELIVERY / PICKUP ONLINE PAYMENT SELECTION
         * =========================================================
         *
         * Teks "bayar online" / "online" / "qris" secara lexical
         * diklasifikasikan sebagai PICKUP_PAYMENT_ONLINE.
         *
         * Tetapi ketika draft aktif sudah explicit DELIVERY,
         * intent tersebut harus diperlakukan sebagai pilihan
         * pembayaran DELIVERY.
         *
         * PICKUP tetap memakai PickupPaymentSelectionHandler.
         *
         * Command "bayar" tidak masuk blok ini dan tetap memakai
         * canonical PAYMENT_REQUEST_HANDLER setelah Order dibuat.
         * =========================================================
         */
        if (
            classifiedIntent.intent ===
                'PICKUP_PAYMENT_ONLINE' &&
            customer?.customer_id
        ) {
            const pendingPaymentDraft =
                await this.orderDraftStore
                    .getPending(
                        customer.customer_id
                    );

            if (
                pendingPaymentDraft &&
                pendingPaymentDraft
                    .fulfillment_selection_explicit ===
                    true &&
                String(
                    pendingPaymentDraft
                        .fulfillment_type ||
                    ''
                )
                    .trim()
                    .toUpperCase() ===
                    'DELIVERY'
            ) {
                classifiedIntent = {
                    ...classifiedIntent,
                    intent:
                        'DELIVERY_PAYMENT_ONLINE'
                };
            }
        }

        /*
         * Contextual address completion.
         *
         * Hanya UNKNOWN yang boleh dipromosikan menjadi ADDRESS_UPDATE,
         * dan hanya ketika Customer memiliki draft aktif tanpa alamat.
         * Intent eksplisit lain tidak pernah ditimpa.
         */
        if (
            classifiedIntent.intent ===
                'UNKNOWN' &&
            customer?.customer_id
        ) {
            const pendingDraft =
                await this.orderDraftStore.getPending(
                    customer.customer_id
                );

            const value =
                String(text || '').trim();

            const looksLikeAddress =
                value.length >= 5 &&
                (
                    /\b(jl\.?|jalan|gg\.?|gang|komplek|perumahan|kampung|kp\.?|desa|kelurahan|kecamatan|kec\.?|rt\.?|rw\.?|blok)\b/i.test(value) ||
                    /\b(no\.?|nomor)\s*\d+/i.test(value) ||
                    /\d+[a-z]?\s*$/i.test(value)
                );

            if (
                pendingDraft &&
                !String(
                    pendingDraft.shipping_address || ''
                ).trim() &&
                looksLikeAddress
            ) {
                classifiedIntent = {
                    intent:
                        'ADDRESS_UPDATE',
                    confidence:
                        0.9,
                    contextual:
                        true
                };
            }
        }

        /*
         * =========================================================
         * PASAR PINTAR CONVERSATION AI — SAFE READ-ONLY FALLBACK
         * =========================================================
         *
         * AI hanya diberi kesempatan apabila seluruh classifier
         * dan contextual resolver deterministic masih UNKNOWN.
         *
         * Tahap integrasi pertama HANYA mengizinkan intent baca:
         * - PRODUCT_INQUIRY
         * - PRODUCT_IMAGE
         * - ORDER_STATUS
         *
         * Tidak ada confirm/cancel/payment/fulfillment/address/
         * draft mutation yang boleh dipromosikan melalui blok ini.
         * =========================================================
         */
        const semanticCatalogEscalation =
            classifiedIntent.intent ===
                'PRODUCT_INQUIRY' &&
            (
                /\b(?:murah|termurah|mahal|termahal|rekomendasi|recommend|budget|anggaran)\b/i
                    .test(String(text || '')) ||
                /\b(?:di\s+bawah|dibawah|kurang\s+dari|maks(?:imal)?|max)\s+(?:rp\s*)?\d+/i
                    .test(String(text || '')) ||
                /\b(?:di\s+atas|diatas|lebih\s+dari|min(?:imal)?)\s+(?:rp\s*)?\d+/i
                    .test(String(text || '')) ||
                /\b(?:antara|kisaran|sekitar)\s+(?:rp\s*)?\d+/i
                    .test(String(text || '')) ||
                /\b\d+\s*(?:ribu|rb|k)\b/i
                    .test(String(text || ''))
            );

        if (
            (
                classifiedIntent.intent ===
                    'UNKNOWN' ||
                semanticCatalogEscalation
            ) &&
            this.conversationAI.isReady()
        ) {
            try {
                let aiProductContext = null;
                let aiDraftContext = null;

                if (customer?.customer_id) {
                    const activeContext =
                        await this.productContextStore
                            .getActive(
                                customer.customer_id
                            );

                    if (activeContext) {
                        aiProductContext = {
                            type:
                                activeContext
                                    .context_type,
                            products:
                                (
                                    activeContext
                                        .context_payload
                                        ?.products ||
                                    []
                                )
                                    .slice(0, 10)
                                    .map(product => ({
                                        id:
                                            product.id ||
                                            null,
                                        name:
                                            product.name ||
                                            null
                                    }))
                        };
                    }

                    const pendingDraft =
                        await this.orderDraftStore
                            .getPending(
                                customer.customer_id
                            );

                    if (pendingDraft) {
                        aiDraftContext = {
                            productName:
                                pendingDraft
                                    .product_name ||
                                null,
                            quantity:
                                Number(
                                    pendingDraft
                                        .quantity ||
                                    0
                                ) || null,
                            fulfillment:
                                pendingDraft
                                    .fulfillment_type ||
                                null,
                            fulfillmentExplicit:
                                pendingDraft
                                    .fulfillment_selection_explicit ===
                                    true,
                            pickupPayment:
                                pendingDraft
                                    .pickup_payment ||
                                null,
                            deliveryPayment:
                                pendingDraft
                                    .delivery_payment ||
                                null
                        };
                    }
                }

                const aiResult =
                    await this.conversationAI
                        .understand({
                            text,
                            context: {
                                productContext:
                                    aiProductContext,
                                pendingDraft:
                                    aiDraftContext
                            }
                        });

                if (
                    aiResult.status ===
                        'understood' &&
                    aiResult.understanding
                ) {
                    const adapted =
                        this.aiUnderstandingAdapter
                            .adapt(
                                aiResult
                                    .understanding
                            );

                    const safeReadOnlyIntents =
                        new Set([
                            'PRODUCT_INQUIRY',
                            'PRODUCT_IMAGE',
                            'ORDER_STATUS'
                        ]);

                    if (
                        adapted.status ===
                            'adapted' &&
                        Array.isArray(
                            adapted.operations
                        )
                    ) {
                        const operations =
                            adapted.operations;

                        const readOnly =
                            operations.length === 1 &&
                            operations[0]
                                ?.type ===
                                'LEGACY_INTENT' &&
                            safeReadOnlyIntents.has(
                                operations[0]
                                    .intent
                            );

                        if (readOnly) {
                            if (
                                adapted.catalogRequest &&
                                operations[0]
                                    .intent ===
                                    'PRODUCT_INQUIRY'
                            ) {
                                const catalogResult =
                                    await this
                                        .semanticCatalogService
                                        .search(
                                            adapted
                                                .catalogRequest
                                        );

                                if (
                                    catalogResult?.status ===
                                        'semantic_catalog' &&
                                    Array.isArray(
                                        catalogResult.products
                                    ) &&
                                    catalogResult.products
                                        .length > 0 &&
                                    customer?.customer_id
                                ) {
                                    await this
                                        .productContextStore
                                        .saveReferenceContext({
                                            customerId:
                                                customer
                                                    .customer_id,
                                            products:
                                                catalogResult
                                                    .products,
                                            sourceMessageId:
                                                messageId
                                        });
                                }

                                classifiedIntent = {
                                    intent:
                                        'AI_SEMANTIC_CATALOG',
                                    confidence:
                                        adapted.confidence,
                                    aiAssisted:
                                        true,
                                    aiModel:
                                        aiResult.model ||
                                        null,
                                    aiCatalogResult:
                                        catalogResult
                                };
                            } else {
                                classifiedIntent = {
                                    intent:
                                        operations[0]
                                            .intent,
                                    confidence:
                                        adapted.confidence,
                                    aiAssisted:
                                        true,
                                    aiModel:
                                        aiResult.model ||
                                        null
                                };
                            }
                        } else {
                            /*
                             * Seluruh operation list harus
                             * lolos allowlist SEBELUM
                             * executor dipanggil.
                             *
                             * Jangan pernah mengeksekusi
                             * subset dari maksud customer.
                             */
                            const safeMutationTypes =
                                new Set([
                                    'SELECT_PRODUCT',
                                    'SELECT_VARIANT',
                                    'SET_QUANTITY',
                                    'SET_FULFILLMENT',
                                    'SET_PAYMENT'
                                ]);

                            const mutationPlanAllowed =
                                operations.length > 0 &&
                                operations.every(
                                    operation =>
                                        operation
                                            ?.mutating ===
                                            true &&
                                        safeMutationTypes
                                            .has(
                                                operation
                                                    .type
                                            )
                                );

                            if (
                                mutationPlanAllowed &&
                                customer
                                    ?.customer_id
                            ) {
                                const execution =
                                    await this
                                        .aiOperationExecutor
                                        .execute({
                                            operations,
                                            customer,
                                            messageId
                                        });

                                /*
                                 * Tahap ini belum mengambil
                                 * alih response WhatsApp.
                                 * Hasil disimpan sebagai
                                 * classified metadata dulu.
                                 *
                                 * Response integration akan
                                 * diuji terpisah agar tidak
                                 * menciptakan silent reply.
                                 */
                                if (
                                    execution.status ===
                                        'executed'
                                ) {
                                    classifiedIntent = {
                                        intent:
                                            'AI_OPERATION',
                                        confidence:
                                            adapted
                                                .confidence,
                                        aiAssisted:
                                            true,
                                        aiModel:
                                            aiResult
                                                .model ||
                                            null,
                                        aiExecution:
                                            execution
                                    };
                                }
                            }
                        }
                    }
                }
            } catch (err) {
                /*
                 * Fail closed.
                 *
                 * AI tidak pernah boleh membuat
                 * inbound WhatsApp gagal.
                 * UNKNOWN akan diteruskan ke
                 * fallback deterministic lama.
                 */
                console.error(
                    '[PASAR PINTAR CONVERSATION AI]',
                    err.message
                );
            }
        }

        const routedIntent =
            this.intentRouter.route({
                intent:
                    classifiedIntent.intent,
                text,
                customer
            });

        const aiOperationDirectResult =
            classifiedIntent.intent ===
                'AI_OPERATION'
                ? this.aiResponseBuilder.build(
                    classifiedIntent.aiExecution
                )
                : null;

        const aiSemanticCatalogDirectResult =
            classifiedIntent.intent ===
                'AI_SEMANTIC_CATALOG'
                ? classifiedIntent
                    .aiCatalogResult
                : null;

        let handlerResult = null;

        if (aiSemanticCatalogDirectResult) {
            handlerResult =
                aiSemanticCatalogDirectResult;
        } else if (aiOperationDirectResult) {
            handlerResult =
                aiOperationDirectResult;
        } else if (contextualProductDirectResult) {
            handlerResult =
                contextualProductDirectResult;
        } else if (
            routedIntent.handler ===
            'MULTI_COMMAND_HANDLER'
        ) {
            handlerResult =
                this.multiCommandHandler.handle();

        } else if (
            routedIntent.handler ===
            'FULFILLMENT_SELECTION_HANDLER'
        ) {
            handlerResult =
                await this.fulfillmentSelectionHandler.handle({
                    customer,
                    action:
                        routedIntent.action
                });

        } else if (
            routedIntent.handler ===
            'PICKUP_PAYMENT_SELECTION_HANDLER'
        ) {
            handlerResult =
                await this.pickupPaymentSelectionHandler.handle({
                    customer,
                    action:
                        routedIntent.action
                });

        } else if (
            routedIntent.handler ===
                'DELIVERY_PAYMENT_SELECTION_HANDLER'
        ) {
            handlerResult =
                await this.deliveryPaymentSelectionHandler
                    .handle({
                        customer,
                        action:
                            routedIntent.action
                    });

        } else if (
            routedIntent.handler ===
            'ADDRESS_UPDATE_HANDLER'
        ) {
            handlerResult =
                await this.addressUpdateHandler.handle({
                    text,
                    customer
                });

        } else if (
            routedIntent.handler ===
            'EMPTY_MESSAGE_HANDLER'
        ) {
            handlerResult =
                this.emptyMessageHandler.handle();

        } else if (
            routedIntent.handler ===
            'FALLBACK_HANDLER'
        ) {
            handlerResult =
                this.fallbackHandler.handle();

        } else if (
            routedIntent.handler ===
            'PRODUCT_INQUIRY_HANDLER'
        ) {
            handlerResult =
                await this.productInquiryHandler.handle({
                    text
                });

            if (
                handlerResult.status === 'found' &&
                Array.isArray(handlerResult.products) &&
                handlerResult.products.length > 0 &&
                customer?.customer_id
            ) {
                const storedContext =
                    await this.productContextStore
                        .saveReferenceContext({
                            customerId:
                                customer.customer_id,
                            products:
                                handlerResult.products.map(
                                    product => ({
                                        id:
                                            product.id,
                                        name:
                                            product.name
                                    })
                                ),
                            alternatives:
                                inheritedProductAlternatives,
                            sourceMessageId:
                                messageId || null
                        });

                handlerResult.contextStorageStatus =
                    storedContext.status;
            }

        } else if (
            routedIntent.handler ===
            'PRODUCT_IMAGE_HANDLER'
        ) {
            handlerResult =
                contextualProductImageResult ||
                await this.productImageHandler
                    .handleMultiRequest({
                        text
                    }) ||
                await this.productImageHandler.handle({
                    text
                });

            if (
                handlerResult.status ===
                    'multi_product_need_selection' &&
                customer?.customer_id
            ) {
                const storedContext =
                    await this.productContextStore
                        .saveMultiImageSelectionContext({
                            customerId:
                                customer.customer_id,
                            products:
                                handlerResult.products.map(
                                    product => ({
                                        id:
                                            product.id,
                                        name:
                                            product.name
                                    })
                                ),
                            resolvedProducts:
                                handlerResult.resolvedProducts,
                            sourceMessageId:
                                messageId || null
                        });

                handlerResult.contextStorageStatus =
                    storedContext.status;
            } else if (
                handlerResult.status ===
                    'multiple_products' &&
                customer?.customer_id
            ) {
                const storedContext =
                    await this.productContextStore
                        .saveSelectionContext({
                            customerId:
                                customer.customer_id,
                            products:
                                handlerResult.products.map(
                                    product => ({
                                        id:
                                            product.id,
                                        name:
                                            product.name
                                    })
                                ),
                            sourceMessageId:
                                messageId || null
                        });

                handlerResult.contextStorageStatus =
                    storedContext.status;
            }
        } else if (
            routedIntent.handler ===
            'GREETING_HANDLER'
        ) {
            handlerResult =
                this.greetingHandler.handle({
                    customer,
                    text
                });

        } else if (
            routedIntent.handler ===
            'ORDER_STATUS_HANDLER'
        ) {
            handlerResult =
                await this.orderStatusHandler.handle({
                    customer
                });

        } else if (
            routedIntent.handler ===
            'PRODUCT_ORDER_DRAFT_HANDLER'
        ) {
            handlerResult =
                await this.productOrderDraftHandler.handle({
                    text
                });

            if (
                handlerResult.status ===
                    'draft_ready' &&
                handlerResult.draft &&
                messageId
            ) {
                const storedDraft =
                    await this.orderDraftStore
                        .createOrReplace({
                            customerId:
                                customer.customer_id,
                            draft:
                                handlerResult.draft,
                            sourceMessageId:
                                messageId
                        });

                handlerResult.draftStorageStatus =
                    storedDraft.status;

                handlerResult.draftId =
                    storedDraft.draft?.id || null;
            }

            if (
                handlerResult.status ===
                    'multiple_products' &&
                Array.isArray(
                    handlerResult.products
                ) &&
                handlerResult.products.length > 0
            ) {
                const storedContext =
                    await this.productContextStore
                        .saveOrderSelectionContext({
                            customerId:
                                customer.customer_id,
                            products:
                                handlerResult.products,
                            quantity:
                                handlerResult.quantity,
                            sourceMessageId:
                                messageId || null
                        });

                handlerResult.contextStorageStatus =
                    storedContext.status;
            }

        } else if (
            routedIntent.handler ===
            'ORDER_CONFIRMATION_HANDLER'
        ) {
            handlerResult =
                await this.orderConfirmationHandler.handle({
                    customer
                });

            if (
                handlerResult.status ===
                'confirmation_ready'
            ) {
                const confirmed =
                    await this.orderConfirmationService
                        .confirm({
                            customerId:
                                customer.customer_id
                        });

                if (
                    confirmed.status ===
                        'confirmed' &&
                    confirmed.order
                ) {
                    const confirmedOrder =
                        confirmed.order;

                    const fulfillmentType =
                        String(
                            confirmedOrder.fulfillment_type ||
                            ''
                        )
                            .trim()
                            .toUpperCase();

                    const paymentSelection =
                        confirmedOrder.paymentSelection
                            ? String(
                                confirmedOrder.paymentSelection
                              )
                                .trim()
                                .toUpperCase()
                            : null;

                    const isPickupOnline =
                        fulfillmentType === 'PICKUP' &&
                        paymentSelection === 'ONLINE' &&
                        !confirmedOrder.payment;

                    const isDeliveryOnline =
                        fulfillmentType === 'DELIVERY' &&
                        paymentSelection === 'ONLINE' &&
                        !confirmedOrder.payment;

                    const shouldContinueOnlinePayment =
                        isPickupOnline ||
                        isDeliveryOnline;

                    let onlinePaymentResult =
                        null;

                    let onlinePaymentError =
                        null;

                    /*
                     * =================================================
                     * WHATSAPP PICKUP / DELIVERY + ONLINE CONTINUATION
                     *
                     * Order sudah COMMIT di ConfirmationService.
                     * Payment intent dibuat sesudahnya melalui canonical
                     * PaymentIntentService.
                     *
                     * Gateway failure TIDAK boleh rollback Order.
                     * Customer tetap dapat meminta "bayar" lagi.
                     * =================================================
                     */
                    if (shouldContinueOnlinePayment) {
                        try {
                            onlinePaymentResult =
                                await this.paymentIntentService
                                    .create({
                                        orderId:
                                            confirmedOrder.id,
                                        customerId:
                                            customer.customer_id,
                                        provider:
                                            'MIDTRANS',
                                        paymentMethod:
                                            'QRIS'
                                    });
                        } catch (err) {
                            onlinePaymentError =
                                err;

                            console.error(
                                '[WHATSAPP ONLINE PAYMENT CONTINUATION]',
                                err.message
                            );
                        }
                    }

                    const payment =
                        onlinePaymentResult?.payment ||
                        null;

                    const gateway =
                        payment?.gateway_response ||
                        {};

                    const qrCodeUrl =
                        gateway.qr_code_url ||
                        null;

                    const paymentReady =
                        Boolean(
                            payment &&
                            [
                                'created',
                                'existing',
                                'updated'
                            ].includes(
                                onlinePaymentResult?.status
                            )
                        );

                    let confirmationText =
                        'Pesanannya sudah dibuat kak ✅\n\n' +
                        `Nomor pesanan: ${confirmedOrder.id}\n` +
                        `Status: ${confirmedOrder.status}\n` +
                        `Total: Rp ${Number(
                            confirmedOrder.total_amount
                        ).toLocaleString('id-ID')}`;

                    if (
                        shouldContinueOnlinePayment &&
                        paymentReady
                    ) {
                        confirmationText +=
                            '\n\nPembayaran online sudah siap kak.';

                        if (qrCodeUrl) {
                            confirmationText +=
                                '\nQRIS:\n' +
                                qrCodeUrl;
                        } else {
                            confirmationText +=
                                '\nKalau mau lihat detail pembayarannya lagi, balas "bayar" ya kak.';
                        }
                    } else if (
                        shouldContinueOnlinePayment &&
                        (
                            onlinePaymentResult?.status ===
                                'expired' ||
                            onlinePaymentError
                        )
                    ) {
                        confirmationText +=
                            '\n\nPesanannya sudah tersimpan, tapi QRIS belum bisa dibuat sekarang kak.' +
                            '\nBalas "bayar" untuk coba lagi ya kak.';
                    } else if (
                        shouldContinueOnlinePayment &&
                        onlinePaymentResult &&
                        !paymentReady
                    ) {
                        confirmationText +=
                            '\n\nPesanannya sudah tersimpan kak.' +
                            '\nBalas "bayar" untuk lanjut pembayaran ya kak.';
                    }

                    handlerResult = {
                        status:
                            'confirmed',

                        orderId:
                            confirmedOrder.id,

                        paymentContinuation:
                            shouldContinueOnlinePayment
                                ? {
                                    status:
                                        onlinePaymentResult?.status ||
                                        (
                                            onlinePaymentError
                                                ? 'gateway_error'
                                                : 'not_started'
                                        ),
                                    paymentId:
                                        payment?.id ||
                                        null,
                                    paymentStatus:
                                        payment?.payment_status ||
                                        null,
                                    qrCodeUrl
                                }
                                : null,

                        responseText:
                            confirmationText
                    };

                } else if (
                    confirmed.status ===
                    'fulfillment_selection_required'
                ) {
                    handlerResult = {
                        status:
                            'fulfillment_selection_required',
                        responseText:
                            'Pesanannya mau diantar atau kakak ambil sendiri di outlet?\n\n' +
                            'Balas "antar" atau "ambil sendiri" ya kak.'
                    };

                } else if (
                    confirmed.status ===
                    'delivery_payment_required'
                ) {
                    handlerResult = {
                        status:
                            'delivery_payment_required',
                        responseText:
                            'Pilih cara bayarnya dulu ya kak.\n\n' +
                            'Untuk pesanan yang diantar, balas "bayar online".'
                    };

                } else if (
                    confirmed.status ===
                    'pickup_payment_required'
                ) {
                    handlerResult = {
                        status:
                            'pickup_payment_required',
                        responseText:
                            'Untuk pesanan yang diambil sendiri, pilih cara bayarnya dulu ya kak.\n\n' +
                            'Balas "bayar online" atau "bayar di outlet".'
                    };

                } else if (
                    confirmed.status ===
                    'delivery_area_not_supported'
                ) {
                    handlerResult = {
                        status:
                            'delivery_area_not_supported',
                        responseText:
                            'Untuk saat ini pengiriman gratis hanya tersedia di Kota Bandung.\n\n' +
                            'Gunakan alamat di Kota Bandung atau pilih ambil sendiri di outlet.'
                    };


                } else if (
                    confirmed.status ===
                    'shipping_address_required'
                ) {
                    handlerResult = {
                        status:
                            'shipping_address_required',
                        responseText:
                            'Alamat pengirimannya belum ada.\n\n' +
                            'Kirim alamatnya dulu ya, contoh:\n' +
                            '"antar ke Jl. Merdeka No. 10 Bandung"'
                    };

                } else {
                    handlerResult = {
                        ...handlerResult,

                        confirmationStatus:
                            confirmed.status
                    };
                }
            }

        } else if (
            routedIntent.handler ===
            'ORDER_CANCEL_HANDLER'
        ) {
            handlerResult =
                await this.orderCancelHandler.handle({
                    customer
                });

        } else if (
            routedIntent.handler ===
            'PAYMENT_REQUEST_HANDLER'
        ) {
            handlerResult =
                await this.paymentRequestHandler.handle({
                    customer
                });
        }


        const canAutoReply =
            this.canAutoReply({
                classifiedIntent,
                routedIntent,
                handlerResult
            });


        let responseText =
            handlerResult?.responseText || null;

        const responseMedia =
            handlerResult?.media || null;

        const responseMediaItems =
            handlerResult?.mediaItems || [];

        return {
            classifiedIntent,
            routedIntent,
            handlerResult,
            canAutoReply,
            responseText,
            responseMedia,
            responseMediaItems
        };
    }


    canAutoReply({
        classifiedIntent,
        routedIntent,
        handlerResult
    }) {
        if (!handlerResult) {
            return false;
        }

        return (
            (
                classifiedIntent.intent ===
                    'AI_SEMANTIC_CATALOG' &&
                (
                    handlerResult.status ===
                        'semantic_catalog' ||
                    handlerResult.status ===
                        'not_found'
                ) &&
                typeof handlerResult.responseText ===
                    'string' &&
                handlerResult.responseText
                    .trim().length > 0
            ) ||
            (
                classifiedIntent.intent ===
                    'AI_OPERATION' &&
                handlerResult.status ===
                    'ready' &&
                typeof handlerResult.responseText ===
                    'string' &&
                handlerResult.responseText
                    .trim().length > 0
            ) ||
            (
                classifiedIntent.intent ===
                    'MULTI_COMMAND' &&
                routedIntent.action ===
                    'RESPOND_ONLY' &&
                handlerResult.status ===
                    'multiple_commands'
            ) ||
            (
                classifiedIntent.intent ===
                    'PRODUCT_INQUIRY' &&
                routedIntent.action ===
                    'READ_CATALOG' &&
                (
                    handlerResult.status ===
                        'found' ||
                    handlerResult.status ===
                        'catalog' ||
                    handlerResult.status ===
                        'catalog_empty' ||
                    handlerResult.status ===
                        'not_found' ||
                    handlerResult.status ===
                        'need_product_name' ||
                    handlerResult.status ===
                        'need_product_selection'
                )
            ) ||
            (
                classifiedIntent.intent ===
                    'PRODUCT_IMAGE' &&
                routedIntent.action ===
                    'READ_PRODUCT_IMAGE' &&
                (
                    handlerResult.status ===
                        'found' ||
                    handlerResult.status ===
                        'multiple_products' ||
                    handlerResult.status ===
                        'not_found' ||
                    handlerResult.status ===
                        'need_product_name' ||
                    handlerResult.status ===
                        'image_not_available' ||
                    handlerResult.status ===
                        'need_product_selection' ||
                    handlerResult.status ===
                        'multi_product_need_selection' ||
                    handlerResult.status ===
                        'multi_product_ready' ||
                    handlerResult.status ===
                        'multi_product_not_found' ||
                    handlerResult.status ===
                        'multi_product_unresolved'
                )
            ) ||
            (
                (
                    classifiedIntent.intent ===
                        'FULFILLMENT_DELIVERY' ||
                    classifiedIntent.intent ===
                        'FULFILLMENT_PICKUP'
                ) &&
                routedIntent.handler ===
                    'FULFILLMENT_SELECTION_HANDLER' &&
                (
                    handlerResult.status ===
                        'delivery_selected' ||
                    handlerResult.status ===
                        'pickup_selected' ||
                    handlerResult.status ===
                        'draft_not_found' ||
                    handlerResult.status ===
                        'customer_missing' ||
                    handlerResult.status ===
                        'merchant_missing' ||
                    handlerResult.status ===
                        'merchant_inactive' ||
                    handlerResult.status ===
                        'pickup_location_missing' ||
                    handlerResult.status ===
                        'invalid_action'
                )
            ) ||
            (
                (
                    classifiedIntent.intent ===
                        'PICKUP_PAYMENT_OUTLET' ||
                    classifiedIntent.intent ===
                        'PICKUP_PAYMENT_ONLINE'
                ) &&
                routedIntent.handler ===
                    'PICKUP_PAYMENT_SELECTION_HANDLER' &&
                (
                    handlerResult.status ===
                        'outlet_payment_selected' ||
                    handlerResult.status ===
                        'online_payment_selected' ||
                    handlerResult.status ===
                        'pickup_required' ||
                    handlerResult.status ===
                        'draft_not_found' ||
                    handlerResult.status ===
                        'customer_missing' ||
                    handlerResult.status ===
                        'pickup_location_missing' ||
                    handlerResult.status ===
                        'invalid_action'
                )
            ) ||
            (
                classifiedIntent.intent ===
                    'DELIVERY_PAYMENT_ONLINE' &&
                routedIntent.handler ===
                    'DELIVERY_PAYMENT_SELECTION_HANDLER' &&
                (
                    handlerResult.status ===
                        'online_payment_selected' ||
                    handlerResult.status ===
                        'delivery_required' ||
                    handlerResult.status ===
                        'shipping_address_required' ||
                    handlerResult.status ===
                        'draft_not_found' ||
                    handlerResult.status ===
                        'customer_missing' ||
                    handlerResult.status ===
                        'invalid_action'
                )
            ) ||
            (
                classifiedIntent.intent ===
                    'ADDRESS_UPDATE' &&
                routedIntent.action ===
                    'REQUIRE_CONFIRMATION' &&
                (
                    handlerResult.status ===
                        'address_updated' ||
                    handlerResult.status ===
                        'address_missing' ||
                    handlerResult.status ===
                        'draft_not_found' ||
                    handlerResult.status ===
                        'customer_missing'
                )
            ) ||
            (
                classifiedIntent.intent ===
                    'EMPTY_MESSAGE' &&
                routedIntent.action ===
                    'RESPOND_ONLY' &&
                handlerResult.status ===
                    'empty_message'
            ) ||
            (
                classifiedIntent.intent ===
                    'UNKNOWN' &&
                routedIntent.action ===
                    'RESPOND_ONLY' &&
                handlerResult.status ===
                    'unsupported_intent'
            ) ||
            (
                classifiedIntent.intent ===
                    'GREETING' &&
                routedIntent.action ===
                    'RESPOND_ONLY' &&
                handlerResult.status ===
                    'ready'
            ) ||
            (
                classifiedIntent.intent ===
                    'ORDER_STATUS' &&
                routedIntent.action ===
                    'READ_CUSTOMER_ORDERS' &&
                (
                    handlerResult.status ===
                        'found' ||
                    handlerResult.status ===
                        'not_found'
                )
            ) ||
            (
                classifiedIntent.intent ===
                    'PRODUCT_ORDER' &&
                routedIntent.action ===
                    'CREATE_DRAFT_ONLY' &&
                (
                    (
                        handlerResult.status ===
                            'draft_ready' &&
                        handlerResult.draftStorageStatus ===
                            'stored'
                    ) ||
                    handlerResult.status ===
                        'need_product_name' ||
                    handlerResult.status ===
                        'invalid_quantity' ||
                    handlerResult.status ===
                        'product_not_found' ||
                    handlerResult.status ===
                        'multiple_products' ||
                    handlerResult.status ===
                        'insufficient_stock' ||
                    handlerResult.status ===
                        'quantity_updated' ||
                    handlerResult.status ===
                        'product_replaced'
                )
            ) ||
            (
                classifiedIntent.intent ===
                    'ORDER_CONFIRMATION' &&
                routedIntent.action ===
                    'VALIDATE_DRAFT_CONFIRMATION' &&
                (
                    handlerResult.status ===
                        'confirmed' ||
                    handlerResult.status ===
                        'fulfillment_selection_required' ||
                    handlerResult.status ===
                        'delivery_payment_required' ||
                    handlerResult.status ===
                        'pickup_payment_required' ||
                    handlerResult.status ===
                        'delivery_area_not_supported' ||
                    handlerResult.status ===
                        'shipping_address_required' ||
                    handlerResult.status ===
                        'customer_missing' ||
                    handlerResult.status ===
                        'draft_not_found' ||
                    handlerResult.status ===
                        'draft_expired' ||
                    handlerResult.status ===
                        'product_inactive' ||
                    handlerResult.status ===
                        'insufficient_stock' ||
                    handlerResult.status ===
                        'price_unavailable' ||
                    handlerResult.status ===
                        'price_changed' ||
                    handlerResult.status ===
                        'subtotal_mismatch'
                )
            ) ||
            (
                classifiedIntent.intent ===
                    'ORDER_CANCEL' &&
                routedIntent.action ===
                    'CANCEL_DRAFT' &&
                (
                    handlerResult.status ===
                        'cancelled' ||
                    handlerResult.status ===
                        'draft_not_found' ||
                    handlerResult.status ===
                        'customer_missing'
                )
            ) ||
            (
                classifiedIntent.intent ===
                    'PAYMENT_REQUEST' &&
                routedIntent.action ===
                    'CREATE_PAYMENT_INTENT' &&
                Boolean(
                    handlerResult.responseText
                )
            )
        );
    }
}


module.exports =
    WhatsAppConversationOrchestrator;
