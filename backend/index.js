// Backend untuk menyimpan data pendampingan ke Google Sheets
// - Lokal:  npm start  → Express di http://localhost:3001
// - Vercel: api/submit.js dipetakan otomatis ke POST /api/submit
const express = require('express');
const cors = require('cors');
try {
  require('dotenv').config();
} catch (e) {
  // dotenv tidak tersedia (Vercel) — abaikan
}

const submitHandler = require('./api/submit');

const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json());

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Backend Pendampingan Keluarga TPK',
    endpoint: 'POST /api/submit',
  });
});

app.post('/api/submit', submitHandler);

const PORT = process.env.PORT || 3001;
if (require.main === module) {
  app.listen(PORT, () => console.log(`Server jalan di http://localhost:${PORT}`));
}

module.exports = app;