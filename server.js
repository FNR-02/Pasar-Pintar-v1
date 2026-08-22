require('dotenv').config();
const express = require('express');
const pool = require('./src/config/db');

// Import Semua Modul Rute
const authRoutes = require('./src/routes/auth');
const merchantRoutes = require('./src/routes/merchant');
const merchantOrdersV2Routes = require('./src/routes/merchantOrdersV2');
const merchantSalesV2Routes = require('./src/routes/merchantSalesV2');
const merchantAccountV2Routes = require('./src/routes/merchantAccountV2');
const courierRoutes = require('./src/routes/courier');
const financeRoutes = require('./src/routes/finance');
const warehouseRoutes = require('./src/routes/warehouse');
const aiEngineRoutes = require('./src/routes/aiEngine');
const crmRoutes = require('./src/routes/crm');
const brainRoutes = require('./src/routes/brain');
const copilotRoutes = require('./src/routes/copilot');
const agentRoutes = require('./src/routes/agents');
const purchaseOrderRoutes = require('./src/routes/purchaseOrders');
const orderRoutes = require('./src/routes/orders');
const purchaseOrderApprovalRoutes = require('./src/routes/purchaseOrderApproval');
const checkoutV2Routes = require('./src/routes/checkoutV2');
const paymentV2Routes = require('./src/routes/paymentV2');
const purchaseOrderReceivingRoutes = require('./src/routes/purchaseOrderReceiving');
const evolutionWebhookRoutes =
    require('./src/routes/evolutionWebhook');

const app = express();
app.use(express.json());
app.use(express.static('public'));


// Inisialisasi Kernel Enterprise
const CommerceKernel = require('./src/kernel/EventKernel');
require('./src/kernel/productSubscribers');
require('./src/kernel/inventorySubscribers');
require('./src/kernel/orderSubscribers');
require('./src/kernel/financeSubscribers');
require('./src/kernel/warehouseSubscribers');
require('./src/kernel/crmSubscribers');
require('./src/kernel/purchaseOrderSubscribers');
require('./src/brain/GraphBuilder');
require('./src/brain/agents/InventoryAgent');

// Daftarkan Semua Rute Modular
app.use('/api', authRoutes(pool, CommerceKernel));
app.use('/api', merchantRoutes(pool, CommerceKernel));
app.use('/api', merchantOrdersV2Routes);
app.use('/api', merchantSalesV2Routes);
app.use('/api', merchantAccountV2Routes);
app.use('/api', courierRoutes(pool, CommerceKernel));
app.use('/api', financeRoutes);
app.use('/api', warehouseRoutes);
app.use('/api', aiEngineRoutes(pool, CommerceKernel));
app.use('/api', crmRoutes);
app.use('/api', brainRoutes);
app.use('/api', copilotRoutes);
app.use('/api', purchaseOrderReceivingRoutes);
app.use('/api', purchaseOrderApprovalRoutes);
app.use('/api', purchaseOrderRoutes);
app.use('/api', checkoutV2Routes);
app.use('/api', paymentV2Routes);
app.use('/api', orderRoutes);
app.use('/api', agentRoutes);
app.use(
    '/api',
    evolutionWebhookRoutes(pool, CommerceKernel)
);


// Health Check Bootstrap
app.get('/api/health', (req, res) => {
    res.json({
        status: "success",
        kernel: "online",
        activeEvents: CommerceKernel.eventNames(),
        auditCount: CommerceKernel.auditLogs.length
    });
});

// Jalankan Server
app.use((req, res) => {
    res.status(404).json({ status: "error", message: "Endpoint tidak ditemukan" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server Pasar Pintar berjalan di port ${PORT}`);
});
