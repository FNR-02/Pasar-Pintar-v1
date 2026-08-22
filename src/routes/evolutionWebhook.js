const express = require('express');
const crypto = require('crypto');

const WhatsAppCustomerIdentityResolver =
    require('../services/whatsapp/WhatsAppCustomerIdentityResolver');
const WhatsAppMessageParser =
    require('../services/whatsapp/WhatsAppMessageParser');
const WhatsAppOutboundMessageService =
    require('../services/whatsapp/WhatsAppOutboundMessageService');
const WhatsAppConversationOrchestrator =
    require('../services/whatsapp/WhatsAppConversationOrchestrator');
const WhatsAppInboundMessageStore =
    require('../services/whatsapp/WhatsAppInboundMessageStore');
const WhatsAppNotificationDeliveryStore =
    require('../services/whatsapp/WhatsAppNotificationDeliveryStore');

module.exports = function(pool, CommerceKernel) {
    const router = express.Router();

    const resolver =
        new WhatsAppCustomerIdentityResolver(pool);

    const messageParser =
        new WhatsAppMessageParser();












    const outboundMessageService =
        new WhatsAppOutboundMessageService();
    const conversationOrchestrator =
        new WhatsAppConversationOrchestrator(
            pool,
            CommerceKernel
        );

    const inboundMessageStore =
        new WhatsAppInboundMessageStore(pool);

    const notificationDeliveryStore =
        new WhatsAppNotificationDeliveryStore(pool);

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

            let inboundDeliveryId = null;

            try {
                /*
                 * Parse messageId sebelum proses bisnis apa pun.
                 *
                 * WhatsApp inbound tanpa messageId tidak aman
                 * untuk diproses karena tidak memiliki idempotency key.
                 */
                const parsedMessage =
                    messageParser.parse(data);

                if (!parsedMessage.messageId) {
                    return res.status(202).json({
                        status: 'ignored',
                        reason: 'message_id_missing'
                    });
                }

                /*
                 * Atomic inbound claim.
                 *
                 * Duplicate PROCESSING / PROCESSED berhenti di sini,
                 * sebelum identity resolver, orchestrator, payment,
                 * order confirmation, draft, dan auto-reply.
                 */
                const inboundClaim =
                    await inboundMessageStore.claim({
                        messageId:
                            parsedMessage.messageId
                    });

                if (
                    inboundClaim.status ===
                    'duplicate'
                ) {
                    return res.status(202).json({
                        status: 'ignored',
                        reason: 'duplicate_message',
                        messageId:
                            parsedMessage.messageId,
                        existingStatus:
                            inboundClaim.delivery?.status ||
                            null
                    });
                }

                inboundDeliveryId =
                    inboundClaim.delivery?.id || null;

                const identity =
                    await resolver.resolve(identitySender);

                if (
                    identity.status !==
                    'verified_customer'
                ) {
                    /*
                     * Message sudah berhasil di-claim dan keputusan
                     * untuk mengabaikannya merupakan hasil terminal,
                     * bukan processing failure.
                     *
                     * Tutup ledger sebagai PROCESSED agar row tidak
                     * tertinggal dalam status PROCESSING.
                     */
                    if (inboundDeliveryId) {
                        await inboundMessageStore.markProcessed({
                            deliveryId:
                                inboundDeliveryId
                        });
                    }

                    return res.status(202).json({
                        status: 'ignored',
                        reason:
                            identity.status
                    });
                }

                const conversation =
                    await conversationOrchestrator.handle({
                        text:
                            parsedMessage.text,
                        messageId:
                            parsedMessage.messageId,
                        customer:
                            identity.customer
                    });

                const {
                    classifiedIntent,
                    routedIntent,
                    handlerResult,
                    canAutoReply,
                    responseText
                } = conversation;

                let outboundResult = null;
                let autoReplyDelivery = null;

                if (
                    canAutoReply &&
                    responseText
                ) {
                    const autoReplyEventKey =
                        `WHATSAPP:AUTO_REPLY:${parsedMessage.messageId}`;

                    const deliveryClaim =
                        await notificationDeliveryStore.claim({
                            eventKey:
                                autoReplyEventKey,
                            notificationType:
                                'AUTO_REPLY',
                            customerId:
                                identity.customer.customer_id,
                            phone:
                                identity.phone
                        });

                    if (
                        deliveryClaim.status ===
                        'claimed'
                    ) {
                        autoReplyDelivery =
                            deliveryClaim.delivery;

                        try {
                            outboundResult =
                                await outboundMessageService.sendText({
                                    phone:
                                        identity.phone,
                                    text:
                                        responseText
                                });

                            await notificationDeliveryStore.markSent({
                                deliveryId:
                                    autoReplyDelivery.id,
                                outboundMessageId:
                                    outboundResult.messageId || null
                            });
                        } catch (outboundErr) {
                            await notificationDeliveryStore.markFailed({
                                deliveryId:
                                    autoReplyDelivery.id,
                                error:
                                    outboundErr
                            });

                            console.error(
                                '[WHATSAPP AUTO REPLY]',
                                outboundErr.message
                            );
                        }
                    } else {
                        console.log(
                            '[WHATSAPP AUTO REPLY] SKIP ' +
                            `${parsedMessage.messageId}: ` +
                            `delivery sudah ada ` +
                            `(${deliveryClaim.delivery?.status || 'UNKNOWN'})`
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

                if (inboundDeliveryId) {
                    await inboundMessageStore.markProcessed({
                        deliveryId:
                            inboundDeliveryId
                    });
                }

                return res.status(202).json({
                    status: 'accepted',
                    identity: 'verified_customer'
                });
            } catch (err) {
                if (inboundDeliveryId) {
                    try {
                        await inboundMessageStore.markFailed({
                            deliveryId:
                                inboundDeliveryId,
                            error:
                                err
                        });
                    } catch (deliveryErr) {
                        console.error(
                            '[WHATSAPP INBOUND STATE]',
                            deliveryErr.message
                        );
                    }
                }

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
