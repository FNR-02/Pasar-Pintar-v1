const express = require('express');
const app = express();
app.use(express.json());

app.post('/api/copilot/ask', (req, res) => {
    res.json({ status: "success", answer: "Respon berhasil diterima!" });
});

app.listen(3001, () => {
    console.log('Test server berjalan di port 3001');
});
