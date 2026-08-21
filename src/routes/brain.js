const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const RecommendationEngine = require('../brain/RecommendationEngine');
const GraphQuery = require('../brain/GraphQuery');
const { verifyToken, requireRole } = require('../middleware/auth');

// Endpoint melihat jaringan Knowledge Graph
router.get('/brain/knowledge-graph', verifyToken, requireRole(4), async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT * FROM tbl_knowledge_graph ORDER BY weight DESC LIMIT 50`
        );
        res.json({
            status: "success",
            engine: "Commerce Brain - Knowledge Graph v2.0",
            total_nodes: result.rowCount,
            relations: result.rows
        });
    } catch (err) {
        console.error("Gagal memuat knowledge graph:", err);
        res.status(500).json({ error: err.message });
    }
});
// Endpoint Customer Intelligence
router.get('/brain/customer/:id', verifyToken, requireRole(4), async (req, res) => {
    try {
        const customerId = req.params.id;

        const insight = await GraphQuery.getCustomerInsights(
            customerId
        );

        res.json({
            status: "success",
            engine: "Commerce Brain - Customer Intelligence v1.0",
            data: insight
        });

    } catch (err) {
        console.error(
            "[BRAIN CUSTOMER ERROR]",
            err.message
        );

        res.status(500).json({
            error: err.message
        });
    }
});
router.get("/brain/customer/:id/recommendations", verifyToken, requireRole(4), async (req, res) => {
    try {
        const data = await RecommendationEngine.getRecommendations(req.params.id);
        res.json({
            status: "success",
            engine: "Commerce Brain - Recommendation Engine v1.0",
            data
        });
    } catch (err) {
        console.error("[RECOMMENDATION ERROR]", err.message);
        res.status(500).json({
            status: "error",
            message: err.message
        });
    }
});

module.exports = router;
