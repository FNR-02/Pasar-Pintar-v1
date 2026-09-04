const CommerceKernel = require('./EventKernel');
const pool = require('../config/db');

const MerchantEntitlementService =
    require('../services/finance/MerchantEntitlementService');

CommerceKernel.on('ORDER_PAID', async (packet) => {
    const order = packet.payload || {};
    const orderId = order.id || order.orderId;

    if (!orderId) {
        console.warn(
            '[MERCHANT ENTITLEMENT] SKIP: order_id tidak tersedia'
        );
        return;
    }

    const service = new MerchantEntitlementService(pool);

    try {
        const result =
            await service.recordFromOrderPaid(orderId);

        if (result.status === 'created') {
            console.log(
                `[MERCHANT ENTITLEMENT] CREATED order=${orderId} ` +
                `merchant=${result.entitlement.merchant_id} ` +
                `amount=${result.entitlement.merchant_entitlement}`
            );
            return;
        }

        if (result.status === 'already_exists') {
            console.log(
                `[MERCHANT ENTITLEMENT] IDEMPOTENT order=${orderId}`
            );
            return;
        }

        console.log(
            `[MERCHANT ENTITLEMENT] SKIP non-marketplace order=${orderId}`
        );
    } catch (err) {
        console.error(
            `[MERCHANT ENTITLEMENT ERROR] order=${orderId}:`,
            err.message
        );
    }
});

console.log(
    '[MERCHANT ENTITLEMENT SUBSCRIBER] ORDER_PAID subscriber aktif'
);
