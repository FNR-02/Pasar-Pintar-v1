const express = require('express');

const {
    verifyToken,
    requireRole
} = require('../middleware/auth');

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


module.exports =
    router;
