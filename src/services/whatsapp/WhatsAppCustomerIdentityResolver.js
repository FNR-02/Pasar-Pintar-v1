class WhatsAppCustomerIdentityResolver {
    constructor(pool) {
        this.pool = pool;
    }

    normalizePhone(value) {
        let phone = String(value || '').trim();

        // Evolution/Baileys commonly supplies a WhatsApp JID.
        phone = phone.split('@')[0];

        // Keep digits only.
        phone = phone.replace(/\D/g, '');

        if (phone.startsWith('0')) {
            phone = '62' + phone.slice(1);
        }

        if (!/^62\d{8,13}$/.test(phone)) {
            return null;
        }

        return phone;
    }

    async resolve(sender) {
        const phone = this.normalizePhone(sender);

        if (!phone) {
            return {
                status: 'invalid_sender',
                phone: null,
                customer: null
            };
        }

        const result = await this.pool.query(
            `SELECT
                c.id AS customer_id,
                c.user_id,
                c.full_name,
                c.phone,
                c.phone_verified_at,
                u.username,
                u.email
             FROM tbl_customers c
             LEFT JOIN tbl_users u
                ON u.id = c.user_id
             WHERE c.phone = $1
             LIMIT 1`,
            [phone]
        );

        if (result.rowCount === 0) {
            return {
                status: 'unknown_customer',
                phone,
                customer: null
            };
        }

        const customer = result.rows[0];

        if (!customer.phone_verified_at) {
            return {
                status: 'unverified_customer',
                phone,
                customer: null
            };
        }

        return {
            status: 'verified_customer',
            phone,
            customer: {
                customer_id: customer.customer_id,
                user_id: customer.user_id,
                full_name: customer.full_name,
                phone: customer.phone,
                phone_verified_at: customer.phone_verified_at,
                username: customer.username,
                email: customer.email
            }
        };
    }
}

module.exports = WhatsAppCustomerIdentityResolver;
