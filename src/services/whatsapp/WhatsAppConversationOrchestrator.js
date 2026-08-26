const WhatsAppIntentClassifier =
    require('./WhatsAppIntentClassifier');

const WhatsAppIntentRouter =
    require('./WhatsAppIntentRouter');

const ProductInquiryHandler =
    require('./ProductInquiryHandler');

const GreetingHandler =
    require('./GreetingHandler');

const OrderStatusHandler =
    require('./OrderStatusHandler');

const ProductOrderDraftHandler =
    require('./ProductOrderDraftHandler');

const WhatsAppOrderDraftStore =
    require('./WhatsAppOrderDraftStore');

const OrderConfirmationHandler =
    require('./OrderConfirmationHandler');

const OrderCancelHandler =
    require('./OrderCancelHandler');

const WhatsAppOrderConfirmationService =
    require('./WhatsAppOrderConfirmationService');

const WhatsAppPaymentRequestHandler =
    require('./WhatsAppPaymentRequestHandler');

const MultiCommandHandler =
    require('./MultiCommandHandler');
const AddressUpdateHandler =
    require('./AddressUpdateHandler');

const FulfillmentSelectionHandler =
    require('./FulfillmentSelectionHandler');

const PickupPaymentSelectionHandler =
    require('./PickupPaymentSelectionHandler');
const EmptyMessageHandler =
    require('./EmptyMessageHandler');
const FallbackHandler =
    require('./FallbackHandler');


class WhatsAppConversationOrchestrator {
    constructor(pool, CommerceKernel = null) {
        this.intentClassifier =
            new WhatsAppIntentClassifier();

        this.intentRouter =
            new WhatsAppIntentRouter();

        this.productInquiryHandler =
            new ProductInquiryHandler(pool);

        this.greetingHandler =
            new GreetingHandler();

        this.orderStatusHandler =
            new OrderStatusHandler(pool);

        this.productOrderDraftHandler =
            new ProductOrderDraftHandler(pool);

        this.orderDraftStore =
            new WhatsAppOrderDraftStore(pool);

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

        this.multiCommandHandler =
            new MultiCommandHandler();
        this.addressUpdateHandler =
            new AddressUpdateHandler(pool);

        this.fulfillmentSelectionHandler =
            new FulfillmentSelectionHandler(pool);

        this.pickupPaymentSelectionHandler =
            new PickupPaymentSelectionHandler(pool);
        this.emptyMessageHandler =
            new EmptyMessageHandler();
        this.fallbackHandler =
            new FallbackHandler();
    }


    async handle({
        text,
        messageId,
        customer
    }) {
        let classifiedIntent =
            this.intentClassifier.classify(text);

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

        const routedIntent =
            this.intentRouter.route({
                intent:
                    classifiedIntent.intent,
                text,
                customer
            });

        let handlerResult = null;


        if (
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

        } else if (
            routedIntent.handler ===
            'GREETING_HANDLER'
        ) {
            handlerResult =
                this.greetingHandler.handle({
                    customer
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
                    handlerResult = {
                        status:
                            'confirmed',

                        orderId:
                            confirmed.order.id,

                        responseText:
                            'Sip, pesanan kamu sudah dibuat.\n\n' +
                            `Order: ${confirmed.order.id}\n` +
                            `Status: ${confirmed.order.status}\n` +
                            `Total: Rp ${Number(
                                confirmed.order.total_amount
                            ).toLocaleString('id-ID')}`
                    };

                } else if (
                    confirmed.status ===
                    'fulfillment_selection_required'
                ) {
                    handlerResult = {
                        status:
                            'fulfillment_selection_required',
                        responseText:
                            'Mau pesanannya diantar atau kamu ambil sendiri di outlet?\n\n' +
                            'Balas "antar" atau "ambil sendiri".'
                    };

                } else if (
                    confirmed.status ===
                    'pickup_payment_required'
                ) {
                    handlerResult = {
                        status:
                            'pickup_payment_required',
                        responseText:
                            'Untuk pesanan yang diambil sendiri, pilih cara bayarnya dulu ya.\n\n' +
                            'Balas "bayar online" atau "bayar di outlet".'
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

        /*
         * Product order membutuhkan instruksi eksplisit
         * sebelum order nyata dibuat.
         */
        if (
            canAutoReply &&
            classifiedIntent.intent ===
                'PRODUCT_ORDER' &&
            handlerResult?.status ===
                'draft_ready' &&
            handlerResult?.draftStorageStatus ===
                'stored' &&
            responseText
        ) {
            responseText +=
                '\n\n' +
                'Kalau sudah oke, balas KONFIRMASI. ' +
                'Kalau nggak jadi, balas BATAL.';
        }


        return {
            classifiedIntent,
            routedIntent,
            handlerResult,
            canAutoReply,
            responseText
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
                        'need_product_name'
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
                        'insufficient_stock'
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
