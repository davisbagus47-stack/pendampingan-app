'use strict';

/**
 * Uji murni `lib/records-query.js` (F3.6).
 *
 * Semua yang diuji di sini tidak menyentuh database: bentuk permintaan,
 * kodekursor, penolakan hibah (kategori/wilayah), dan penyusunan SQL. Yang
 * perlu dibuktikan di sini adalah keputusan yang TIDAK bisa dibuktikan RLS --
 * terutama penolakan eksplisit FR-4.6 -- dan bentuk SQL yang dipakai jalur
 * produksi (FR-4.20c: tanpa `SELECT *`).
 *
 * Pembuktian terhadap PostgreSQL sungguhan (RLS, commitment, paginasi) ada di
 * `tools/test-records-live.js`; keduanya sengaja dipisah supaya suite ini tetap
 * hijau tanpa `DATABASE_URL`.
 */

const path = require('path');
const q = require(path.join(__dirname, '..', 'lib', 'records-query.js'));
const c = require(path.join(__dirname, '..', 'lib', 'canonical.js'));
const app = require(path.join(__dirname, '..', 'index.js'));

const { FIELD_ORDER } = app;

let passed = 0;
let failed = 0;

function ok(name, kondisi, detail) {
  if (kondisi) { passed++; console.log('LULUS  ' + name); }
  else {
    failed++;
    console.log('GAGAL  ' + name + (detail === undefined ? '' : '   [' + detail + ']'));
  }
}

function eq(name, aktual, diharapkan) {
  const a = JSON.stringify(aktual);
  const b = JSON.stringify(diharapkan);
  if (a === b) { passed++; console.log('LULUS  ' + name); }
  else {
    failed++;
    console.log('GAGAL  ' + name);
    console.log('        dapat     : ' + a);
    console.log('        diharapkan : ' + b);
  }
}

function kode(fn) {
  try { fn(); return null; } catch (e) { return e.code || e.name || null; }
}

function main() {
  console.log('=== 1. parseQuery: bawaan dan nilai sah ===');

  const kosong = q.parseQuery({});
  eq('tanpa parameter: kategori_1 null', kosong.kategori_1, null);
  eq('tanpa parameter: desa null', kosong.desa, null);
  eq('tanpa parameter: limit bawaan', kosong.limit, q.LIMIT_DEFAULT);
  eq('tanpa parameter: cursor null', kosong.cursor, null);

  const penuh = q.parseQuery({
    kategori_1: 'Ibu Hamil', kategori_2: 'f', desa: 'Sukamaju',
    tanggal_mulai: '2026-01-01', tanggal_selesai: '2026-12-31', limit: '25',
  });
  eq('kategori_1 dibaca', penuh.kategori_1, 'Ibu Hamil');
  eq('kategori_2 huruf kecil dinaikkan', penuh.kategori_2, 'F');
  eq('desa dibaca', penuh.desa, 'Sukamaju');
  eq('limit dibaca', penuh.limit, 25);

  console.log('\n=== 2. parseQuery: nilai buruk DITOLAK, bukan diabaikan ===');

  eq('kategori_1 di luar taksonomi ditolak',
    kode(() => q.parseQuery({ kategori_1: 'Z' })), 'INVALID_PARAM');
  eq('kategori_2 di luar A..I ditolak',
    kode(() => q.parseQuery({ kategori_2: 'Z' })), 'INVALID_PARAM');
  eq('tanggal_mulai bukan ISO ditolak',
    kode(() => q.parseQuery({ tanggal_mulai: '01/02/2026' })), 'INVALID_PARAM');
  eq('rentang tanggal terbalik ditolak',
    kode(() => q.parseQuery({ tanggal_mulai: '2026-12-31', tanggal_selesai: '2026-01-01' })),
    'INVALID_PARAM');
  eq('limit bukan angka ditolak',
    kode(() => q.parseQuery({ limit: 'abc' })), 'INVALID_PARAM');
  eq('limit nol ditolak',
    kode(() => q.parseQuery({ limit: '0' })), 'INVALID_PARAM');
  eq('limit terlalu besar DIPOTONG, bukan ditolak',
    q.parseQuery({ limit: '99999' }).limit, q.LIMIT_MAKS);

  console.log('\n=== 3. Kodekursor bulat dan menolak bentuk rusak ===');

  const kursor = q.encodeCursor({ created_at: new Date('2026-09-29T10:00:00.000Z'), id: 42 });
  ok('kursor berupa string base64url', typeof kursor === 'string' && /^[A-Za-z0-9_-]+$/.test(kursor), kursor);
  const balik = q.decodeCursor(kursor);
  eq('id dibaca bulat', balik.id, '42');
  eq('waktu dibaca bulat', balik.created_at.toISOString(), '2026-09-29T10:00:00.000Z');
  eq('parseQuery membaca cursor',
    q.parseQuery({ cursor: kursor }).cursor.id, '42');

  eq('base64 rusak ditolak',
    kode(() => q.decodeCursor('bukan-base64-!!!')), 'INVALID_CURSOR');
  eq('JSON tanpa kunci ditolak',
    kode(() => q.decodeCursor(Buffer.from('{"x":1}', 'utf8').toString('base64url'))), 'INVALID_CURSOR');
  eq('waktu tidak sah ditolak',
    kode(() => q.decodeCursor(Buffer.from('{"c":"bukan-tanggal","i":"1"}', 'utf8').toString('base64url'))),
    'INVALID_CURSOR');
  eq('id tidak numerik ditolak',
    kode(() => q.decodeCursor(Buffer.from('{"c":"2026-09-29T00:00:00.000Z","i":"x"}', 'utf8').toString('base64url'))),
    'INVALID_CURSOR');

  console.log('\n=== 4. validasiHibah: penolakan eksplisit FR-4.6 ===');

  const hibah = { categories: ['Catin', 'Ibu Hamil'], scope: [{ nama_desa: 'Sukamaju' }] };

  eq('kategori dihibahkan lolos',
    kode(() => q.validasiHibah(q.parseQuery({ kategori_1: 'Catin' }), hibah)), null);
  eq('kategori TIDAK dihibahkan ditolak CATEGORY_NOT_GRANTED',
    kode(() => q.validasiHibah(q.parseQuery({ kategori_1: 'Baduta' }), hibah)), 'CATEGORY_NOT_GRANTED');
  eq('desa dalam wilayah lolos',
    kode(() => q.validasiHibah(q.parseQuery({ desa: 'Sukamaju' }), hibah)), null);
  eq('desa di luar wilayah ditolak DESA_NOT_GRANTED',
    kode(() => q.validasiHibah(q.parseQuery({ desa: 'DesaLain' }), hibah)), 'DESA_NOT_GRANTED');
  eq('tanpa filter lolos (RLS yang menapis)',
    kode(() => q.validasiHibah(q.parseQuery({}), hibah)), null);
  eq('scope kosong = seluruh wilayah (FR-4.17)',
    kode(() => q.validasiHibah(q.parseQuery({ desa: 'DesaManaSaja' }), { categories: ['Catin'], scope: [] })), null);

  // Status 403, bukan 400: permintaannya sah, kewenangannya yang kurang.
  let st = null;
  try { q.validasiHibah(q.parseQuery({ kategori_1: 'Baduta' }), hibah); } catch (e) { st = e.status; }
  eq('penolakan hibah berstatus 403', st, 403);

  console.log('\n=== 5. rencanaKueri: proyeksi eksplisit, tanpa SELECT * ===');

  const sqlKosong = q.rencanaKueri({
    q: q.parseQuery({}), fieldOrder: FIELD_ORDER, denied: null, fields: null,
  });
  ok('tidak ada wildcard (FR-4.20c)', !sqlKosong.sql.includes('*'), sqlKosong.sql);
  ok('memuat kolom payload', sqlKosong.sql.includes('nama_lengkap'));
  ok('memuat metadata untuk verifikasi FR-4.3', sqlKosong.sql.includes('record_hash') && sqlKosong.sql.includes('institution_id'));
  ok('memuat id+created_at untuk kursor', sqlKosong.sql.includes(', id, created_at'));
  ok('urutan DESC untuk paginasi stabil', sqlKosong.sql.includes('ORDER BY created_at DESC, id DESC'));
  eq('limit + 1 dibaca', sqlKosong.params[sqlKosong.params.length - 1], q.LIMIT_DEFAULT + 1);

  const sqlFilter = q.rencanaKueri({
    q: q.parseQuery({
      kategori_1: 'Catin', kategori_2: 'B', desa: 'Sukamaju',
      tanggal_mulai: '2026-01-01', tanggal_selesai: '2026-12-31',
    }),
    fieldOrder: FIELD_ORDER, denied: null, fields: null,
  });
  ok('filter kategori jadi parameter', sqlFilter.sql.includes('jenis_sasaran ='));
  ok('filter section pakai irisan larik', sqlFilter.sql.includes('sections &&'));
  ok('filter desa jadi parameter', sqlFilter.sql.includes('nama_desa ='));
  ok('filter tanggal jadi parameter', sqlFilter.sql.includes('tanggal_kunjungan >='));
  ok('tidak ada nilai mentah di SQL', !sqlFilter.sql.includes('Sukamaju') && !sqlFilter.sql.includes('Catin'));

  const sqlKursor = q.rencanaKueri({
    q: q.parseQuery({ cursor: q.encodeCursor({ created_at: new Date('2026-09-29T00:00:00.000Z'), id: 7 }) }),
    fieldOrder: FIELD_ORDER, denied: null, fields: null,
  });
  ok('kursor jadi perbandingan baris', sqlKursor.sql.includes('(created_at, id) <'), sqlKursor.sql);

  console.log('\n=== 6. Kolom terlarang: fields eksplisit ditolak (FR-4.20a) ===');

  eq('fields=catatanTPK ditolak lewat recordsQuery',
    kode(() => q.rencanaKueri({
      q: q.parseQuery({}), fieldOrder: FIELD_ORDER, denied: null, fields: ['catatanTPK'],
    })), 'FIELD_NOT_GRANTED');

  console.log('\n=== 7. metaFor: commitment milik instansi PEMILIK (koreksi 1.2) ===');

  const record_hash = c.recordHash({ nik: '3273011234560001', namaLengkap: 'Ahmad Fauzi' });
  const meta = q.metaFor({
    record_id: 'r-1', version: 3, record_hash, institution_id: 'bidang-kb', sections: ['B', 'I'],
  });
  eq('commitment = SHA256(record_hash || institution_id)',
    meta.commitment, c.commitment(record_hash, 'bidang-kb'));
  eq('record_hash ikut demi verifikasi', meta.record_hash, record_hash);
  eq('institution_id ikut demi verifikasi', meta.institution_id, 'bidang-kb');
  eq('version jadi angka', meta.version, 3);

  const barisMeta = q.metaRow({ record_id: 'r-1', version: 3, record_hash, institution_id: 'bidang-kb', sections: [] });
  eq('metaRow mengikuti urutan META_HEADER',
    barisMeta, ['r-1', '3', meta.commitment]);
  eq('META_HEADER berisi record_id/version/commitment',
    q.META_HEADER, ['record_id', 'version', 'commitment']);

  console.log('\nlulus: ' + passed + '   gagal: ' + failed);
  if (failed > 0) process.exit(1);
  console.log('\nSEMUA UJI LOLOS');
}

main();
