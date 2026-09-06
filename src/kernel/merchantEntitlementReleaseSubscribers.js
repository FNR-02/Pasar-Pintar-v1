const CommerceKernel =
    require('./EventKernel');

const pool =
    require('../config/db');

const MerchantEntitlementReleaseService =
    require(
        '../services/finance/' +
        'MerchantEntitlementReleaseService'
    );

async function releaseOrder(
    eventName,
    packet
) {
    const payload =
        packet.payload || {};

    const orderId =
        payload.orderId ||
        (
            packet.aggregateType === 'ORDER'
                ? packet.aggregateId
                : null
        );

    if (!orderId) {
        console.warn(
            `[MERCHANT ENTITLEMENT RELEASE] ` +
            `${eventName} SKIP: order_id tidak tersedia`
        );
        return;
    }

    const service =
        new MerchantEntitlementReleaseService(
            pool
        );

    try {
        const result =
            await service.releaseByOrderId(
                orderId
            );

        console.log(
            `[MERCHANT ENTITLEMENT RELEASE] ` +
            `${eventName} order=${orderId} ` +
            `status=${result.status} ` +
            `released=${result.released_count || 0}`
        );
    } catch (err) {
        console.error(
            `[MERCHANT ENTITLEMENT RELEASE ERROR] ` +
            `${eventName} order=${orderId}:`,
            err.message
        );
    }
}

CommerceKernel.on(
    'PICKUP_COMPLETED',
    async packet => {
        await releaseOrder(
            'PICKUP_COMPLETED',
            packet
        );
    }
);

CommerceKernel.on(
    'DELIVERY_COMPLETED',
    async packet => {
        await releaseOrder(
            'DELIVERY_COMPLETED',
            packet
        );
    }
);

CommerceKernel.on(
    'MARKET_ORDER_DELIVERED',
    async packet => {
        const payload =
            packet.payload || {};

        const marketOrderId =
            payload.marketOrderId ||
            (
                packet.aggregateType ===
                    'MARKET_ORDER'
                    ? packet.aggregateId
                    : null
            );

        if (!marketOrderId) {
            console.warn(
                '[MERCHANT ENTITLEMENT RELEASE] ' +
                'MARKET_ORDER_DELIVERED SKIP: ' +
                'market_order_id tidak tersedia'
            );
            return;
        }

        const service =
            new MerchantEntitlementReleaseService(
                pool
            );

        try {
            const result =
                await service
                    .releaseByMarketOrderId(
                        marketOrderId
                    );

            console.log(
                '[MERCHANT ENTITLEMENT RELEASE] ' +
                `MARKET_ORDER_DELIVERED ` +
                `market_order=${marketOrderId} ` +
                `status=${result.status} ` +
                `released=${result.released_count || 0}`
            );
        } catch (err) {
            console.error(
                '[MERCHANT ENTITLEMENT RELEASE ERROR] ' +
                `MARKET_ORDER_DELIVERED ` +
                `market_order=${marketOrderId}:`,
                err.message
            );
        }
    }
);

console.log(
    '[MERCHANT ENTITLEMENT RELEASE SUBSCRIBER] ' +
    'PICKUP_COMPLETED, DELIVERY_COMPLETED, ' +
    'MARKET_ORDER_DELIVERED aktif'
);
