'use strict';

function isCodPaymentReady() {
    return (
        String(
            process.env.COD_PAYMENT_ENABLED ||
            ''
        ).toLowerCase() === 'true'
    );
}

module.exports = {
    isCodPaymentReady
};
