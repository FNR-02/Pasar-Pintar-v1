require('dotenv').config();
const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Root endpoint
app.get('/', (req, res) => {
    res.json({
        message: "Selamat datang di API Pasar Pintar 🚀",
        ecosystem: "Menghubungkan pedagang, supplier, distributor, kurir, dan pelanggan",
        version: "1.0.0"
    });
});

// Mock Auth & Core Routes Placeholder
app.post('/api/auth/register', (req, res) => {
    const { name, email, role } = req.body;
    res.status(201).json({ message: `Registrasi berhasil untuk ${role}: ${name} (${email})` });
});

app.listen(PORT, () => {
    console.log(`Server Pasar Pintar berjalan di port ${PORT}`);
});