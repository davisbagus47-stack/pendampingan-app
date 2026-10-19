'use strict';

/**
 * Worker flush async ke Google Sheets.
 * Dipanggil oleh cron (GET /api/cron/sheets-flush) atau CLI.
 * Baca sheets_pending (status=pending/failed), tulis ke Sheets batch,
 * update status done/failed.
 */

const { Pool } = require('pg');
const { google } = require('googleapis');

const SHEET_ID = () => process.env.SHEET_ID;
const SHEET_NAME = () => process.env.SHEET_NAME || 'Sheet1';

const HEADERS = [
  'No', 'Nama TPK', 'Peran TPK', 'No. HP Petugas', 'Nama Desa', 'Kecamatan',
  'RW', 'RT', 'NIK', 'No. KK', 'Nama Lengkap', 'No. HP', 'Alamat',
  'Tanggal Lahir', 'Usia', 'Jenis Sasaran', 'Sumber Air', 'Jamban',
  'Terpapar Rokok', 'Terlalu Muda', 'Terlalu Tua', 'Terlalu Dekat',
  'Terlalu Banyak', 'Gunakan KB', 'Jenis KB', 'Rencana KB',
  'Rencana Kehamilan', 'BPJS Aktif', 'Jenis BPJS', 'DTKS', 'Bansos Diterima',
  'HPHT', 'Usia Kehamilan', 'BB Sebelum Hamil', 'BB Sekarang', 'TB',
  'LILA', 'Hb', 'TFU', 'TBJ', 'Riwayat Penyakit', 'Terima TTD',
  'Akses Faskes', 'Hamil Kembar', 'Tanggal Lahir Bayi', 'Umur Bayi',
  'BB Lahir', 'PB Lahir', 'Cukup Bulan', 'ASI Eksklusif',
  'Sudah Imunisasi', 'KAK', 'Stimulasi', 'Nama Ayah', 'NIK Ayah',
  'Nama Ibu', 'NIK Ibu', 'Tanggal Lahir Ibu', 'KIE Penyuluhan',
  'Jenis KIE', 'Fasilitasi Rujukan', 'Rujukan Ke', 'Rujukan Proses',
  'Fasilitasi Bansos', 'Program Bansos', 'Hadir Posyandu',
  'Teridentifikasi Risiko', 'Tanggal Kunjungan', 'Catatan TPK',
  'Tim TPK', 'Pendampingan Ke', 'Jenis Kelamin', 'MBG 3B'
];

const BATCH_SIZE = parseInt(process.env.SHEETS_FLUSH_BATCH || '50', 10);
const MAX_ATTEMPTS = parseInt(process.env.SHEETS_MAX_ATTEMPTS || '3', 10);

function getCredentials() {
  const raw = process.env.GOOGLE_CREDENTIALS_JSON;
  if (!raw) throw new Error('GOOGLE_CREDENTIALS_JSON tidak diset');
  return JSON.parse(raw);
}

async function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    credentials: getCredentials(),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const client = await auth.getClient();
  return google.sheets({ version: 'v4', auth: client });
}

async function ensureHeaders(sheets) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SHEET_ID,
    range: `${process.env.SHEET_NAME || 'Sheet1'}!A1`,
  });
  const first = res.data.values && res.data.values[0] ? res.data.values[0][0] : '';
  if (first !== undefined && first !== null && String(first).trim() !== '') return;
  await sheets.spreadsheets.values.update({
    spreadsheetId: process.env.SHEET_ID,
    range: `${process.env.SHEET_NAME || 'Sheet1'}!A1`,
    valueInputOption: 'RAW',
    resource: { values: [HEADERS] },
  });
}

async function flushOnce({ batch = BATCH_SIZE, pool } = {}) {
  const pg = pool || new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const pgOwn = !pool;
  try {
    const sheets = await getSheetsClient();
    await ensureHeaders(sheets);

    // Ambil pending/failed yang siap dicoba
    const pending = await pg.query(
      `SELECT id, payload_json, row_data FROM sheets_pending
       WHERE status IN ('pending','failed')
         AND attempts < $1
         AND (next_retry_at IS NULL OR next_retry_at <= now())
       ORDER BY created_at
       LIMIT $2`,
      [3, 50] // max 3 attempts, batch 50
    );

    if (pending.rows.length === 0) {
      return { ok: true, flushed: 0 };
    }

    const sheetsClient = await getSheetsClient();
    const spreadsheetId = process.env.SHEET_ID;

    let flushed = 0;
    let failed = 0;

    for (const row of pending.rows) {
      const id = row.id;
      const rowData = row.row_data;

      try {
        await sheets.spreadsheets.values.append({
          spreadsheetId: process.env.SHEET_ID,
          range: `${process.env.SHEET_NAME || 'Sheet1'}!A1`,
          valueInputOption: 'RAW',
          resource: { values: [row.row_data] },
        });

        await pg.query(
          `UPDATE sheets_pending SET status='done', done_at=now(), last_error=NULL WHERE id=$1`,
          [row.id]
        );
        flushed++;
      } catch (e) {
        const attempt = await pg.query(
          `UPDATE sheets_pending SET attempts=attempts+1, last_error=$1, next_retry_at=now()+interval '5 minutes' WHERE id=$2 RETURNING attempts`,
          [e.message, row.id]
        );
        const attempts = attempt.rows[0]?.attempts || 0;
        if (attempts >= 3) {
          await pg.query(
            `UPDATE sheets_pending SET status='failed' WHERE id=$1`,
            [row.id]
          );
        }
        failed++;
      }
    }

    return { ok: true, flushed, failed };
  } finally {
    if (pgOwn) await pg.end();
  }
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL tidak diset');
    process.exit(1);
  }
  if (!process.env.SHEET_ID) {
    console.error('SHEET_ID tidak diset');
    process.exit(1);
  }

  const pg = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  try {
    const result = await flushOnce({ batch: parseInt(process.env.SHEETS_FLUSH_BATCH || '50', 10), pool: pg });
    console.log(JSON.stringify(result));
  } catch (e) {
    console.error('Gagal flush:', e.message);
    process.exit(1);
  } finally {
    await pg.end();
  }
}

if (require.main === module) {
  main();
}

module.exports = { flushOnce, getCredentials };