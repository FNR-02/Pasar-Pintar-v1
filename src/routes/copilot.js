const express = require('express');
const router = express.Router();
const CopilotEngine = require('../brain/CopilotEngine');
const { verifyToken, requireRole } = require('../middleware/auth');

router.post('/copilot/ask', verifyToken, requireRole(4), async (req, res) => {
    try {
        const { question } = req.body;
        const result = await CopilotEngine.ask(question);
        res.json({ status: 'success', question, ...result });
    } catch (err) {
        console.error('[COPILOT ERROR]', err.message);
        res.status(500).json({ status: 'error', error: err.message });
    }
});

module.exports = router;
