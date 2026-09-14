const express = require('express');

const {
    verifyToken,
    requireRole
} = require('../middleware/auth');

const CommerceKernel = require('../kernel/EventKernel');
const pool =
    require('../config/db');

const MarketCollectorService =
    require(
        '../services/marketplace/MarketCollectorService'
    );

const router =
    express.Router();

const collectorService =
    new MarketCollectorService(pool);



/*
 * Courier melihat Collector Task tersedia
 * dan task yang sudah menjadi miliknya.
 */
router.get(
    '/collector-marketplace/v1/tasks',
    verifyToken,
    requireRole(3),
    async (req, res) => {
        try {
            const result =
                await collectorService.listTasksForCourier(
                    req.user.id
                );

            return res.json({
                status: 'success',
                ...result
            });
        } catch (err) {
            console.error(
                '[COLLECTOR LIST V1]',
                err.message
            );

            return res
                .status(
                    err.statusCode || 500
                )
                .json({
                    error:
                        err.message
                });
        }
    }
);

/*
 * Courier mengambil Collector Task yang masih PENDING.
 */
router.post(
    '/collector-marketplace/v1/tasks/:taskId/assign',
    verifyToken,
    requireRole(3),
    async (req, res) => {
        try {
            const result =
                await collectorService.assignTask({
                    taskId:
                        req.params.taskId,
                    courierUserId:
                        req.user.id
                });

            if (!result.already_assigned) {
                CommerceKernel.emitEvent(
                    'COLLECTOR_TASK_ASSIGNED',
                    'COLLECTOR_TASK',
                    result.task.id,
                    {
                        collectorTaskId: result.task.id,
                        marketOrderId:
                            result.task.market_order_id,
                        courierUserId: req.user.id,
                        actor: req.user.username
                    }
                );
            }

            return res.json({
                status: 'success',
                ...result
            });

        } catch (err) {
            console.error(
                '[COLLECTOR ASSIGN V1]',
                err.message
            );

            return res
                .status(
                    err.statusCode || 400
                )
                .json({
                    error:
                        err.message
                });
        }
    }
);


/*
 * Courier mulai proses pengambilan dari para Merchant.
 */
router.post(
    '/collector-marketplace/v1/tasks/:taskId/start',
    verifyToken,
    requireRole(3),
    async (req, res) => {
        try {
            const result =
                await collectorService.startCollection({
                    taskId:
                        req.params.taskId,
                    courierUserId:
                        req.user.id
                });

            if (!result.already_started) {
                CommerceKernel.emitEvent(
                    'COLLECTION_STARTED',
                    'COLLECTOR_TASK',
                    result.task.id,
                    {
                        collectorTaskId: result.task.id,
                        marketOrderId:
                            result.task.market_order_id,
                        courierUserId: req.user.id,
                        actor: req.user.username
                    }
                );
            }

            return res.json({
                status: 'success',
                ...result
            });

        } catch (err) {
            console.error(
                '[COLLECTOR START V1]',
                err.message
            );

            return res
                .status(
                    err.statusCode || 400
                )
                .json({
                    error:
                        err.message
                });
        }
    }
);


/*
 * Courier tiba di Merchant.
 *
 * Stop harus READY.
 */
router.post(
    '/collector-marketplace/v1/stops/:stopId/arrive',
    verifyToken,
    requireRole(3),
    async (req, res) => {
        try {
            const result =
                await collectorService.arriveAtStop({
                    stopId:
                        req.params.stopId,
                    courierUserId:
                        req.user.id
                });

            if (!result.already_arrived) {
                CommerceKernel.emitEvent(
                    'COLLECTOR_STOP_ARRIVED',
                    'COLLECTOR_STOP',
                    result.stop.id,
                    {
                        collectorStopId: result.stop.id,
                        collectorTaskId:
                            result.stop.collector_task_id,
                        marketOrderId:
                            result.stop.market_order_id,
                        orderId:
                            result.stop.order_id,
                        courierUserId: req.user.id,
                        actor: req.user.username
                    }
                );
            }

            return res.json({
                status: 'success',
                ...result
            });

        } catch (err) {
            console.error(
                '[COLLECTOR ARRIVE V1]',
                err.message
            );

            return res
                .status(
                    err.statusCode || 400
                )
                .json({
                    error:
                        err.message
                });
        }
    }
);


/*
 * Courier benar-benar mengambil barang.
 *
 * ARRIVED -> PICKED_UP
 * Child order:
 * PACKING -> DISPATCHED
 *
 * Tidak membuat tbl_shipments.
 */
router.post(
    '/collector-marketplace/v1/stops/:stopId/pickup',
    verifyToken,
    requireRole(3),
    async (req, res) => {
        try {
            const result =
                await collectorService.pickupStop({
                    stopId:
                        req.params.stopId,
                    courierUserId:
                        req.user.id
                });

            if (!result.already_picked_up) {
                CommerceKernel.emitEvent(
                    'COLLECTOR_STOP_PICKED_UP',
                    'COLLECTOR_STOP',
                    result.stop.id,
                    {
                        collectorStopId: result.stop.id,
                        collectorTaskId:
                            result.stop.collector_task_id,
                        marketOrderId:
                            result.order.market_order_id,
                        orderId: result.order.id,
                        courierUserId: req.user.id,
                        actor: req.user.username
                    }
                );

                if (
                    result.collection_completed &&
                    result.market_order
                ) {
                    CommerceKernel.emitEvent(
                        'MARKET_ORDER_READY_FOR_DELIVERY',
                        'MARKET_ORDER',
                        result.market_order.id,
                        {
                            marketOrderId:
                                result.market_order.id,
                            collectorTaskId:
                                result.task.id,
                            courierUserId:
                                req.user.id,
                            actor:
                                req.user.username
                        }
                    );
                }
            }

            return res.json({
                status: 'success',
                ...result
            });

        } catch (err) {
            console.error(
                '[COLLECTOR PICKUP V1]',
                err.message
            );

            return res
                .status(
                    err.statusCode || 400
                )
                .json({
                    error:
                        err.message
                });
        }
    }
);



/*
 * Courier mulai mengantar gabungan order
 * ke Customer.
 *
 * Task:
 * COLLECTED -> OUT_FOR_DELIVERY
 *
 * Market:
 * READY_FOR_DELIVERY -> OUT_FOR_DELIVERY
 */
router.post(
    '/collector-marketplace/v1/tasks/:taskId/start-delivery',
    verifyToken,
    requireRole(3),
    async (req, res) => {
        try {
            const result =
                await collectorService.startDelivery({
                    taskId:
                        req.params.taskId,
                    courierUserId:
                        req.user.id
                });

            if (!result.already_started) {
                CommerceKernel.emitEvent(
                    'MARKET_ORDER_OUT_FOR_DELIVERY',
                    'MARKET_ORDER',
                    result.market_order.id,
                    {
                        marketOrderId:
                            result.market_order.id,
                        collectorTaskId:
                            result.task.id,
                        courierUserId:
                            req.user.id,
                        actor:
                            req.user.username
                    }
                );
            }

            return res.json({
                status: 'success',
                ...result
            });
        } catch (err) {
            console.error(
                '[COLLECTOR START DELIVERY V1]',
                err.message
            );

            return res
                .status(
                    err.statusCode || 400
                )
                .json({
                    error:
                        err.message
                });
        }
    }
);

/*
 * Courier menerima pembayaran tunai COD
 * dari Customer.
 */
router.post(
    '/collector-marketplace/v1/tasks/:taskId/collect-cod-payment',
    verifyToken,
    requireRole(3),
    async (req, res) => {
        try {
            const result =
                await collectorService.collectCodPayment({
                    taskId:
                        req.params.taskId,
                    courierUserId:
                        req.user.id
                });

            if (!result.already_collected) {
                CommerceKernel.emitEvent(
                    'MARKET_COD_PAYMENT_COLLECTED',
                    'MARKET_PAYMENT',
                    result.payment.id,
                    {
                        marketPaymentId:
                            result.payment.id,
                        marketOrderId:
                            result.market_order.id,
                        collectorTaskId:
                            result.task.id,
                        amount:
                            result.payment.amount,
                        courierUserId:
                            req.user.id,
                        actor:
                            req.user.username
                    }
                );
            }

            return res.json({
                status: 'success',
                ...result
            });

        } catch (err) {
            console.error(
                '[COLLECTOR COD PAYMENT V1]',
                err.message
            );

            return res
                .status(
                    err.statusCode || 400
                )
                .json({
                    error:
                        err.message,
                    code:
                        err.code || null
                });
        }
    }
);

/*
 * Customer gagal menerima / membayar COD.
 *
 * Task:
 * OUT_FOR_DELIVERY -> RETURNING
 *
 * Market:
 * OUT_FOR_DELIVERY -> RETURNING
 *
 * Inventory belum dikembalikan pada tahap ini.
 */
router.post(
    '/collector-marketplace/v1/tasks/:taskId/mark-cod-delivery-failed',
    verifyToken,
    requireRole(3),
    async (req, res) => {
        try {
            const result =
                await collectorService.markCodDeliveryFailed({
                    taskId:
                        req.params.taskId,
                    courierUserId:
                        req.user.id,
                    reason:
                        req.body?.reason
                });

            if (!result.already_marked) {
                CommerceKernel.emitEvent(
                    'MARKET_COD_DELIVERY_FAILED',
                    'MARKET_ORDER',
                    result.market_order.id,
                    {
                        marketOrderId:
                            result.market_order.id,
                        collectorTaskId:
                            result.task.id,
                        marketPaymentId:
                            result.payment.id,
                        reason:
                            result.reason,
                        courierUserId:
                            req.user.id,
                        actor:
                            req.user.username
                    }
                );
            }

            return res.json({
                status: 'success',
                ...result
            });

        } catch (err) {
            console.error(
                '[COLLECTOR COD DELIVERY FAILED V1]',
                err.message
            );

            return res
                .status(
                    err.statusCode || 400
                )
                .json({
                    error:
                        err.message,
                    code:
                        err.code || null
                });
        }
    }
);


/*
 * Barang COD gagal kirim telah kembali.
 *
 * Child:
 * DISPATCHED -> RETURNED
 *
 * Stop:
 * PICKED_UP -> RETURNED
 *
 * Task / Market:
 * RETURNING -> RETURNED
 *
 * Payment:
 * UNPAID -> CANCELLED
 */
router.post(
    '/collector-marketplace/v1/tasks/:taskId/complete-cod-return',
    verifyToken,
    requireRole(3),
    async (req, res) => {
        try {
            const result =
                await collectorService.completeCodReturn({
                    taskId:
                        req.params.taskId,
                    courierUserId:
                        req.user.id
                });

            if (!result.already_completed) {
                CommerceKernel.emitEvent(
                    'MARKET_COD_RETURN_COMPLETED',
                    'MARKET_ORDER',
                    result.market_order.id,
                    {
                        marketOrderId:
                            result.market_order.id,
                        collectorTaskId:
                            result.task.id,
                        marketPaymentId:
                            result.payment.id,
                        orderIds:
                            result.orders.map(
                                order => order.id
                            ),
                        courierUserId:
                            req.user.id,
                        actor:
                            req.user.username
                    }
                );
            }

            return res.json({
                status: 'success',
                ...result
            });

        } catch (err) {
            console.error(
                '[COLLECTOR COD RETURN COMPLETE V1]',
                err.message
            );

            return res
                .status(
                    err.statusCode || 400
                )
                .json({
                    error:
                        err.message,
                    code:
                        err.code || null
                });
        }
    }
);


/*
 * Courier menyelesaikan pengiriman gabungan
 * ke Customer.
 *
 * Task:
 * OUT_FOR_DELIVERY -> COMPLETED
 *
 * Market:
 * OUT_FOR_DELIVERY -> DELIVERED
 *
 * Child:
 * DISPATCHED -> DELIVERED
 */
router.post(
    '/collector-marketplace/v1/tasks/:taskId/complete-delivery',
    verifyToken,
    requireRole(3),
    async (req, res) => {
        try {
            const result =
                await collectorService.completeDelivery({
                    taskId:
                        req.params.taskId,
                    courierUserId:
                        req.user.id
                });

            if (!result.already_completed) {
                CommerceKernel.emitEvent(
                    'MARKET_ORDER_DELIVERED',
                    'MARKET_ORDER',
                    result.market_order.id,
                    {
                        marketOrderId:
                            result.market_order.id,
                        collectorTaskId:
                            result.task.id,
                        orderIds:
                            result.orders.map(
                                order => order.id
                            ),
                        courierUserId:
                            req.user.id,
                        actor:
                            req.user.username
                    }
                );
            }

            return res.json({
                status: 'success',
                ...result
            });
        } catch (err) {
            console.error(
                '[COLLECTOR COMPLETE DELIVERY V1]',
                err.message
            );

            return res
                .status(
                    err.statusCode || 400
                )
                .json({
                    error:
                        err.message
                });
        }
    }
);

module.exports =
    router;
