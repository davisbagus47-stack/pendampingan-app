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

// Urutan field yang disimpan ke Google Sheets (kolom B sampai akhir, kolom A = No)
const FIELD_ORDER = [
  'namaTPK', 'peranTPK', 'noHpTPK',
  'namaDesa', 'namaKecamatan', 'rw', 'rt',
  'nik', 'noKK', 'namaLengkap', 'noHp', 'tanggalLahir', 'usia', 'alamat',
  'jenisSasaran',
  'sumberAir', 'jamban', 'terpaparRokok',
  'terlaluMuda', 'terlaluTua', 'terlaluDekat', 'terlaluBanyak',
  'gunakanKB', 'jenisKB', 'rencanaKB', 'rencanaKehamilan',
  'bpjsAktif', 'jenisBPJS', 'dtks', 'bansosDiterima',
  'hpht', 'usiaKehamilan', 'bbSebelumHamil', 'bbSekarang', 'tb', 'lila', 'hb', 'tfu', 'tbj',
  'riwayatPenyakit', 'terimaTTD', 'aksesFaskes', 'hamilKembar',
  'tanggalLahirBayi', 'umurBayi', 'bbLahir', 'pbLahir', 'cukupBulan', 'asiEksklusif', 'sudahImunisasi', 'kak', 'stimulasi',
  'namaAyah', 'nikAyah', 'namaIbu', 'nikIbu', 'tanggalLahirIbu',
  'kiePenyuluhan', 'jenisKIE',
  'fasilitasiRujukan', 'rujukanKe', 'rujukanProses',
  'fasilitasiBansos', 'bansosProgram',
  'hadirPosyandu', 'teridentifikasiRisiko',
  'tanggalKunjungan', 'catatanTPK',
];

const LABELS = {
  namaTPK: 'Nama Petugas TPK', peranTPK: 'Peran dalam TPK', noHpTPK: 'No. HP Petugas',
  namaDesa: 'Desa/Kelurahan', namaKecamatan: 'Kecamatan', rw: 'RW', rt: 'RT',
  nik: 'NIK', noKK: 'No. KK', namaLengkap: 'Nama Lengkap', noHp: 'No. HP/WA',
  tanggalLahir: 'Tanggal Lahir', usia: 'Usia (tahun)', alamat: 'Alamat',
  jenisSasaran: 'Jenis Sasaran',
  sumberAir: 'Akses Air Minum', jamban: 'Fasilitas BAB (Jamban)', terpaparRokok: 'Terpapar Rokok',
  terlaluMuda: 'Terlalu Muda', terlaluTua: 'Terlalu Tua', terlaluDekat: 'Terlalu Dekat', terlaluBanyak: 'Terlalu Banyak',
  gunakanKB: 'Status KB', jenisKB: 'Jenis/Alat KB', rencanaKB: 'Rencana KB (Catin)', rencanaKehamilan: 'Rencana Kehamilan (Catin)',
  bpjsAktif: 'BPJS Aktif', jenisBPJS: 'Jenis BPJS', dtks: 'Terdaftar DTKS', bansosDiterima: 'Bansos Diterima',
  hpht: 'HPHT', usiaKehamilan: 'Usia Kehamilan (minggu)', bbSebelumHamil: 'BB Sebelum Hamil (kg)',
  bbSekarang: 'BB Sekarang (kg)', tb: 'Tinggi Badan (cm)', lila: 'LILA (cm)', hb: 'Hb (g/dl)',
  tfu: 'TFU (cm)', tbj: 'TBJ (gram)', riwayatPenyakit: 'Riwayat Penyakit', terimaTTD: 'Terima TTD',
  aksesFaskes: 'Akses Faskes', hamilKembar: 'Hamil Kembar',
  tanggalLahirBayi: 'Tanggal Melahirkan', umurBayi: 'Umur Bayi saat Lahir (minggu)',
  bbLahir: 'BB Lahir (kg)', pbLahir: 'PB Lahir (cm)', cukupBulan: 'Cukup Bulan',
  asiEksklusif: 'ASI Eksklusif', sudahImunisasi: 'Imunisasi Rutin', kak: 'Isi KAK', stimulasi: 'Perkembangan Anak',
  namaAyah: 'Nama Ayah', nikAyah: 'NIK Ayah', namaIbu: 'Nama Ibu', nikIbu: 'NIK Ibu', tanggalLahirIbu: 'Tanggal Lahir Ibu',
  kiePenyuluhan: 'KIE Penyuluhan', jenisKIE: 'Jenis KIE',
  fasilitasiRujukan: 'Fasilitasi Rujukan', rujukanKe: 'Rujukan Ke', rujukanProses: 'Status Rujukan',
  fasilitasiBansos: 'Fasilitasi Bansos', bansosProgram: 'Program Bansos',
  hadirPosyandu: 'Hadir Posyandu', teridentifikasiRisiko: 'Teridentifikasi Risiko',
  tanggalKunjungan: 'Tanggal Kunjungan', catatanTPK: 'Catatan TPK',
};

const HEADERS = ['No', ...FIELD_ORDER.map(f => LABELS[f])];

const buildRow = (body) => FIELD_ORDER.map(f => tombol(body[f]));

const SHEET_NAME = () => process.env.SHEET_NAME || 'Sheet1';
const SHEET_ID = () => process.env.SHEET_ID;

// Kolom terakhir dari HEADERS (contoh: 69 kolom → "BQ")
const lastColumn = (len) => {
  let col = '';
  let n = len;
  while (n > 0) {
    const rem = (n - 1) % 26;
    col = String.fromCharCode(65 + rem) + col;
    n = Math.floor((n - 1) / 26);
  }
  return col;
};

const getSheets = async () => {
  const auth = new google.auth.GoogleAuth({
    credentials: getCredentials(),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const client = await auth.getClient();
  return google.sheets({ version: 'v4', auth: client });
};

// ===== Baca daftar sasaran dari spreadsheet master (read-only) =====
const REF_SHEET_ID = () => process.env.REF_SHEET_ID;
const REF_SHEET_NAME = () => process.env.REF_SHEET_NAME || 'Form Responses 1';

// Pemetaan: field form app -> judul kolom di spreadsheet master
const REF_FIELDS = {
  nik: 'NIK Sasaran',
  noKK: 'NIK KK',
  namaLengkap: 'Nama Sasaran',
  tanggalLahir: 'Tanggal Lahir',
  usia: 'Umur',
  satuanUsia: 'Satuan Umur',
  noHp: 'No HP',
  alamat: 'Alamat',
  jenisSasaran: 'Sasaran',
  bbSekarang: 'BB',
  tb: 'TB',
  namaDesa: 'Desa',
  namaKecamatan: 'Kecamatan',
  namaTPK: 'Nama TPK',
  peranTPK: 'Unsur TPK',
};

const NORMALIZE_SASARAN = {
  'calon pengantin': 'Catin',
  'calon pengantin / calon pus': 'Catin',
  'catin': 'Catin',
  'ibu hamil': 'Ibu Hamil',
  'hamil': 'Ibu Hamil',
  'ibu nifas': 'Ibu Nifas',
  'nifas': 'Ibu Nifas',
  'baduta': 'Baduta',
  'baduta 0-23 bulan': 'Baduta',
  'bayi 0-23 bulan': 'Baduta',
};

const NORMALIZE_PERAN = {
  'tenaga kesehatan': 'Bidan',
  'bidan': 'Bidan',
  'pkk': 'Kader PKK',
  'kader pkk': 'Kader PKK',
  'kader tp pkk': 'Kader PKK',
  'kader kb': 'Kader KB',
};

const normalizeNik = (v) => {
  const s = String(v || '').trim().replace(/\s+/g, '');
  if (s.indexOf('E') > -1) return ''; // nilai numerik ilmiah -> tidak bisa dipastikan, lewati
  return s.replace(/\D/g, '');
};

const getRefSheets = async () => {
  const auth = new google.auth.GoogleAuth({
    credentials: getCredentials(),
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const client = await auth.getClient();
  return google.sheets({ version: 'v4', auth: client });
};

const getSasaranFromRef = async () => {
  const sheets = await getRefSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: REF_SHEET_ID(),
    range: `'${REF_SHEET_NAME()}'!A1:ZZ`,
  });

  const all = res.data.values || [];
  if (all.length === 0) return [];

  const header = all[0].map(h => String(h || '').trim());
  const colIndex = {};
  Object.entries(REF_FIELDS).forEach(([field, label]) => {
    const i = header.indexOf(label);
    if (i > -1) colIndex[field] = i;
  });

  const get = (row, field) => {
    const i = colIndex[field];
    return i !== undefined && row[i] !== undefined ? String(row[i]).trim() : '';
  };

  const sasaranMap = {};
  for (const row of all.slice(1)) {
    const nik = normalizeNik(get(row, 'nik'));
    if (nik.length !== 16) continue;

    // Ubah satuan umur (bulan/minggu/hari) jadi tahun bila dipakai
    let usia = get(row, 'usia');
    const satuan = get(row, 'satuanUsia').toLowerCase();
    const angkaUsia = parseFloat(usia);
    if (satuan && angkaUsia > 0) {
      if (satuan.indexOf('bulan') > -1 || satuan.indexOf('minggu') > -1) {
        usia = String(Math.max(1, Math.round(angkaUsia / 12)));
      } else if (satuan.indexOf('hari') > -1) {
        usia = String(Math.max(1, Math.round(angkaUsia / 365)));
      }
    }

    const jenisSasaran = get(row, 'jenisSasaran');
    const sasaran = NORMALIZE_SASARAN[jenisSasaran.toLowerCase()] || jenisSasaran;
    const peran = get(row, 'peranTPK');
    const angka = (v) => v ? String(v).replace(',', '.').trim() : ''; // dukungan angka "70,00"

    sasaranMap[nik] = {
      nik,
      namaLengkap: get(row, 'namaLengkap'),
      noKK: get(row, 'noKK'),
      tanggalLahir: get(row, 'tanggalLahir'),
      usia,
      noHp: get(row, 'noHp'),
      alamat: get(row, 'alamat'),
      jenisSasaran: sasaran,
      namaDesa: get(row, 'namaDesa'),
      namaKecamatan: get(row, 'namaKecamatan'),
      namaTPK: get(row, 'namaTPK'),
      peranTPK: NORMALIZE_PERAN[peran.toLowerCase()] || peran,
      noHpTPK: '',
      bbSekarang: angka(get(row, 'bbSekarang')),
      tb: angka(get(row, 'tb')),
    };
  }
  return Object.values(sasaranMap);
};

// Tulis baris header bila belum ada (baris pertama masih kosong)
const ensureHeaders = async (sheets) => {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID(),
    range: `${SHEET_NAME()}!A1`,
  });
  const first = res.data.values && res.data.values[0] ? res.data.values[0][0] : '';
  if (first !== undefined && first !== null && String(first).trim() !== '') return;
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID(),
    range: `${SHEET_NAME()}!A1`,
    valueInputOption: 'RAW',
    resource: { values: [HEADERS] },
  });
};

// Nomor urut berikutnya berdasarkan isi kolom A (data), header di baris 1 diabaikan
const nextNumber = async (sheets) => {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID(),
    range: `${SHEET_NAME()}!A2:A`,
  });
  const vals = res.data.values || [];
  const count = vals.filter(r => r && r[0] !== undefined && String(r[0]).trim() !== '').length;
  return count + 1;
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
  res.json({ status: 'ok', service: 'Backend Pendampingan Keluarga TPK', endpoints: ['POST /api/submit', 'GET /api/sasaran'] });
});

app.get('/api/sasaran', async (req, res) => {
  try {
    let sasaranList;
    if (process.env.REF_SHEET_ID) {
      // Sumber utama: spreadsheet master (read-only)
      sasaranList = await getSasaranFromRef();
    } else {
      // Fallback: baca dari spreadsheet submit sendiri (perilaku lama)
      const sheets = await getSheets();
      const result = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID(),
        range: `${SHEET_NAME()}!A2:${lastColumn(HEADERS.length)}`,
      });

      const rows = result.data.values || [];
      const sasaranMap = {};

      for (const row of rows) {
        const nik = row[8] || '';
        if (!nik || nik.length !== 16) continue;

        if (!sasaranMap[nik]) {
          sasaranMap[nik] = {
            nik,
            namaLengkap: row[10] || '',
            noKK: row[9] || '',
            tanggalLahir: row[12] || '',
            usia: row[13] || '',
            noHp: row[11] || '',
            alamat: row[14] || '',
            jenisSasaran: row[15] || '',
            namaDesa: row[4] || '',
            namaKecamatan: row[5] || '',
            rw: row[6] || '',
            rt: row[7] || '',
            namaTPK: row[1] || '',
            peranTPK: row[2] || '',
            noHpTPK: row[3] || '',
            sumberAir: row[16] || '',
            jamban: row[17] || '',
            terpaparRokok: row[18] || '',
            gunakanKB: row[23] || '',
            jenisKB: row[24] || '',
            rencanaKB: row[25] || '',
            rencanaKehamilan: row[26] || '',
            bpjsAktif: row[27] || '',
            jenisBPJS: row[28] || '',
            dtks: row[29] || '',
            bansosDiterima: row[30] || '',
          };
        }
      }

      sasaranList = Object.values(sasaranMap);
    }

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

    const sheets = await getSheets();
    await ensureHeaders(sheets);
    const no = await nextNumber(sheets);

    const result = await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID(),
      range: `${SHEET_NAME()}!A1`,
      valueInputOption: 'RAW',
      resource: { values: [[no, ...buildRow(body)]] },
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