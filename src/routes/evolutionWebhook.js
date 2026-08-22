const express = require('express');
const crypto = require('crypto');

const WhatsAppCustomerIdentityResolver =
    require('../services/whatsapp/WhatsAppCustomerIdentityResolver');

module.exports = function(pool, CommerceKernel) {
    const router = express.Router();

    const resolver =
        new WhatsAppCustomerIdentityResolver(pool);

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

            if (!remoteJid) {
                return res.status(202).json({
                    status: 'ignored',
                    reason: 'sender_not_found'
                });
            }

            try {
                const identity =
                    await resolver.resolve(remoteJid);

                if (
                    identity.status !==
                    'verified_customer'
                ) {
                    return res.status(202).json({
                        status: 'ignored',
                        reason: identity.status
                    });
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
                            channel: 'whatsapp'
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
