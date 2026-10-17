'use strict';

/**
 * Uji murni jembatan rekonsiliasi on-chain (F3.5 separuh rantai): penguraian
 * event, penyusunan peta, dan perbandingan dengan `chain_outbox` TANPA
 * database dan TANPA jaringan.
 *
 * Yang TIDAK bisa dibuktikan di sini -- pembacaan log ethers sungguhan dan
 * pencocokan topik ter-index -- ada di `tools/test-reconcil-chain-live.js`.
 */

const path = require('path');
const rc = require(path.join(__dirname, '..', 'lib', 'reconcil-chain.js'));

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

const A = '0x' + 'a'.repeat(64);
const B = '0x' + 'b'.repeat(64);
const COM1 = '0x' + '1'.repeat(64);
const COM2 = '0x' + '2'.repeat(64);

console.log('=== 1. hashTeks cocok dengan vektor keccak beku ===');
{
  eq('keccak("Catin")', rc.hashTeks('Catin'),
    '0xb67116ff6249d77c68a2af80b6dd275c782cfa7a4ce7ade3953605c8f8682ad4');
  eq('keccak("Ibu Hamil")', rc.hashTeks('Ibu Hamil'),
    '0x44377596e672efc99c15cae022ad52823c341e6f609fac3654c41af23df26fb2');
  eq('keccak("")', rc.hashTeks(''), '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
  eq('null diperlakukan sebagai ""', rc.hashTeks(null), rc.hashTeks(''));
}

console.log('\n=== 2. dariEvent: DataAnchored, RecordSuperseded, sisanya null ===');
{
  const da = rc.dariEvent({
    fragment: { name: 'DataAnchored' },
    args: { recordId: { hash: A }, version: 3n, commitment: COM1, categoryHash: B },
  });
  eq('DataAnchored: hash record', da.hashRecordId, A);
  eq('DataAnchored: versi jadi angka', da.version, 3);
  eq('DataAnchored: commitment', da.commitment, COM1);
  eq('DataAnchored: jenis', da.jenis, 'anchor');

  const rs = rc.dariEvent({
    fragment: { name: 'RecordSuperseded' },
    args: {
      oldRecordId: { hash: A }, oldVersion: 1n,
      newRecordId: { hash: B }, newVersion: 2n, newCommitment: COM2,
    },
  });
  eq('RecordSuperseded: memakai newRecordId', rs.hashRecordId, B);
  eq('RecordSuperseded: memakai newVersion', rs.version, 2);
  eq('RecordSuperseded: memakai newCommitment', rs.commitment, COM2);
  eq('RecordSuperseded: jenis', rs.jenis, 'supersede');

  eq('commitment ter-index langsung (bukan objek) diterima', rc.dariEvent({
    fragment: { name: 'DataAnchored' },
    args: { recordId: { hash: A }, version: 1n, commitment: COM1 },
  }).commitment, COM1);
  eq('event lain diabaikan', rc.dariEvent({ fragment: { name: 'Lain' }, args: {} }), null);
  eq('args hilang diabaikan', rc.dariEvent({ fragment: { name: 'DataAnchored' } }), null);
  eq('recordId tanpa hash diabaikan', rc.dariEvent({
    fragment: { name: 'DataAnchored' }, args: { recordId: 'x', version: 1n, commitment: COM1 },
  }), null);
}

console.log('\n=== 3. petaRantai: kunci unik, duplikat diabaikan ===');
{
  const peta = rc.petaRantai([
    { hashRecordId: A, version: 1, commitment: COM1 },
    { hashRecordId: A, version: 1, commitment: COM2 },
    { hashRecordId: A, version: 2, commitment: COM2 },
  ]);
  eq('tiga entri menjadi dua kunci', peta.size, 2);
  eq('entri pertama dipertahankan', peta.get(rc.kunciRantai(A, 1)), COM1);
  eq('versi lain terpisah', peta.get(rc.kunciRantai(A, 2)), COM2);
}

// hashFn uji: identitas huruf kecil, supaya kunci bisa dibangun langsung.
const hashUji = (s) => String(s).toLowerCase();

console.log('\n=== 4. bandingkan: cocok, nihil ===');
{
  const peta = new Map([
    [rc.kunciRantai('rec1', 1), COM1],
    [rc.kunciRantai('rec1', 2), COM2],
  ]);
  const outbox = [
    { record_id: 'rec1', version: 1, commitment: '1'.repeat(64), chain_status: 'anchored' },
    { record_id: 'rec1', version: 2, commitment: COM2, chain_status: 'anchored' },
  ];
  const h = rc.bandingkan(outbox, peta, hashUji);
  eq('dua dicocokkan', h.dicocokkan, 2);
  eq('nol hilang', h.hilangDiRantai.length, 0);
  eq('nol komitmen menyimpang', h.komitmen.length, 0);
  eq('nol ekstra', h.ekstraDiRantai.length, 0);
  eq('M-3 nihil', h.nihil, true);
  eq('commitment tanpa 0x dinormalkan', h.diRantai, 2);
}

console.log('\n=== 5. bandingkan: hilang di rantai (klaim anchored) ===');
{
  const peta = new Map([[rc.kunciRantai('rec1', 1), COM1]]);
  const outbox = [
    { record_id: 'rec1', version: 1, commitment: COM1, chain_status: 'anchored' },
    { record_id: 'rec2', version: 1, commitment: COM2, chain_status: 'anchored' },
    { record_id: 'rec3', version: 1, commitment: COM2, chain_status: 'pending' },
  ];
  const h = rc.bandingkan(outbox, peta, hashUji);
  eq('hilang di rantai: rec2', h.hilangDiRantai.map((x) => x.record_id), ['rec2']);
  eq('pending yang belum di rantai dihitung, bukan selisih', h.belumDiRantai, 1);
  eq('tidak dianggap nihil', h.nihil, false);
  eq('jumlah selisih = 1', h.jumlahSelisih, 1);
}

console.log('\n=== 6. bandingkan: komitmen menyimpang + ekstra di rantai ===');
{
  const peta = new Map([
    [rc.kunciRantai('rec1', 1), COM1],
    [rc.kunciRantai('luar', 9), COM2],
  ]);
  const outbox = [
    { record_id: 'rec1', version: 1, commitment: COM2, chain_status: 'anchored' },
  ];
  const h = rc.bandingkan(outbox, peta, hashUji);
  eq('komitmen menyimpang', h.komitmen.length, 1);
  eq('komitmen: lokal', h.komitmen[0].lokal, COM2);
  eq('komitmen: rantai', h.komitmen[0].rantai, COM1);
  eq('ekstra di rantai (tanpa outbox) = "luar"', h.ekstraDiRantai.map((x) => x.hash_record_id), ['luar']);
  eq('dicocokkan tetap 0', h.dicocokkan, 0);
}

console.log('\n=== 7. bandingkan: peta kosong / outbox kosong ===');
{
  const kosong = rc.bandingkan([], new Map(), hashUji);
  eq('keduanya kosong -> nihil', kosong.nihil, true);
  eq('diRantai 0', kosong.diRantai, 0);
  const semuaPending = rc.bandingkan(
    [{ record_id: 'r', version: 1, commitment: COM1, chain_status: 'pending' }],
    new Map(), hashUji
  );
  eq('pending semua -> nihil (bukan selisih)', semuaPending.nihil, true);
  eq('pending dihitung', semuaPending.belumDiRantai, 1);
}

console.log('\n=== 8. konfigurasi baca: butuh RPC + alamat (bukan kunci) ===');
{
  eq('tanpa apa-apa: tidak tersedia', rc.tersedia({}), false);
  eq('RPC saja: tidak tersedia', rc.tersedia({ ANCHOR_RPC_URL: 'http://x' }), false);
  eq('RPC + alamat: tersedia', rc.tersedia({ ANCHOR_RPC_URL: 'http://x', ANCHOR_CONTRACT: '0x1' }), true);
  eq('kunci tidak diminta', rc.konfigurasi({
    ANCHOR_RPC_URL: 'http://x', ANCHOR_CONTRACT: '0x1', ANCHOR_PRIVATE_KEY: 'rahasia',
  }).rpcUrl, 'http://x');
}

console.log('\nlulus: ' + passed + '   gagal: ' + failed);
if (failed > 0) process.exit(1);
console.log('SEMUA UJI LOLOS (murni)');
