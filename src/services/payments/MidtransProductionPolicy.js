'use strict';

function isProductionServerKey(value) {
    return /^Mid-server-/i.test(
        String(value || '').trim()
    );
}

function isProductionClientKey(value) {
    return /^Mid-client-/i.test(
        String(value || '').trim()
    );
}

function getMidtransProductionReadiness() {
    const productionMode =
        String(
            process.env.MIDTRANS_IS_PRODUCTION || ''
        ).toLowerCase() === 'true';

    const serverKeyReady =
        isProductionServerKey(
            process.env.MIDTRANS_SERVER_KEY
        );

    const clientKeyReady =
        isProductionClientKey(
            process.env.MIDTRANS_CLIENT_KEY
        );

    return {
        ready:
            productionMode &&
            serverKeyReady &&
            clientKeyReady,
        production_mode:
            productionMode,
        server_key_ready:
            serverKeyReady,
        client_key_ready:
            clientKeyReady
    };
}

function isMidtransProductionReady() {
    return getMidtransProductionReadiness()
        .ready;
}

module.exports = {
    isMidtransProductionReady,
    getMidtransProductionReadiness
};
