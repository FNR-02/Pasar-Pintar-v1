const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;

function verifyToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({
            error: "Token akses tidak ditemukan"
        });
    }

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({
                error: "Token tidak valid atau kedaluwarsa"
            });
        }

        req.user = user;
        next();
    });
}

function requireRole(...allowedRoles) {
    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({
                error: "Authentication diperlukan"
            });
        }

        const userRoleId = Number(req.user.role_id);

        if (!allowedRoles.includes(userRoleId)) {
            return res.status(403).json({
                error: "Akses ditolak",
                message: "Role tidak memiliki izin untuk mengakses resource ini"
            });
        }

        next();
    };
}

module.exports = verifyToken;
module.exports.verifyToken = verifyToken;
module.exports.requireRole = requireRole;
