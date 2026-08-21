const EventEmitter = require('events');
const pool = require('../config/db');

class CommerceKernelEngine extends EventEmitter {

    constructor() {
        super();

        this.setMaxListeners(300);
        this.auditLogs = [];
    }

    emitEvent(eventName, aggregateType, aggregateId, payload) {

        const timestamp = new Date().toISOString();

        const eventPacket = {
            eventName,
            aggregateType: aggregateType || null,
            aggregateId: aggregateId || null,
            payload: payload || {},
            timestamp
        };

        console.log(
            `[EVENT KERNEL] ⚡ Menerbitkan Event: [${eventName}] ` +
            `untuk ${aggregateType || 'UNKNOWN'} #${aggregateId || 'UNKNOWN'}`
        );

        /*
         * Audit memory.
         */
        this.auditLogs.unshift({
            event: eventName,
            aggregateType: aggregateType || null,
            aggregateId: aggregateId || null,
            timestamp,
            details: JSON.stringify(eventPacket.payload)
        });

        if (this.auditLogs.length > 500) {
            this.auditLogs.pop();
        }

        /*
         * EVENT STORE
         *
         * tbl_events:
         * id           UUID
         * event_name   VARCHAR
         * aggregate_id UUID
         * payload      JSONB
         * processed    BOOLEAN
         * created_at   TIMESTAMPTZ
         */
        this.persistEvent(eventPacket)
            .catch(err => {
                console.error(
                    '[EVENT STORE ERROR]',
                    err.message
                );
            });

        /*
         * Tetap kirim event ke seluruh subscriber.
         */
        this.emit(eventName, eventPacket);
        this.emit('*', eventPacket);

        return eventPacket;
    }

    async persistEvent(eventPacket) {

        const result = await pool.query(
            `
            INSERT INTO tbl_event_store (
                event_name,
                aggregate_type,
                aggregate_id,
                payload,
                created_at
            )
            VALUES ($1, $2, $3, $4, $5)
            RETURNING id, event_name, aggregate_type, aggregate_id, created_at
            `,
            [
                eventPacket.eventName,
                eventPacket.aggregateType || 'UNKNOWN',
                eventPacket.aggregateId || null,
                eventPacket.payload || {},
                eventPacket.timestamp
            ]
        );

        console.log(
            `[EVENT STORE] 💾 Event tersimpan: ` +
            `${result.rows[0].event_name} ` +
            `ID=${result.rows[0].id}`
        );

        return result.rows[0];
    }
}

const CommerceKernel = new CommerceKernelEngine();

module.exports = CommerceKernel;
