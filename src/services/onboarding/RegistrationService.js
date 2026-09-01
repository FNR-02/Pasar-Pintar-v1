const bcrypt = require('bcrypt');

class RegistrationService {
    constructor(pool) {
        this.pool = pool;
    }

    normalizeEmail(value) {
        return String(value || '')
            .trim()
            .toLowerCase();
    }

    normalizeUsername(value) {
        return String(value || '')
            .trim()
            .toLowerCase();
    }

    normalizePhone(value) {
        let phone =
            String(value || "")
                .trim()
                .replace(/\D/g, "");

        if (phone.startsWith("0")) {
            phone = "62" + phone.slice(1);
        }

        if (!/^62\d{8,13}$/.test(phone)) {
            return null;
        }

        return phone;
    }

    async registerCustomer(input) {
        return this.register({
            ...input,
            roleId: 1,
            profileType: 'CUSTOMER'
        });
    }

    async registerMerchant(input) {
        return this.register({
            ...input,
            roleId: 2,
            profileType: 'MERCHANT'
        });
    }

    async registerCourier(input) {
        return this.register({
            ...input,
            roleId: 3,
            profileType: 'COURIER'
        });
    }

    async register({
        username,
        email,
        password,
        fullName,
        phone = null,
        roleId,
        profileType,

        storeName = null,
        address = null,

        vehicleType = null,
        vehiclePlate = null
    }) {
        const normalizedEmail =
            this.normalizeEmail(email);

        const normalizedUsername =
            this.normalizeUsername(username);

        const normalizedPhone =
            this.normalizePhone(phone);

        const normalizedName =
            String(fullName || '').trim();
        const rawPhone =
            String(phone || "").trim();


        if (!normalizedEmail) {
            throw this.businessError(
                'Email wajib diisi',
                'EMAIL_REQUIRED'
            );
        }

        if (!normalizedUsername) {
            throw this.businessError(
                'Username wajib diisi',
                'USERNAME_REQUIRED'
            );
        }

        if (!normalizedName) {
            throw this.businessError(
                'Nama lengkap wajib diisi',
                'FULL_NAME_REQUIRED'
            );
        }

        if (
            profileType === 'CUSTOMER' &&
            !rawPhone
        ) {
            throw this.businessError(
                'Nomor WhatsApp wajib diisi',
                'PHONE_REQUIRED'
            );
        }

        if (
            profileType === 'CUSTOMER' &&
            rawPhone &&
            !normalizedPhone
        ) {
            throw this.businessError(
                'Format nomor WhatsApp tidak valid',
                'INVALID_PHONE'
            );
        }


        if (
            typeof password !== 'string' ||
            password.length < 8
        ) {
            throw this.businessError(
                'Password minimal 8 karakter',
                'PASSWORD_TOO_SHORT'
            );
        }

        if (![1, 2, 3].includes(Number(roleId))) {
            throw this.businessError(
                'Role pendaftaran tidak valid',
                'INVALID_ROLE'
            );
        }

        if (
            profileType === 'MERCHANT' &&
            !String(storeName || '').trim()
        ) {
            throw this.businessError(
                'Nama toko wajib diisi',
                'STORE_NAME_REQUIRED'
            );
        }

        const client =
            await this.pool.connect();

        try {
            await client.query('BEGIN');

            /*
             * =====================================================
             * DUPLICATE IDENTITY GUARD
             * =====================================================
             */

            const duplicateUser =
                await client.query(
                    `
                    SELECT
                        id,
                        username,
                        email
                    FROM tbl_users
                    WHERE
                        LOWER(username) =
                            LOWER($1)
                        OR
                        LOWER(email) =
                            LOWER($2)
                    LIMIT 1
                    FOR UPDATE
                    `,
                    [
                        normalizedUsername,
                        normalizedEmail
                    ]
                );

            if (duplicateUser.rowCount) {
                throw this.businessError(
                    'Username atau email sudah terdaftar',
                    'USER_ALREADY_EXISTS'
                );
            }

            const passwordHash =
                await bcrypt.hash(
                    password,
                    10
                );

            /*
             * Customer langsung aktif.
             *
             * Merchant/Courier belum aktif sampai
             * Admin menyetujui application.
             */
            const initiallyActive =
                Number(roleId) === 1;

            const userResult =
                await client.query(
                    `
                    INSERT INTO tbl_users (
                        username,
                        email,
                        password_hash,
                        role_id,
                        is_active,
                        nama_lengkap
                    )
                    VALUES (
                        $1,
                        $2,
                        $3,
                        $4,
                        $5,
                        $6
                    )
                    RETURNING
                        id,
                        username,
                        email,
                        role_id,
                        is_active,
                        nama_lengkap,
                        created_at
                    `,
                    [
                        normalizedUsername,
                        normalizedEmail,
                        passwordHash,
                        roleId,
                        initiallyActive,
                        normalizedName
                    ]
                );

            const user =
                userResult.rows[0];

            let profile = null;
            let application = null;

            /*
             * =====================================================
             * CUSTOMER
             * =====================================================
             */
            if (profileType === 'CUSTOMER') {
                const profileResult =
                    await client.query(
                        `
                        INSERT INTO tbl_customers (
                            user_id,
                            full_name,
                            phone
                        )
                        VALUES (
                            $1,
                            $2,
                            $3
                        )
                        RETURNING *
                        `,
                        [
                            user.id,
                            normalizedName,
                            normalizedPhone || null
                        ]
                    );

                profile =
                    profileResult.rows[0];
            }

            /*
             * =====================================================
             * MERCHANT
             * =====================================================
             */
            if (profileType === 'MERCHANT') {
                const profileResult =
                    await client.query(
                        `
                        INSERT INTO tbl_merchants (
                            user_id,
                            store_name,
                            address,
                            phone,
                            status
                        )
                        VALUES (
                            $1,
                            $2,
                            $3,
                            $4,
                            'PENDING'
                        )
                        RETURNING *
                        `,
                        [
                            user.id,
                            String(storeName).trim(),
                            String(address || '').trim() || null,
                            normalizedPhone || null
                        ]
                    );

                profile =
                    profileResult.rows[0];

                application =
                    await this.createApplication(
                        client,
                        user.id,
                        roleId
                    );
            }

            /*
             * =====================================================
             * COURIER
             * =====================================================
             */
            if (profileType === 'COURIER') {
                const profileResult =
                    await client.query(
                        `
                        INSERT INTO tbl_couriers (
                            user_id,
                            full_name,
                            phone,
                            vehicle_type,
                            vehicle_plate,
                            status
                        )
                        VALUES (
                            $1,
                            $2,
                            $3,
                            $4,
                            $5,
                            'PENDING'
                        )
                        RETURNING *
                        `,
                        [
                            user.id,
                            normalizedName,
                            normalizedPhone || null,
                            String(vehicleType || '').trim() || null,
                            String(vehiclePlate || '').trim() || null
                        ]
                    );

                profile =
                    profileResult.rows[0];

                application =
                    await this.createApplication(
                        client,
                        user.id,
                        roleId
                    );
            }

            if (!profile) {
                throw new Error(
                    'Profil onboarding gagal dibuat'
                );
            }

            await client.query('COMMIT');

            return {
                status:
                    Number(roleId) === 1
                        ? 'ACTIVE'
                        : 'PENDING_APPROVAL',

                user,
                profile,
                application
            };

        } catch (err) {
            try {
                await client.query('ROLLBACK');
            } catch (_) {}

            /*
             * PostgreSQL unique violation.
             */
            if (err.code === '23505') {
                throw this.businessError(
                    'Data akun sudah terdaftar',
                    'DUPLICATE_IDENTITY'
                );
            }

            throw err;

        } finally {
            client.release();
        }
    }

    async createApplication(
        client,
        userId,
        roleId
    ) {
        const result =
            await client.query(
                `
                INSERT INTO
                    tbl_onboarding_applications (
                        user_id,
                        role_id,
                        application_status
                    )
                VALUES (
                    $1,
                    $2,
                    'PENDING'
                )
                RETURNING *
                `,
                [
                    userId,
                    roleId
                ]
            );

        return result.rows[0];
    }

    businessError(
        message,
        code
    ) {
        const err =
            new Error(message);

        err.code =
            code;

        err.statusCode =
            409;

        if (
            [
                'EMAIL_REQUIRED',
                'USERNAME_REQUIRED',
                'FULL_NAME_REQUIRED',
                'PASSWORD_TOO_SHORT',
                'STORE_NAME_REQUIRED',
                'INVALID_ROLE'
            ].includes(code)
        ) {
            err.statusCode = 400;
        }

        return err;
    }
}

module.exports =
    RegistrationService;
