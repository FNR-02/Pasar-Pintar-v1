class OnboardingReviewService {
    constructor(pool) {
        this.pool = pool;
    }

    async decide({
        applicationId,
        decision,
        notes = null,
        reviewerId
    }) {
        const normalizedDecision =
            String(decision || '')
                .trim()
                .toUpperCase();

        if (
            ![
                'APPROVE',
                'REJECT'
            ].includes(normalizedDecision)
        ) {
            const err =
                new Error(
                    'decision harus APPROVE atau REJECT'
                );

            err.code =
                'INVALID_ONBOARDING_DECISION';

            err.statusCode =
                400;

            throw err;
        }

        const client =
            await this.pool.connect();

        try {
            await client.query('BEGIN');

            const applicationResult =
                await client.query(
                    `
                    SELECT
                        a.*,
                        u.role_id AS user_role_id,
                        u.is_active
                    FROM tbl_onboarding_applications a
                    JOIN tbl_users u
                        ON u.id = a.user_id
                    WHERE a.id = $1
                    FOR UPDATE
                    `,
                    [
                        applicationId
                    ]
                );

            if (!applicationResult.rowCount) {
                const err =
                    new Error(
                        'Application onboarding tidak ditemukan'
                    );

                err.code =
                    'ONBOARDING_APPLICATION_NOT_FOUND';

                err.statusCode =
                    404;

                throw err;
            }

            const application =
                applicationResult.rows[0];

            if (
                ![
                    2,
                    3
                ].includes(
                    Number(application.role_id)
                )
            ) {
                const err =
                    new Error(
                        'Role onboarding ini tidak memerlukan approval Admin'
                    );

                err.code =
                    'ONBOARDING_ROLE_NOT_REVIEWABLE';

                err.statusCode =
                    409;

                throw err;
            }

            if (
                Number(application.role_id) !==
                Number(application.user_role_id)
            ) {
                throw new Error(
                    'Role application tidak konsisten dengan User'
                );
            }

            const targetStatus =
                normalizedDecision === 'APPROVE'
                    ? 'APPROVED'
                    : 'REJECTED';

            if (
                application.application_status ===
                targetStatus
            ) {
                await client.query('COMMIT');

                return {
                    status:
                        'already_reviewed',
                    application
                };
            }

            if (
                application.application_status !==
                'PENDING'
            ) {
                const err =
                    new Error(
                        `Application sudah berstatus ${application.application_status}`
                    );

                err.code =
                    'ONBOARDING_ALREADY_REVIEWED';

                err.statusCode =
                    409;

                throw err;
            }

            if (
                normalizedDecision ===
                'APPROVE'
            ) {
                await this.approveProfile(
                    client,
                    application,
                    reviewerId
                );

                const userResult =
                    await client.query(
                        `
                        UPDATE tbl_users
                        SET
                            is_active = TRUE,
                            updated_at = CURRENT_TIMESTAMP
                        WHERE id = $1
                          AND is_active = FALSE
                        RETURNING id
                        `,
                        [
                            application.user_id
                        ]
                    );

                if (
                    userResult.rowCount !==
                    1
                ) {
                    throw new Error(
                        'User pending gagal diaktifkan'
                    );
                }
            } else {
                await this.rejectProfile(
                    client,
                    application,
                    notes
                );

                await client.query(
                    `
                    UPDATE tbl_users
                    SET
                        is_active = FALSE,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE id = $1
                    `,
                    [
                        application.user_id
                    ]
                );
            }

            const finalResult =
                await client.query(
                    `
                    UPDATE tbl_onboarding_applications
                    SET
                        application_status = $2,
                        reviewed_at = CURRENT_TIMESTAMP,
                        reviewed_by = $3,
                        review_notes = $4,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE id = $1
                      AND application_status = 'PENDING'
                    RETURNING *
                    `,
                    [
                        application.id,
                        targetStatus,
                        reviewerId,
                        notes
                    ]
                );

            if (
                finalResult.rowCount !==
                1
            ) {
                throw new Error(
                    'Application berubah secara bersamaan'
                );
            }

            await client.query('COMMIT');

            return {
                status:
                    targetStatus,
                application:
                    finalResult.rows[0]
            };

        } catch (err) {
            try {
                await client.query('ROLLBACK');
            } catch (_) {}

            throw err;

        } finally {
            client.release();
        }
    }

    async approveProfile(
        client,
        application,
        reviewerId
    ) {
        const table =
            Number(application.role_id) === 2
                ? 'tbl_merchants'
                : 'tbl_couriers';

        const result =
            await client.query(
                `
                UPDATE ${table}
                SET
                    status = 'ACTIVE',
                    approved_at = CURRENT_TIMESTAMP,
                    approved_by = $2,
                    rejected_at = NULL,
                    rejection_reason = NULL
                    ${
                        table === 'tbl_couriers'
                            ? ', updated_at = CURRENT_TIMESTAMP'
                            : ''
                    }
                WHERE user_id = $1
                  AND status = 'PENDING'
                RETURNING id
                `,
                [
                    application.user_id,
                    reviewerId
                ]
            );

        if (result.rowCount !== 1) {
            throw new Error(
                'Profile PENDING tidak ditemukan untuk approval'
            );
        }
    }

    async rejectProfile(
        client,
        application,
        notes
    ) {
        const table =
            Number(application.role_id) === 2
                ? 'tbl_merchants'
                : 'tbl_couriers';

        const result =
            await client.query(
                `
                UPDATE ${table}
                SET
                    status = 'REJECTED',
                    rejected_at = CURRENT_TIMESTAMP,
                    rejection_reason = $2,
                    approved_at = NULL,
                    approved_by = NULL
                    ${
                        table === 'tbl_couriers'
                            ? ', updated_at = CURRENT_TIMESTAMP'
                            : ''
                    }
                WHERE user_id = $1
                  AND status = 'PENDING'
                RETURNING id
                `,
                [
                    application.user_id,
                    notes
                ]
            );

        if (result.rowCount !== 1) {
            throw new Error(
                'Profile PENDING tidak ditemukan untuk rejection'
            );
        }
    }
}

module.exports =
    OnboardingReviewService;
