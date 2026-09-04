// Serverless function Vercel: menangani POST /api/submit
const { google } = require('googleapis');

const tombol = (v) => (v === '' || v === null || v === undefined ? '' : String(v));

const getCredentials = () => {
  if (process.env.GOOGLE_CREDENTIALS_JSON) {
    return JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
  }
  try {
    return require('../backend/service_account.json');
  } catch (e) {
    throw new Error('Kredensial Google tidak ditemukan. Isi env GOOGLE_CREDENTIALS_JSON atau file service_account.json.');
  }
};

const buildRow = (body) => {
  const pendampingan = Array.isArray(body.pendampingan)
    ? body.pendampingan.map(tombol).join(', ')
    : tombol(body.pendampingan);

  return [
    tombol(body.namaTPK), tombol(body.rw), tombol(body.rt),
    tombol(body.namaPosyandu), tombol(body.nik), tombol(body.noKK),
    tombol(body.namaKK), tombol(body.namaIstri), tombol(body.namaSasaran),
    tombol(body.jenisSasaran), tombol(body.jenisKelamin), tombol(body.tanggalLahir),
    tombol(body.pekerjaan), tombol(body.keteranganPekerjaan), tombol(body.sumberAir),
    tombol(body.jamban), tombol(body.terlalu), tombol(body.dtks),
    tombol(body.resikoStunting), tombol(body.bpjsStatus), tombol(body.jenisBPJS),
    tombol(body.bukanPesertaKB), tombol(body.jenisKB), tombol(body.rencanaKehamilan),
    tombol(body.produkUsaha), pendampingan, tombol(body.bulanTahun),
    tombol(body.hadirPosy), tombol(body.kunjunganRumah), tombol(body.resiko),
    tombol(body.bb), tombol(body.tb), tombol(body.mms),
  ];
};

const validate = (body) => {
  const errors = [];
  if (!tombol(body.namaTPK)) errors.push('namaTPK');
  if (!tombol(body.namaSasaran)) errors.push('namaSasaran');
  if (!tombol(body.jenisSasaran)) errors.push('jenisSasaran');
  const nik = tombol(body.nik);
  if (!nik) errors.push('nik');
  else if (!/^\d{16}$/.test(nik)) errors.push('nik (harus 16 digit angka)');
  return errors;
};

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method tidak diizinkan' });
  }

  try {
    const body = req.body || {};
    const errors = validate(body);
    if (errors.length > 0) {
      return res.status(400).json({
        success: false,
        message: `Data tidak lengkap atau tidak valid: ${errors.join(', ')}`,
        errors,
      });
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
};