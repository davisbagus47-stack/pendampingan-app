const express = require('express');
const { google } = require('googleapis');
const cors = require('cors');
try {
  require('dotenv').config();
} catch (e) {}

const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json());

const getCredentials = () => {
  if (process.env.GOOGLE_CREDENTIALS_JSON) {
    return JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
  }
  return require('./service_account.json');
};

const tombol = (v) => (v === '' || v === null || v === undefined ? '' : String(v));

const buildRow = (body) => {
  return [
    tombol(body.namaTPK), tombol(body.peranTPK), tombol(body.noHpTPK),
    tombol(body.namaDesa), tombol(body.namaKecamatan), tombol(body.rw), tombol(body.rt),
    tombol(body.nik), tombol(body.noKK), tombol(body.namaLengkap),
    tombol(body.noHp), tombol(body.tanggalLahir), tombol(body.usia), tombol(body.alamat),
    tombol(body.jenisSasaran),
    tombol(body.sumberAir), tombol(body.jamban), tombol(body.terpaparRokok),
    tombol(body.terlaluMuda), tombol(body.terlaluTua), tombol(body.terlaluDekat), tombol(body.terlaluBanyak),
    tombol(body.gunakanKB), tombol(body.jenisKB), tombol(body.rencanaKB), tombol(body.rencanaKehamilan),
    tombol(body.bpjsAktif), tombol(body.jenisBPJS), tombol(body.dtks),
    tombol(body.bansosDiterima),
    tombol(body.hpht), tombol(body.usiaKehamilan),
    tombol(body.bbSebelumHamil), tombol(body.bbSekarang), tombol(body.tb),
    tombol(body.lila), tombol(body.hb), tombol(body.tfu), tombol(body.tbj),
    tombol(body.riwayatPenyakit), tombol(body.terimaTTD), tombol(body.aksesFaskes), tombol(body.hamilKembar),
    tombol(body.tanggalLahirBayi), tombol(body.umurBayi), tombol(body.bbLahir), tombol(body.pbLahir),
    tombol(body.cukupBulan), tombol(body.asiEksklusif), tombol(body.sudahImunisasi),
    tombol(body.kak), tombol(body.stimulasi),
    tombol(body.namaAyah), tombol(body.nikAyah), tombol(body.namaIbu), tombol(body.nikIbu),
    tombol(body.tanggalLahirIbu),
    tombol(body.kiePenyuluhan), tombol(body.jenisKIE),
    tombol(body.fasilitasiRujukan), tombol(body.rujukanKe), tombol(body.rujukanProses),
    tombol(body.fasilitasiBansos), tombol(body.bansosProgram),
    tombol(body.hadirPosyandu), tombol(body.teridentifikasiRisiko),
    tombol(body.tanggalKunjungan),
    tombol(body.catatanTPK),
  ];
};

const validate = (body) => {
  const errors = [];
  if (!tombol(body.namaTPK)) errors.push('namaTPK');
  if (!tombol(body.peranTPK)) errors.push('peranTPK');
  if (!tombol(body.namaDesa)) errors.push('namaDesa');
  if (!tombol(body.namaLengkap)) errors.push('namaLengkap');
  if (!tombol(body.jenisSasaran)) errors.push('jenisSasaran');
  if (!tombol(body.tanggalKunjungan)) errors.push('tanggalKunjungan');
  const nik = tombol(body.nik);
  if (!nik) errors.push('nik');
  else if (!/^\d{16}$/.test(nik)) errors.push('nik (harus 16 digit angka)');
  return errors;
};

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Backend Pendampingan Keluarga TPK', endpoint: 'POST /api/submit' });
});

app.get('/api/sasaran', async (req, res) => {
  try {
    const auth = new google.auth.GoogleAuth({
      credentials: getCredentials(),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const client = await auth.getClient();
    const sheets = google.sheets({ version: 'v4', auth: client });

    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SHEET_ID,
      range: `${process.env.SHEET_NAME || 'Sheet1'}!A2:BM`,
    });

    const rows = result.data.values || [];
    const sasaranMap = {};

    for (const row of rows) {
      const nik = row[7] || '';
      if (!nik || nik.length !== 16) continue;

      if (!sasaranMap[nik]) {
        sasaranMap[nik] = {
          nik,
          namaLengkap: row[9] || '',
          noKK: row[8] || '',
          tanggalLahir: row[11] || '',
          usia: row[12] || '',
          noHp: row[10] || '',
          alamat: row[13] || '',
          jenisSasaran: row[14] || '',
          namaDesa: row[3] || '',
          namaKecamatan: row[4] || '',
          rw: row[5] || '',
          rt: row[6] || '',
          namaTPK: row[0] || '',
          peranTPK: row[1] || '',
          noHpTPK: row[2] || '',
          sumberAir: row[15] || '',
          jamban: row[16] || '',
          terpaparRokok: row[17] || '',
          gunakanKB: row[22] || '',
          jenisKB: row[23] || '',
          rencanaKB: row[24] || '',
          rencanaKehamilan: row[25] || '',
          bpjsAktif: row[26] || '',
          jenisBPJS: row[27] || '',
          dtks: row[28] || '',
          bansosDiterima: row[29] || '',
        };
      }
    }

    const sasaranList = Object.values(sasaranMap);
    res.status(200).json({ success: true, data: sasaranList });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Gagal mengambil data sasaran:`, error.message);
    res.status(500).json({ success: false, message: `Gagal mengambil data sasaran: ${error.message}` });
  }
});

app.post('/api/submit', async (req, res) => {
  try {
    const body = req.body || {};
    const errors = validate(body);
    if (errors.length > 0) {
      return res.status(400).json({ success: false, message: `Data tidak lengkap atau tidak valid: ${errors.join(', ')}`, errors });
    }

    const auth = new google.auth.GoogleAuth({
      credentials: getCredentials(),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const client = await auth.getClient();
    const sheets = google.sheets({ version: 'v4', auth: client });

    const result = await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.SHEET_ID,
      range: `${process.env.SHEET_NAME || 'Sheet1'}!A1`,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [buildRow(body)] },
    });

    res.status(200).json({
      success: true,
      message: 'Data berhasil disimpan ke Google Sheets',
      row: result.data.updates ? result.data.updates.updatedRange : undefined,
    });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Gagal menyimpan data:`, error.message);
    res.status(500).json({ success: false, message: `Gagal menyimpan data ke Google Sheets: ${error.message}` });
  }
});

const PORT = process.env.PORT || 3001;
if (require.main === module) {
  app.listen(PORT, () => console.log(`Server jalan di http://localhost:${PORT}`));
}

module.exports = app;
