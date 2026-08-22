const express =
    require('express');

const {
    verifyToken,
    requireRole
} =
    require('../middleware/auth');

const WhatsAppRetryHealthService =
    require(
        '../services/whatsapp/WhatsAppRetryHealthService'
    );

module.exports = function(pool) {
    const router =
        express.Router();

    const retryHealthService =
        new WhatsAppRetryHealthService(pool);

    router.get(
        '/admin/health/whatsapp-retry',
        verifyToken,
        requireRole(4),
        async (req, res) => {
            try {
                const result =
                    await retryHealthService.getStatus();

                const httpStatus =
                    result.status === 'unhealthy'
                        ? 503
                        : 200;

                return res
                    .status(httpStatus)
                    .json(result);
            } catch (err) {
                console.error(
                    '[WHATSAPP RETRY HEALTH]',
                    err.message
                );

                return res.status(500).json({
                    status: 'error',
                    error:
                        'Gagal membaca status WhatsApp retry worker'
                });
            }
        }
    );

    return router;
};
