'use strict';

/**
 * Uji murni F3.5 (rekonsiliasi off-chain): kekurangan, selisih, peringkasan
 * TANPA database dan TANPA blockchain.
 *
 * `tools/worker-recon.js` memakai logika ini; yang tidak bisa dibuktikan di
 * sini adalah perilaku PostgreSQL (backfill ON CONFLICT yang dibolehkan peran
 * operator, kontras dengan 42501 agen) dan jawaban seam on-chain -- keduanya
 * dibuktikan di `tools/test-reconcil-live.js`.
 */

const path = require('path');
const c = require(path.join(__dirname, '..', 'lib', 'canonical.js'));
const reconcil = require(path.join(__dirname, '..', 'lib', 'reconcil.js'));

let passed = 0;
let failed = 0;

function ok(name, kondisi) {
  if (kondisi) { passed++; console.log('LULUS  ' + name); }
  else { failed++; console.log('GAGAL  ' + name); }
}

function eq(name, aktual, diharapkan) {
  const a = JSON.stringify(aktual);
  const b = JSON.stringify(diharapkan);
  if (a === b) { passed++; console.log('LULUS  ' + name); }
  else {
    failed++;
    console.log('GAGAL  ' + name + '   dapat=' + a + '  diharapkan=' + b);
  }
}

// Fixtures: tiga record dari instansi "ins-x" dan satu dari "ins-y", semua
// baris `records` seperti yang keluar dari SELECT (angka, bukan string).
const hash1 = c.recordHash({ nik: '3273011234560001', namaLengkap: 'Satu' });
const hash2 = c.recordHash({ nik: '3273011234560001', namaLengkap: 'Satu', bbSekarang: '60,0' });
const hash3 = c.recordHash({ nik: '3273011234560002', namaLengkap: 'Dua' });
const hash4 = c.recordHash({ nik: '3273011234560003', namaLengkap: 'Tiga' });

const records = [
  { id: 1, record_id: 'a', version: 1, supersedes_id: null, record_hash: hash1, institution_id: 'ins-x' },
  { id: 2, record_id: 'a', version: 2, supersedes_id: 1, record_hash: hash2, institution_id: 'ins-x' },
  { id: 3, record_id: 'b', version: 1, supersedes_id: null, record_hash: hash3, institution_id: 'ins-x' },
  { id: 4, record_id: 'c', version: 1, supersedes_id: null, record_hash: hash4, institution_id: 'ins-y' },
];

console.log('=== 1. perluBackfill ===');
{
  // a-1 punya outbox; a-2, b-1, c-1 belum punya.
  const outbox = [{ record_id: 'a', version: 1 }];
  const kurang = reconcil.perluBackfill(records, outbox);
  eq('records tanpa outbox terdaftar', kurang.map((r) => r.record_id + '-' + r.version), ['a-2', 'b-1', 'c-1']);
  eq('kekurangan kosong saat semua tertutup', reconcil.perluBackfill(records,
    [{ record_id: 'a', version: 1 }, { record_id: 'a', version: 2 },
      { record_id: 'b', version: 1 }, { record_id: 'c', version: 1 }]).length, 0);
  ok('record dengan outbox tidak terdaftar', !reconcil.perluBackfill(records, [{ record_id: 'a', version: 1 }])
    .some((r) => r.record_id === 'a' && r.version === 1));
}

console.log('\n=== 2. formulirBackfill (commitment pemilik, supersedes TEXT) ===');
{
  const baris1 = reconcil.formulirBackfill(records[0]);
  eq('record_id', baris1.record_id, 'a');
  eq('version', baris1.version, 1);
  eq('supersedes_id null (create)', baris1.supersedes_id, null);
  eq('commitment pemilik', baris1.commitment, c.commitment(hash1, 'ins-x'));

  const baris2 = reconcil.formulirBackfill(records[1]);
  eq('supersedes_id jadi TEXT (angka BIGINT)', baris2.supersedes_id, '1');
  eq('commitment versi 2 dihitung atas hash 2', baris2.commitment, c.commitment(hash2, 'ins-x'));

  const baris4 = reconcil.formulirBackfill(records[3]);
  eq('commitment instansi berbeda (ins-y)', baris4.commitment, c.commitment(hash4, 'ins-y'));
}

console.log('\n=== 3. periksa: sehat, yatim, komitmen, supersedes ===');
{
  // a-1: outbox sehat. b-1: komitmen salah. c-1: supersedes salah. d: yatim.
  const outbox = [
    { record_id: 'a', version: 1, supersedes_id: null, commitment: c.commitment(hash1, 'ins-x'), chain_status: 'pending' },
    { record_id: 'b', version: 1, supersedes_id: null, commitment: 'f'.repeat(64), chain_status: 'pending' },
    { record_id: 'c', version: 1, supersedes_id: '9999', commitment: c.commitment(hash4, 'ins-y'), chain_status: 'anchored' },
    { record_id: 'hantu', version: 1, supersedes_id: null, commitment: 'e'.repeat(64), chain_status: 'pending' },
  ];
  const s = reconcil.periksa(records, outbox);
  eq('yatim: tanpa records', s.yatim.map((y) => y.record_id), ['hantu']);
  eq('komitmen menyimpang', s.komitmen.map((k) => k.record_id), ['b']);
  eq('komitmen dihitung ulang', s.komitmen[0] && s.komitmen[0].dihitung, c.commitment(hash3, 'ins-x'));
  eq('supersedes menyimpang', s.supersedes.map((v) => v.record_id), ['c']);
  eq('supersedes dihitung dari records (null vs "9999")', s.supersedes[0] && s.supersedes[0].dihitung, null);
}

console.log('\n=== 4. ringkas status ===');
{
  const outbox = [
    { chain_status: 'pending' }, { chain_status: 'pending' }, { chain_status: 'anchored' },
    { chain_status: 'failed' }, { chain_status: 'skipped' },
  ];
  eq('jumlah per status', reconcil.ringkas(outbox), { pending: 2, anchored: 1, failed: 1, skipped: 1 });
}

console.log('\nlulus: ' + passed + '   gagal: ' + failed);
if (failed > 0) process.exit(1);
console.log('SEMUA UJI LOLOS (murni)');