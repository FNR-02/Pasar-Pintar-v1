const express = require('express');

const {
    verifyToken,
    requireRole
} = require('../middleware/auth');

const RegistrationService =
    require(
        '../services/onboarding/RegistrationService'
    );

const OnboardingReviewService =
    require(
        '../services/onboarding/OnboardingReviewService'
    );

module.exports = function(
    pool,
    CommerceKernel
) {
    const router =
        express.Router();

    const registrationService =
        new RegistrationService(
            pool
        );

    const onboardingReviewService =
        new OnboardingReviewService(
            pool
        );

    function registrationError(
        err,
        res
    ) {
        console.error(
            '[ONBOARDING REGISTER]',
            err.message
        );

        return res
            .status(
                err.statusCode ||
                500
            )
            .json({
                status:
                    'error',
                code:
                    err.code ||
                    'REGISTRATION_FAILED',
                error:
                    err.message
            });
    }

    /*
     * =========================================================
     * CUSTOMER REGISTRATION
     *
     * Customer langsung ACTIVE.
     * =========================================================
     */
    router.post(
        '/onboarding/register/customer',
        async (req, res) => {
            try {
                const result =
                    await registrationService
                        .registerCustomer({
                            username:
                                req.body.username,
                            email:
                                req.body.email,
                            password:
                                req.body.password,
                            fullName:
                                req.body.full_name ||
                                req.body.name,
                            phone:
                                req.body.phone
                        });

                CommerceKernel.emitEvent(
                    'USER_REGISTERED',
                    'USER',
                    result.user.id,
                    {
                        userId:
                            result.user.id,
                        role_id:
                            result.user.role_id,
                        onboarding_status:
                            result.status,
                        actor:
                            result.user.username
                    }
                );

                return res
                    .status(201)
                    .json({
                        status:
                            'success',
                        onboarding_status:
                            result.status,
                        user:
                            result.user,
                        customer:
                            result.profile
                    });

            } catch (err) {
                return registrationError(
                    err,
                    res
                );
            }
        }
    );

    /*
     * =========================================================
     * MERCHANT / SELLER REGISTRATION
     *
     * User dibuat INACTIVE.
     * Merchant PENDING.
     * Application PENDING.
     * =========================================================
     */
    router.post(
        '/onboarding/register/merchant',
        async (req, res) => {
            try {
                const result =
                    await registrationService
                        .registerMerchant({
                            username:
                                req.body.username,
                            email:
                                req.body.email,
                            password:
                                req.body.password,
                            fullName:
                                req.body.full_name ||
                                req.body.name,
                            phone:
                                req.body.phone,
                            storeName:
                                req.body.store_name,
                            address:
                                req.body.address
                        });

                CommerceKernel.emitEvent(
                    'ONBOARDING_APPLICATION_SUBMITTED',
                    'USER',
                    result.user.id,
                    {
                        userId:
                            result.user.id,
                        role_id:
                            result.user.role_id,
                        application_id:
                            result.application
                                ?.id || null,
                        application_status:
                            result.application
                                ?.application_status ||
                            'PENDING',
                        actor:
                            result.user.username
                    }
                );

                return res
                    .status(201)
                    .json({
                        status:
                            'success',
                        onboarding_status:
                            result.status,
                        message:
                            'Pendaftaran Seller berhasil. Menunggu persetujuan Admin.',
                        user:
                            result.user,
                        merchant:
                            result.profile,
                        application:
                            result.application
                    });

            } catch (err) {
                return registrationError(
                    err,
                    res
                );
            }
        }
    );

    /*
     * =========================================================
     * COURIER REGISTRATION
     *
     * User dibuat INACTIVE.
     * Courier PENDING.
     * Application PENDING.
     * =========================================================
     */
    router.post(
        '/onboarding/register/courier',
        async (req, res) => {
            try {
                const result =
                    await registrationService
                        .registerCourier({
                            username:
                                req.body.username,
                            email:
                                req.body.email,
                            password:
                                req.body.password,
                            fullName:
                                req.body.full_name ||
                                req.body.name,
                            phone:
                                req.body.phone,
                            vehicleType:
                                req.body.vehicle_type,
                            vehiclePlate:
                                req.body.vehicle_plate
                        });

                CommerceKernel.emitEvent(
                    'ONBOARDING_APPLICATION_SUBMITTED',
                    'USER',
                    result.user.id,
                    {
                        userId:
                            result.user.id,
                        role_id:
                            result.user.role_id,
                        application_id:
                            result.application
                                ?.id || null,
                        application_status:
                            result.application
                                ?.application_status ||
                            'PENDING',
                        actor:
                            result.user.username
                    }
                );

                return res
                    .status(201)
                    .json({
                        status:
                            'success',
                        onboarding_status:
                            result.status,
                        message:
                            'Pendaftaran Kurir berhasil. Menunggu persetujuan Admin.',
                        user:
                            result.user,
                        courier:
                            result.profile,
                        application:
                            result.application
                    });

            } catch (err) {
                return registrationError(
                    err,
                    res
                );
            }
        }
    );


    /*
     * =========================================================
     * ADMIN — LIST ONBOARDING APPLICATIONS
     *
     * Admin melihat Merchant / Courier yang menunggu review.
     *
     * Optional query:
     * ?status=PENDING
     * ?status=APPROVED
     * ?status=REJECTED
     * =========================================================
     */
    router.get(
        '/admin/onboarding/applications',
        verifyToken,
        requireRole(4),
        async (req, res) => {
            try {
                const requestedStatus =
                    String(
                        req.query.status ||
                        'PENDING'
                    )
                        .trim()
                        .toUpperCase();

                const allowedStatuses = [
                    'PENDING',
                    'APPROVED',
                    'REJECTED'
                ];

                if (
                    !allowedStatuses.includes(
                        requestedStatus
                    )
                ) {
                    return res
                        .status(400)
                        .json({
                            status:
                                'error',
                            code:
                                'INVALID_APPLICATION_STATUS',
                            error:
                                'Status onboarding harus PENDING, APPROVED, atau REJECTED'
                        });
                }

                const result =
                    await pool.query(
                        `
                        SELECT
                            a.id
                                AS application_id,

                            a.application_status,
                            a.submitted_at,
                            a.reviewed_at,
                            a.reviewed_by,
                            a.review_notes,

                            u.id
                                AS user_id,
                            u.username,
                            u.email,
                            u.nama_lengkap,
                            u.role_id,
                            u.is_active,

                            r.role_name,

                            m.id
                                AS merchant_id,
                            m.store_name,
                            m.address
                                AS merchant_address,
                            m.phone
                                AS merchant_phone,
                            m.status
                                AS merchant_status,

                            c.id
                                AS courier_id,
                            c.full_name
                                AS courier_full_name,
                            c.phone
                                AS courier_phone,
                            c.vehicle_type,
                            c.vehicle_plate,
                            c.status
                                AS courier_status

                        FROM
                            tbl_onboarding_applications a

                        JOIN tbl_users u
                            ON u.id =
                                a.user_id

                        JOIN tbl_roles r
                            ON r.id =
                                a.role_id

                        LEFT JOIN tbl_merchants m
                            ON
                                a.role_id = 2
                                AND
                                m.user_id =
                                    a.user_id

                        LEFT JOIN tbl_couriers c
                            ON
                                a.role_id = 3
                                AND
                                c.user_id =
                                    a.user_id

                        WHERE
                            a.application_status =
                                $1

                        ORDER BY
                            a.submitted_at ASC,
                            a.id ASC
                        `,
                        [
                            requestedStatus
                        ]
                    );

                return res.json({
                    status:
                        'success',
                    application_status:
                        requestedStatus,
                    count:
                        result.rowCount,
                    applications:
                        result.rows
                });

            } catch (err) {
                console.error(
                    '[ADMIN ONBOARDING LIST]',
                    err.message
                );

                return res
                    .status(500)
                    .json({
                        status:
                            'error',
                        code:
                            'ADMIN_ONBOARDING_LIST_FAILED',
                        error:
                            err.message
                    });
            }
        }
    );


    /*
     * =========================================================
     * ADMIN — APPROVE / REJECT ONBOARDING
     * =========================================================
     */
    router.post(
        '/admin/onboarding/applications/:id/decision',
        verifyToken,
        requireRole(4),
        async (req, res) => {
            try {
                const result =
                    await onboardingReviewService
                        .decide({
                            applicationId:
                                req.params.id,

                            decision:
                                req.body.decision,

                            notes:
                                req.body.notes ||
                                null,

                            reviewerId:
                                req.user.id
                        });

                /*
                 * Idempotent terminal replay.
                 */
                if (
                    result.status ===
                    'already_reviewed'
                ) {
                    return res.json({
                        status:
                            'success',

                        already_reviewed:
                            true,

                        application:
                            result.application
                    });
                }

                /*
                 * Event diterbitkan setelah service
                 * berhasil COMMIT.
                 */
                CommerceKernel.emitEvent(
                    result.status ===
                    'APPROVED'
                        ? 'ONBOARDING_APPLICATION_APPROVED'
                        : 'ONBOARDING_APPLICATION_REJECTED',

                    'USER',

                    result.application
                        .user_id,

                    {
                        applicationId:
                            result.application.id,

                        userId:
                            result.application
                                .user_id,

                        role_id:
                            result.application
                                .role_id,

                        application_status:
                            result.application
                                .application_status,

                        reviewed_by:
                            req.user.id,

                        actor:
                            req.user.username,

                        review_notes:
                            result.application
                                .review_notes
                    }
                );

                return res.json({
                    status:
                        'success',

                    message:
                        result.status ===
                        'APPROVED'
                            ? 'Pendaftaran berhasil disetujui'
                            : 'Pendaftaran ditolak',

                    application:
                        result.application
                });

            } catch (err) {
                console.error(
                    '[ADMIN ONBOARDING DECISION]',
                    err.message
                );

                return res
                    .status(
                        err.statusCode ||
                        500
                    )
                    .json({
                        status:
                            'error',

                        code:
                            err.code ||
                            'ONBOARDING_DECISION_FAILED',

                        error:
                            err.message
                    });
            }
        }
    );

    return router;
};
