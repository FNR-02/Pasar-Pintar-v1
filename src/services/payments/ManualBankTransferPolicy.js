'use strict';

function isManualBankTransferReady() {
    return (
        String(
            process.env
                .MANUAL_BANK_TRANSFER_ENABLED ||
            ''
        ).toLowerCase() === 'true'
    );
}

module.exports = {
    isManualBankTransferReady
};
