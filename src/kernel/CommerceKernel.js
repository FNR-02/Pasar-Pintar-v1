const EventEmitter = require('events');

class CommerceOperatingSystemKernel extends EventEmitter {
    constructor(pool) {
        super();
        this.pool = pool;
        this.setMaxListeners(300);
        this.auditLogs = [];
        this.setupCoreWorkflows();
    }

    emitEvent(eventName, payload, meta) {
        const safeMeta = meta || {};
        const timestamp = new Date().toISOString();
        const eventPacket = {
            id: 'EVT-' + Math.random().toString(36).substr(2, 9).toUpperCase(),
            event: eventName,
            payload: payload || {},
            meta: {
                timestamp: timestamp,
                ip: safeMeta.ip || '127.0.0.1',
                device: safeMeta.device || 'Enterprise-Node-Cluster',
                actor: safeMeta.actor || 'SYSTEM_KERNEL'
            }
        };

        console.log(`[COMMERCE KERNEL] ⚡ EVENT FIRED: [${eventName}] ID: ${eventPacket.id}`);
        this.recordAudit(eventPacket);
        super.emit(eventName, eventPacket);
        super.emit('*', eventPacket);
    }

    recordAudit(packet) {
        this.auditLogs.unshift({
            eventId: packet.id,
            event: packet.event,
            actor: packet.meta.actor,
            timestamp: packet.meta.timestamp,
            details: JSON.stringify(packet.payload)
        });
        if (this.auditLogs.length > 500) this.auditLogs.pop();
    }

    setupCoreWorkflows() {
        this.on('KERNEL_AUDIT_LOG', async (logData) => {
            try {
                if (this.pool) {
                    await this.pool.query(
                        `INSERT INTO financial_records (transaction_type, amount, description) VALUES ('AUDIT', 0, $1)`,
                        [`KERNEL_AUDIT: Event [${logData.eventName}] executed`]
                    );
                }
            } catch (err) {
                console.error("[KERNEL ERROR] Gagal mencatat audit log:", err.message);
            }
        });

        this.on('INVENTORY_LOW', async (packet) => {
            console.log(`[WORKFLOW ENGINE] 🔄 Otomasi Aktif: Stok produk #${packet.payload.productId} menipis!`);
        });

        this.on('ORDER_PAID', async (packet) => {
            console.log(`[WORKFLOW ENGINE] 🔄 Otomasi Aktif: Pesanan #${packet.payload.orderId} lunas.`);
        });

        this.on('DELIVERY_COMPLETED', async (packet) => {
            console.log(`[WORKFLOW ENGINE] 🔄 Otomasi Aktif: Pengiriman #${packet.payload.deliveryId} selesai.`);
        });
    }
}

module.exports = CommerceOperatingSystemKernel;
