'use strict';

const path = require('path');
const XLSX = require('xlsx');
const { Pool } = require('pg');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const DEFAULT_FILE = path.join(__dirname, '..', 'data', 'tpk_members.xlsx');
const SHEET_NAME = 'LAMP. SK TPK';
const HEADER_ROW = 3;

function text(value) { return value === undefined || value === null ? '' : String(value).trim(); }
function digits(value) { return text(value).replace(/\D/g, ''); }

function parseDate(value) {
  const raw = text(value);
  if (!raw) return null;
  const serial = Number(raw);
  if (Number.isFinite(serial) && serial >= 20000 && serial <= 50000) {
    return new Date(Date.UTC(1899, 11, 30) + serial * 86400000).toISOString().slice(0, 10);
  }
  const match = raw.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})$/);
  if (!match) return null;
  const [, day, month, year] = match;
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

function key(value) {
  return text(value).toLowerCase().replace(/\s+/g, '_').replace(/[()]/g, '').replace(/[^a-z0-9_]/g, '');
}

function readRows(file) {
  const workbook = XLSX.readFile(file, { cellDates: false });
  const sheet = workbook.Sheets[SHEET_NAME];
  if (!sheet) throw new Error(`Sheet ${SHEET_NAME} tidak ditemukan`);
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  if (rows.length <= HEADER_ROW) throw new Error('File Excel tidak memiliki baris data');
  const headers = rows[HEADER_ROW].map(key);
  return rows.slice(HEADER_ROW + 1)
    .filter(row => row.some(value => text(value) !== ''))
    .map(row => Object.fromEntries(headers.map((header, index) => [header, row[index]])));
}

function toRecord(row) {
  const nik = digits(row.nik);
  if (nik.length !== 16) return null;
  return {
    nik,
    nama_lengkap: text(row.nama_lengkap_anggota_tpk || row.nama_lengkap || row.nama),
    id_tpk: text(row.id_tpk),
    unsur: text(row.unsur_bidanperawatnakes || row.unsur),
    tim: text(row.tim),
    daerah_binaan: text(row.daerah_binaan),
    no_hp: digits(row.nomor_hp || row.no_hp),
    no_rek_jatim: text(row.no_rek_jatim),
    tempat_lahir: text(row.tempat_lahir),
    tanggal_lahir: parseDate(row.tanggal_lahir),
    operator_hp: text(row.operator_nomor_hp),
    pendidikan: text(row.pendidikan_terakhir || row.pendidikan),
    desa_kelurahan: text(row.desakelurahan || row.desa_kelurahan),
  };
}

async function main() {
  const file = path.resolve(process.argv[2] || DEFAULT_FILE);
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL tidak diset');
  const records = readRows(file);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const sql = `INSERT INTO tpk_members
    (nik, nama_lengkap, id_tpk, unsur, tim, daerah_binaan, no_hp, no_rek_jatim,
     tempat_lahir, tanggal_lahir, operator_hp, pendidikan, desa_kelurahan)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    ON CONFLICT (nik) DO UPDATE SET
      nama_lengkap = EXCLUDED.nama_lengkap, id_tpk = EXCLUDED.id_tpk,
      unsur = EXCLUDED.unsur, tim = EXCLUDED.tim, daerah_binaan = EXCLUDED.daerah_binaan,
      no_hp = EXCLUDED.no_hp, no_rek_jatim = EXCLUDED.no_rek_jatim,
      tempat_lahir = EXCLUDED.tempat_lahir, tanggal_lahir = EXCLUDED.tanggal_lahir,
      operator_hp = EXCLUDED.operator_hp, pendidikan = EXCLUDED.pendidikan,
      desa_kelurahan = EXCLUDED.desa_kelurahan, updated_at = now()`;
  let imported = 0;
  let skipped = 0;
  try {
    for (const row of records) {
      const record = toRecord(row);
      if (!record || !record.nama_lengkap) { skipped++; continue; }
      await pool.query(sql, Object.values(record));
      imported++;
    }
  } finally {
    await pool.end();
  }
  console.log(`Selesai: ${imported} diimpor/diperbarui, ${skipped} dilewati.`);
}

if (require.main === module) {
  main().catch(error => { console.error(`Gagal impor: ${error.message}`); process.exitCode = 1; });
}

module.exports = { parseDate, readRows, toRecord };
