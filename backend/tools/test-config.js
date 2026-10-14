'use strict';

/**
 * Uji murni validasi konfigurasi instansi (F3.10c, FR-4.9..4.12, FR-4.21).
 *
 * Tidak menyentuh database maupun HTTP. `FIELD_ORDER` asli diambil dari
 * `index.js` supaya kolom uji selalu nyata, bukan karangan.
 */

const path = require('path');

const app = require(path.join(__dirname, '..', 'index.js'));
const C = require(path.join(__dirname, '..', 'lib', 'config.js'));
const { columnName } = require(path.join(__dirname, '..', 'lib', 'field-types.js'));

// `field_catalog.column_key` memakai nama kolom snake_case, dan trigger DB
// membandingkan hidden_fields dengan column_key. Maka kumpulan nama yang sah
// untuk konfigurasi adalah bentuk snake_case, bukan FIELD_ORDER.
const KOLOM = app.FIELD_ORDER.map(columnName);
const a = KOLOM[0];
const b = KOLOM[1];
const c = KOLOM[2];

let passed = 0;
let failed = 0;

function ok(nama, kondisi, detail) {
  if (kondisi) { passed++; console.log('LULUS  ' + nama); }
  else {
    failed++;
    console.log('GAGAL  ' + nama + (detail === undefined ? '' : '   [' + detail + ']'));
  }
}

function eq(nama, aktual, diharapkan) {
  const x = JSON.stringify(aktual);
  const y = JSON.stringify(diharapkan);
  if (x === y) { passed++; console.log('LULUS  ' + nama); }
  else {
    failed++;
    console.log('GAGAL  ' + nama);
    console.log('        dapat     : ' + x);
    console.log('        diharapkan : ' + y);
  }
}

function pastiGagal(nama, fn, kode) {
  try {
    fn();
    failed++;
    console.log('GAGAL  ' + nama + '   (tidak melempar)');
  } catch (e) {
    if (e.code === kode) { passed++; console.log('LULUS  ' + nama); }
    else {
      failed++;
      console.log('GAGAL  ' + nama + '   (kode ' + (e.code || '?') + ', diharapkan ' + kode + ')');
    }
  }
}

console.log('=== 1. Bentuk badan permintaan ===');

pastiGagal('bukan objek (array) ditolak', () => C.normalisasi([1, 2], { fieldOrder: KOLOM }), 'VALIDATION_FAILED');
pastiGagal('bukan objek (string) ditolak', () => C.normalisasi('x', { fieldOrder: KOLOM }), 'VALIDATION_FAILED');
pastiGagal('bukan objek (null) ditolak', () => C.normalisasi(null, { fieldOrder: KOLOM }), 'VALIDATION_FAILED');
pastiGagal('kunci puncak tak dikenal ditolak', () => C.normalisasi({ foo: 1 }, { fieldOrder: KOLOM }), 'VALIDATION_FAILED');
pastiGagal('badan kosong ditolak', () => C.normalisasi({}, { fieldOrder: KOLOM }), 'VALIDATION_FAILED');

console.log('\n=== 2. hidden_fields ===');

eq('hidden_fields diterima', C.normalisasi({ hidden_fields: [a, b] }, { fieldOrder: KOLOM }), { hidden_fields: [a, b] });
eq('duplikat dibuang, urutan tetap', C.normalisasi({ hidden_fields: [b, a, b] }, { fieldOrder: KOLOM }), { hidden_fields: [b, a] });
eq('huruf ekstra dipangkas', C.normalisasi({ hidden_fields: [' ' + a + ' '] }, { fieldOrder: KOLOM }), { hidden_fields: [a] });
pastiGagal('mustahil (bukan array) ditolak', () => C.normalisasi({ hidden_fields: a }, { fieldOrder: KOLOM }), 'VALIDATION_FAILED');
pastiGagal('kolom tak dikenal ditolak (FIELD_UNKNOWN)', () => C.normalisasi({ hidden_fields: ['gg:rahasia'] }, { fieldOrder: KOLOM }), 'FIELD_UNKNOWN');
pastiGagal('elemen bukan teks ditolak', () => C.normalisasi({ hidden_fields: [42] }, { fieldOrder: KOLOM }), 'VALIDATION_FAILED');

console.log('\n=== 3. column_order ===');

eq('column_order diterima', C.normalisasi({ column_order: [c, a] }, { fieldOrder: KOLOM }), { column_order: [c, a] });
pastiGagal('kolom tak dikenal ditolak', () => C.normalisasi({ column_order: ['x'] }, { fieldOrder: KOLOM }), 'FIELD_UNKNOWN');

console.log('\n=== 4. default_format ===');

eq('format diturunkan hurufnya', C.normalisasi({ default_format: 'XLSX' }, { fieldOrder: KOLOM }), { default_format: 'xlsx' });
eq('json', C.normalisasi({ default_format: 'json' }, { fieldOrder: KOLOM }), { default_format: 'json' });
pastiGagal('format asing ditolak', () => C.normalisasi({ default_format: 'pdf' }, { fieldOrder: KOLOM }), 'INVALID_FORMAT');

console.log('\n=== 5. default_filters ===');

const FILTER_OK = { kategori_1: 'Catin', desa: ['Desa A', 'Desa B'], tanggal_mulai: '2026-01-01' };
eq('filter sah diterima', C.normalisasi({ default_filters: FILTER_OK }, { fieldOrder: KOLOM }), { default_filters: FILTER_OK });
eq('filter kosong dibuang', C.normalisasi({ default_filters: { desa: '', kategori_1: null } }, { fieldOrder: KOLOM }), { default_filters: {} });
pastiGagal('kunci filter tak dikenal ditolak', () => C.normalisasi({ default_filters: { ham: 1 } }, { fieldOrder: KOLOM }), 'VALIDATION_FAILED');
pastiGagal('nilai berupa objek bersarang ditolak', () => C.normalisasi({ default_filters: { desa: { a: 1 } } }, { fieldOrder: KOLOM }), 'VALIDATION_FAILED');
pastiGagal('nilai berupa daftar angka ditolak', () => C.normalisasi({ default_filters: { desa: [1, 2] } }, { fieldOrder: KOLOM }), 'VALIDATION_FAILED');
pastiGagal('bukan objek ditolak', () => C.normalisasi({ default_filters: ['a'] }, { fieldOrder: KOLOM }), 'VALIDATION_FAILED');

console.log('\n=== 6. gabungan dan pelengkapan ===');

const campuran = C.normalisasi(
  { hidden_fields: [b], column_order: [a, c], default_format: 'csv', default_filters: { desa: 'X' } },
  { fieldOrder: KOLOM }
);
eq('empat kunci sekaligus', campuran, {
  hidden_fields: [b],
  column_order: [a, c],
  default_filters: { desa: 'X' },
  default_format: 'csv',
});

eq('lengkapi: sebagian (mengganti sisanya dengan bawaan)', C.lengkapi({ hidden_fields: [a] }), {
  hidden_fields: [a],
  column_order: [],
  default_filters: {},
  default_format: 'json',
});
eq('lengkapi: kosong -> semua bawaan', C.lengkapi({}), {
  hidden_fields: [],
  column_order: [],
  default_filters: {},
  default_format: 'json',
});

console.log('\nlulus: ' + passed + '   gagal: ' + failed);
try { require('../lib/db.js').matikan().catch(() => {}); } catch (e) {}
if (failed > 0) {
  console.log('\nADA YANG RUSAK.');
  process.exit(1);
} else {
  console.log('\nSEMUA UJI LOLOS');
}
