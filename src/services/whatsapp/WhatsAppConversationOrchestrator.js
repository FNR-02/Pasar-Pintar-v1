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
            new AddressUpdateHandler();
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
        const classifiedIntent =
            this.intentClassifier.classify(text);

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
            'ADDRESS_UPDATE_HANDLER'
        ) {
            handlerResult =
                this.addressUpdateHandler.handle();

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
                            'Pesanan berhasil dibuat.\n\n' +
                            `Order: ${confirmed.order.id}\n` +
                            `Status: ${confirmed.order.status}\n` +
                            `Total: Rp ${Number(
                                confirmed.order.total_amount
                            ).toLocaleString('id-ID')}`
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
            responseText
        ) {
            responseText +=
                '\n\n' +
                'Balas KONFIRMASI untuk membuat pesanan, ' +
                'atau BATAL untuk membatalkan.';
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
                        'not_found' ||
                    handlerResult.status ===
                        'need_product_name'
                )
            ) ||
            (
                classifiedIntent.intent ===
                    'ADDRESS_UPDATE' &&
                routedIntent.action ===
                    'REQUIRE_CONFIRMATION' &&
                handlerResult.status ===
                    'address_not_supported'
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
                handlerResult.status ===
                    'draft_ready' &&
                handlerResult.draftStorageStatus ===
                    'stored'
            ) ||
            (
                classifiedIntent.intent ===
                    'ORDER_CONFIRMATION' &&
                routedIntent.action ===
                    'VALIDATE_DRAFT_CONFIRMATION' &&
                handlerResult.status ===
                    'confirmed'
            ) ||
            (
                classifiedIntent.intent ===
                    'PAYMENT_REQUEST' &&
                routedIntent.action ===
                    'CREATE_PAYMENT_INTENT' &&
                (
                    handlerResult.status ===
                        'payment_ready' ||
                    handlerResult.status ===
                        'payment_expired' ||
                    handlerResult.status ===
                        'order_not_found'
                )
            )
        );
    }
}


module.exports =
    WhatsAppConversationOrchestrator;
