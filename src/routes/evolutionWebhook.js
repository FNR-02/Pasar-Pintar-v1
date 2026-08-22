const express = require('express');
const crypto = require('crypto');

const WhatsAppCustomerIdentityResolver =
    require('../services/whatsapp/WhatsAppCustomerIdentityResolver');
const WhatsAppMessageParser =
    require('../services/whatsapp/WhatsAppMessageParser');
const WhatsAppIntentClassifier =
    require('../services/whatsapp/WhatsAppIntentClassifier');
const WhatsAppIntentRouter =
    require('../services/whatsapp/WhatsAppIntentRouter');
const ProductInquiryHandler =
    require('../services/whatsapp/ProductInquiryHandler');
const GreetingHandler =
    require('../services/whatsapp/GreetingHandler');
const OrderStatusHandler =
    require('../services/whatsapp/OrderStatusHandler');
const ProductOrderDraftHandler =
    require('../services/whatsapp/ProductOrderDraftHandler');
const WhatsAppOrderDraftStore =
    require('../services/whatsapp/WhatsAppOrderDraftStore');
const OrderConfirmationHandler =
    require('../services/whatsapp/OrderConfirmationHandler');
const OrderCancelHandler =
    require('../services/whatsapp/OrderCancelHandler');
const WhatsAppOrderConfirmationService =
    require('../services/whatsapp/WhatsAppOrderConfirmationService');
const WhatsAppPaymentRequestHandler =
    require('../services/whatsapp/WhatsAppPaymentRequestHandler');
const WhatsAppOutboundMessageService =
    require('../services/whatsapp/WhatsAppOutboundMessageService');

module.exports = function(pool, CommerceKernel) {
    const router = express.Router();

    const resolver =
        new WhatsAppCustomerIdentityResolver(pool);

    const messageParser =
        new WhatsAppMessageParser();

    const intentClassifier =
        new WhatsAppIntentClassifier();

    const intentRouter =
        new WhatsAppIntentRouter();

    const productInquiryHandler =
        new ProductInquiryHandler(pool);

    const greetingHandler =
        new GreetingHandler();

    const orderStatusHandler =
        new OrderStatusHandler(pool);

    const productOrderDraftHandler =
        new ProductOrderDraftHandler(pool);

    const orderDraftStore =
        new WhatsAppOrderDraftStore(pool);

    const orderConfirmationHandler =
        new OrderConfirmationHandler(pool);

    const orderCancelHandler =
        new OrderCancelHandler(pool);

    const orderConfirmationService =
        new WhatsAppOrderConfirmationService(
            pool,
            CommerceKernel
        );

    const paymentRequestHandler =
        new WhatsAppPaymentRequestHandler(pool);

    const outboundMessageService =
        new WhatsAppOutboundMessageService();

    function secureEqual(a, b) {
        const left = Buffer.from(String(a || ''));
        const right = Buffer.from(String(b || ''));

        if (
            left.length === 0 ||
            right.length === 0 ||
            left.length !== right.length
        ) {
            return false;
        }

        return crypto.timingSafeEqual(left, right);
    }

    router.post(
        '/integrations/evolution/webhook',
        async (req, res) => {
            const expectedSecret =
                String(
                    process.env.EVOLUTION_WEBHOOK_SECRET || ''
                ).trim();

            const receivedSecret =
                String(
                    req.get('x-pasar-pintar-webhook-secret') || ''
                ).trim();

            if (
                !expectedSecret ||
                !secureEqual(receivedSecret, expectedSecret)
            ) {
                return res.status(401).json({
                    error: 'Webhook tidak terautentikasi'
                });
            }

            const payload = req.body || {};

            const event =
                String(payload.event || '')
                    .trim()
                    .toUpperCase()
                    .replace(/\./g, '_');

            if (event !== 'MESSAGES_UPSERT') {
                return res.status(202).json({
                    status: 'ignored',
                    reason: 'event_not_supported'
                });
            }

            const data = payload.data || {};
            const key = data.key || {};

            if (key.fromMe === true) {
                return res.status(202).json({
                    status: 'ignored',
                    reason: 'outbound_message'
                });
            }

            const remoteJid =
                key.remoteJid ||
                data.remoteJid ||
                null;

            const remoteJidAlt =
                key.remoteJidAlt ||
                data.remoteJidAlt ||
                null;

            const addressingMode =
                String(
                    key.addressingMode ||
                    data.addressingMode ||
                    ''
                )
                    .trim()
                    .toLowerCase();

            const isLidAddress =
                addressingMode === 'lid' ||
                String(remoteJid || '')
                    .toLowerCase()
                    .endsWith('@lid');

            const identitySender =
                isLidAddress
                    ? (remoteJidAlt || remoteJid)
                    : (remoteJid || remoteJidAlt);

            if (!identitySender) {
                return res.status(202).json({
                    status: 'ignored',
                    reason: 'sender_not_found'
                });
            }

            try {
                const identity =
                    await resolver.resolve(identitySender);

                if (
                    identity.status !==
                    'verified_customer'
                ) {
                    return res.status(202).json({
                        status: 'ignored',
                        reason: identity.status
                    });
                }

                const parsedMessage =
                    messageParser.parse(data);

                const classifiedIntent =
                    intentClassifier.classify(
                        parsedMessage.text
                    );

                const routedIntent =
                    intentRouter.route({
                        intent:
                            classifiedIntent.intent,
                        text:
                            parsedMessage.text,
                        customer:
                            identity.customer
                    });

                let handlerResult = null;

                if (
                    routedIntent.handler ===
                    'PRODUCT_INQUIRY_HANDLER'
                ) {
                    handlerResult =
                        await productInquiryHandler.handle({
                            text:
                                parsedMessage.text
                        });
                } else if (
                    routedIntent.handler ===
                    'GREETING_HANDLER'
                ) {
                    handlerResult =
                        greetingHandler.handle({
                            customer:
                                identity.customer
                        });
                } else if (
                    routedIntent.handler ===
                    'ORDER_STATUS_HANDLER'
                ) {
                    handlerResult =
                        await orderStatusHandler.handle({
                            customer:
                                identity.customer
                        });
                } else if (
                    routedIntent.handler ===
                    'PRODUCT_ORDER_DRAFT_HANDLER'
                ) {
                    handlerResult =
                        await productOrderDraftHandler.handle({
                            text:
                                parsedMessage.text
                        });

                    if (
                        handlerResult.status ===
                            'draft_ready' &&
                        handlerResult.draft &&
                        parsedMessage.messageId
                    ) {
                        const storedDraft =
                            await orderDraftStore.createOrReplace({
                                customerId:
                                    identity.customer.customer_id,
                                draft:
                                    handlerResult.draft,
                                sourceMessageId:
                                    parsedMessage.messageId
                            });

                        handlerResult.draftStorageStatus =
                            storedDraft.status;

                        handlerResult.draftId =
                            storedDraft.draft?.id || null;
                    }
                }
 else if (
                    routedIntent.handler ===
                    'ORDER_CONFIRMATION_HANDLER'
                ) {
                    handlerResult =
                        await orderConfirmationHandler.handle({
                            customer:
                                identity.customer
                        });

                    if (
                        handlerResult.status ===
                            'confirmation_ready'
                    ) {
                        const confirmed =
                            await orderConfirmationService.confirm({
                                customerId:
                                    identity.customer.customer_id
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
                        await orderCancelHandler.handle({
                            customer:
                                identity.customer
                        });
                } else if (
                    routedIntent.handler ===
                    'PAYMENT_REQUEST_HANDLER'
                ) {
                    handlerResult =
                        await paymentRequestHandler.handle({
                            customer:
                                identity.customer
                        });
                }

                let outboundResult = null;

                const canAutoReply =
                    (
                        classifiedIntent.intent ===
                            'PRODUCT_INQUIRY' &&
                        routedIntent.action ===
                            'READ_CATALOG' &&
                        handlerResult &&
                        handlerResult.status ===
                            'found'
                    ) ||
                    (
                        classifiedIntent.intent ===
                            'GREETING' &&
                        routedIntent.action ===
                            'RESPOND_ONLY' &&
                        handlerResult &&
                        handlerResult.status ===
                            'ready'
                    ) ||
                    (
                        classifiedIntent.intent ===
                            'ORDER_STATUS' &&
                        routedIntent.action ===
                            'READ_CUSTOMER_ORDERS' &&
                        handlerResult &&
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
                        handlerResult &&
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
                        handlerResult &&
                        handlerResult.status ===
                            'confirmed'
                    ) ||
                    (
                        classifiedIntent.intent ===
                            'PAYMENT_REQUEST' &&
                        routedIntent.action ===
                            'CREATE_PAYMENT_INTENT' &&
                        handlerResult &&
                        (
                            handlerResult.status ===
                                'payment_ready' ||
                            handlerResult.status ===
                                'payment_expired' ||
                            handlerResult.status ===
                                'order_not_found'
                        )
                    );

                const hasResponseText =
                    handlerResult &&
                    handlerResult.responseText;

                if (
                    canAutoReply &&
                    hasResponseText
                ) {
                    try {
                        outboundResult =
                            await outboundMessageService.sendText({
                                phone:
                                    identity.phone,
                                text:
                                    (
                            classifiedIntent.intent === 'PRODUCT_ORDER'
                                ? handlerResult.responseText +
                                  '\n\nBalas KONFIRMASI untuk membuat pesanan, atau BATAL untuk membatalkan.'
                                : handlerResult.responseText
                        )
                            });
                    } catch (outboundErr) {
                        console.error(
                            '[WHATSAPP AUTO REPLY]',
                            outboundErr.message
                        );
                    }
                }

                if (CommerceKernel) {
                    CommerceKernel.emitEvent(
                        'WHATSAPP_MESSAGE_RECEIVED',
                        'CUSTOMER',
                        identity.customer.customer_id,
                        {
                            customerId:
                                identity.customer.customer_id,
                            userId:
                                identity.customer.user_id,
                            phone:
                                identity.phone,
                            channel: 'whatsapp',
                            messageId:
                                parsedMessage.messageId,
                            messageType:
                                parsedMessage.messageType,
                            text:
                                parsedMessage.text,
                            timestamp:
                                parsedMessage.timestamp,
                            intent:
                                classifiedIntent.intent,
                            confidence:
                                classifiedIntent.confidence,
                            handler:
                                routedIntent.handler,
                            action:
                                routedIntent.action,
                            handlerStatus:
                                handlerResult
                                    ? handlerResult.status
                                    : null,
                            draftStorageStatus:
                                handlerResult
                                    ? handlerResult.draftStorageStatus || null
                                    : null,
                            draftId:
                                handlerResult
                                    ? handlerResult.draftId || null
                                    : null,
                            responseDraft:
                                handlerResult
                                    ? handlerResult.responseText
                                    : null,
                            autoReplySent:
                                Boolean(outboundResult),
                            outboundMessageId:
                                outboundResult
                                    ? outboundResult.messageId
                                    : null
                        }
                    );
                }

                return res.status(202).json({
                    status: 'accepted',
                    identity: 'verified_customer'
                });
            } catch (err) {
                console.error(
                    '[EVOLUTION WEBHOOK]',
                    err.message
                );

                return res.status(500).json({
                    error: 'Gagal memproses webhook'
                });
            }
        }
    );

    return router;
};
