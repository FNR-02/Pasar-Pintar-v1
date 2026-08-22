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
                                    handlerResult.responseText
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
