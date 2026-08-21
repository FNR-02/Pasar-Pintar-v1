// src/kernel/OrderFSM.js

const VALID_TRANSITIONS = {
    'CART': ['PENDING', 'CANCELLED'],
    'PENDING': ['PAID', 'CANCELLED'],
    'PAID': ['PACKING', 'REFUNDED'],
    'PACKING': ['DISPATCHED'],
    'DISPATCHED': ['DELIVERED'],
    'DELIVERED': ['CLOSED', 'RETURNED'],
    'CANCELLED': [],
    'REFUNDED': [],
    'CLOSED': [],
    'RETURNED': []
};

class OrderFSM {
    static canTransition(currentStatus, targetStatus) {
        const allowed = VALID_TRANSITIONS[currentStatus] || [];
        return allowed.includes(targetStatus);
    }

    static assertTransition(currentStatus, targetStatus) {
        if (!this.canTransition(currentStatus, targetStatus)) {
            throw new Error(`[FSM VIOLATION] Transisi status dari '${currentStatus}' ke '${targetStatus}' dilarang oleh aturan sistem!`);
        }
        return true;
    }
}

module.exports = OrderFSM;
