const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;

module.exports = (pool, CommerceKernel) => {

    // 1. Endpoint Pendaftaran Akun (Multi-Role)
    router.post('/register', async (req, res) => {
        const { name, email, password } = req.body;
        const role_id = 1; // Public registration selalu Customer
        try {
            // Menentukan username otomatis dari email jika tidak diisi terpisah
            const username = email ? email.split('@')[0] : name.toLowerCase().replace(/\s+/g, '_');
            const saltRounds = 10;
            const password_hash = await bcrypt.hash(password, saltRounds);
            
            // Simpan ke database tbl_users
            const result = await pool.query(
                `INSERT INTO tbl_users (username, email, password_hash, role_id) 
                 VALUES ($1, $2, $3, $4) RETURNING id, username, email, role_id`,
                [username, email, password_hash, role_id]
            );

            const newUser = result.rows[0];
            CommerceKernel.emitEvent(
    'USER_REGISTERED',
    'USER',
    newUser.id,
    {
        userId: newUser.id,
        username: newUser.username,
        actor: username
    }
);
            
            res.status(201).json({ status: "success", user: newUser });
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: "Gagal mendaftarkan akun: " + err.message });
        }
    });

    // 2. Endpoint Login Ekosistem
    router.post('/login', async (req, res) => {
        const { username, password } = req.body;
        try {
            const userResult = await pool.query(`SELECT * FROM tbl_users WHERE username = $1`, [username]);
            if (userResult.rows.length === 0) {
                return res.status(401).json({ error: "User tidak ditemukan" });
            }

            const user = userResult.rows[0];
            const match = await bcrypt.compare(password, user.password_hash);
            if (!match) {
                return res.status(401).json({ error: "Password salah" });
            }

            const token = jwt.sign(
                { id: user.id, username: user.username, role_id: user.role_id }, 
                JWT_SECRET, 
                { expiresIn: '12h' }
            );
            
            CommerceKernel.emitEvent(
    'USER_LOGGED_IN',
    'USER',
    user.id,
    {
        userId: user.id,
        username: user.username,
        actor: user.username,
        ip: req.ip
    }
);
            res.json({ status: "success", token, role_id: user.role_id });
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: err.message });
        }
    });

    return router;
};
