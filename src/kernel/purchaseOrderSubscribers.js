const CommerceKernel = require('./EventKernel');

CommerceKernel.on('PURCHASE_ORDER_APPROVED', (p) => {
    console.log(`[PO ENGINE] APPROVED: ${p.aggregateId}`);
});

CommerceKernel.on('PURCHASE_ORDER_RECEIVED', (p) => {
    console.log(`[PO ENGINE] RECEIVED: ${p.aggregateId}`);
});

console.log('[PO ENGINE] PURCHASE ORDER subscriber aktif');
