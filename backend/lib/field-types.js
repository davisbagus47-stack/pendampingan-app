'use strict';

/**
 * Metadata skema yang dipakai bersama oleh generator DDL dan penghitung hash.
 *
 * Dipisah ke modul sendiri karena dua konsumen punya kebutuhan berbeda tetapi
 * harus sepakat: `tools/generate-schema.js` menulis kolom SQL, `lib/canonical.js`
 * menormalkan nilai sebelum hash. Kalau dipisah duplikat, keduanya bisa
 * perlahan berbeda dan hash tidak lagi cocok dengan kolom yang tersimpan.
 */

/** camelCase -> snake_case, dengan pengecualian yang disengaja. */
const COLUMN_NAME_OVERRIDES = {
  // Algoritma menghasilkan "mbg3_b". Nama yang dipakai skema dan API adalah
  // "mbg3b" agar sesuai label "MBG 3B" dan tidak berubah sejak draf pertama.
  mbg3B: 'mbg3b',
};

const snake = (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
const columnName = (field) => COLUMN_NAME_OVERRIDES[field] || snake(field);

/**
 * Peta tipe. Semua nilai masuk sebagai string lewat tombol() di index.js, jadi
 * kolom numerik dan tanggal ADALAH hasil parse, bukan nilai mentah.
 *
 * Aturan parse yang wajib berlaku di sisi tulis (lihat catatan "Kebijakan parse"):
 *   - kosong, "-", atau "N/A"  -> NULL
 *   - koma desimal "70,00"     -> titik "70.00"
 *   - ada satuan ("70 kg")    -> ambil bagian numerik
 *   - gagal parse              -> NULL, BUKAN galat
 */
const TYPES = {
  // Tanggal
  tanggalLahir: 'DATE',
  hpht: 'DATE',
  tanggalLahirBayi: 'DATE',
  tanggalLahirIbu: 'DATE',
  tanggalKunjungan: 'DATE',

  // Pengukuran
  usia: 'NUMERIC(4,1)',
  usiaKehamilan: 'NUMERIC(4,1)',
  bbSebelumHamil: 'NUMERIC(5,1)',
  bbSekarang: 'NUMERIC(5,1)',
  tb: 'NUMERIC(5,1)',
  lila: 'NUMERIC(5,1)',
  hb: 'NUMERIC(5,1)',
  tfu: 'NUMERIC(5,1)',
  tbj: 'NUMERIC(8,1)',
  umurBayi: 'NUMERIC(4,1)',
  bbLahir: 'NUMERIC(5,1)',
  pbLahir: 'NUMERIC(5,1)',

  // Ordinal
  pendampinganKe: 'INTEGER',
};

/** Kolom yang wajib TEXT meski tampak numerik. */
const FORCED_TEXT = new Set([
  // NIK/No. KK boleh ber-0 depan dan tidak pernah dihitung
  'nik', 'noKK', 'nikAyah', 'nikIbu',
  // RW/RT bisa "0A" atau "01"
  'rw', 'rt',
]);

/**
 * Field yang nilainya boleh diseragamkan ke satu representasi numerik.
 *
 * Sengaja sempit. Menormalkan "semua string yang tampak angka" akan merusak NIK
 * (nol di depan hilang) dan mengubah "007" menjadi "7", sehingga dua data
 * identitas yang berbeda bisa menghasilkan hash sama.
 */
const NUMERIC_FIELDS = new Set(
  Object.keys(TYPES).filter((f) => TYPES[f] !== 'DATE')
);

/** Field bertipe tanggal. Nilai form sudah "YYYY-MM-DD" dari <input type="date">. */
const DATE_FIELDS = new Set(
  Object.keys(TYPES).filter((f) => TYPES[f] === 'DATE')
);

module.exports = {
  COLUMN_NAME_OVERRIDES,
  snake,
  columnName,
  TYPES,
  FORCED_TEXT,
  NUMERIC_FIELDS,
  DATE_FIELDS,
};
