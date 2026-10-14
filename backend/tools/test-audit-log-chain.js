'use strict';

/**
 * Uji murni jembatan access_log -> rantai -> pohon Merkle (F4.3, FR-8.1/8.2).
 *
 * Tidak menyentuh database. Yang dibuktikan di sini:
 *   1. Pemetaan baris -> bidang entri stabil dan determinan (satu sumber
 *      kebenaran bentuk; verifier pihak ketiga harus meniru persis ini).
 *   2. Bukti inklusi untuk satu id lolos verifikasi, dan `id` benar-benar
 *      terikat ke `entry_hash` (lewat detail.access_log_id).
 *   3. Mengubah satu baris membuat bukti TIDAK lagi cocok dengan akar yang
 *      di-anchor -- inti nilai T1: akar yang tersimpan mendeteksi perubahan.
 *   4. Bukti dipotong ke batch yang di-anchor, sehingga akarnya sama dengan
 *      yang tersimpan.
 */

const path = require('path');

const C = require(path.join(__dirname, '..', 'lib', 'audit-log-chain.js'));
const A = require(path.join(__dirname, '..', 'lib', 'audit-chain.js'));
const M = require(path.join(__dirname, '..', 'lib', 'merkle.js'));

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
  const a = JSON.stringify(aktual);
  const b = JSON.stringify(diharapkan);
  if (a === b) { passed++; console.log('LULUS  ' + nama); }
  else {
    failed++;
    console.log('GAGAL  ' + nama);
    console.log('        dapat     : ' + a);
    console.log('        diharapkan : ' + b);
  }
}

const HEX64 = /^[0-9a-f]{64}$/;

function baris(i, ganti) {
  return Object.assign({
    id: String(i),
    ts: new Date(Date.UTC(2026, 9, 1, 8, 0, i)).toISOString(),
    actor_type: 'agency',
    actor_id: String(10 + i),
    category: 'Catin',
    params: { limit: 100 },
    result: 'success',
    response_rows: i,
    endpoint: '/api/v1/records',
  }, ganti || {});
}

function klon(rows) {
  return rows.map((r) => JSON.parse(JSON.stringify(r)));
}

// ===========================================================================
console.log('=== 1. Pemetaan baris -> bidang entri ===');

{
  const b = baris(1);
  const f = C.bidangDariBaris(b);
  eq('actor = tipe:id', f.actor, 'agency:11');
  eq('ts dipertahankan sebagai ISO', f.ts, b.ts);
  eq('action konstan', f.action, 'access');
  eq('outcome dari result', f.outcome, 'success');
  eq('resource dari endpoint', f.resource, b.endpoint);
  eq('detail.access_log_id terikat', f.detail.access_log_id, 1);
  eq('detail.category', f.detail.category, 'Catin');
  eq('detail.response_rows', f.detail.response_rows, 1);
  eq('detail.params', f.detail.params, { limit: 100 });

  const anon = C.bidangDariBaris(baris(2, { actor_id: null }));
  eq('actor_id kosong -> anon', anon.actor, 'agency:anon');

  const tanpaEndpoint = C.bidangDariBaris(baris(3, { endpoint: null, params: null }));
  eq('endpoint null -> string kosong', tanpaEndpoint.resource, '');
  eq('params null -> objek kosong', tanpaEndpoint.detail.params, {});

  // Dua baris bersih yang identik kecuali id harus memberi hash berbeda:
  // id TERIKAT ke entri, jadi menukar id mengubah hash.
  const r1 = baris(1); const r2 = baris(2);
  eq('entri berbeda untuk id berbeda',
    A.computeEntryHash(C.bidangDariBaris(r1), A.GENESIS_PREV) ===
    A.computeEntryHash(C.bidangDariBaris(r2), A.GENESIS_PREV),
    false);
}

console.log('\n=== 2. seq = posisi 1-based, bukan id ===');

{
  const rows = [baris(7), baris(8), baris(9)];
  const mentah = C.entriMentahDariBaris(rows);
  eq('seq berurutan dari 1', mentah.map((e) => e.seq), [1, 2, 3]);
  ok('id asli tetap terbawa di detail',
    mentah.map((e) => e.detail.access_log_id).join(',') === '7,8,9');
}

// ===========================================================================
console.log('\n=== 3. Akar dan ringkasan anchor ===');

const ROWS = [1, 2, 3, 4, 5].map((i) => baris(i));

{
  const akar = C.akarDariBaris(ROWS);
  eq('leaf_count = jumlah baris', akar.leaf_count, 5);
  ok('root hex64', HEX64.test(akar.root));
  ok('head_hash hex64', HEX64.test(akar.head_hash));
  eq('algorithm', akar.algorithm, M.MERKLE_ALGORITHM);

  let dilempar = false;
  try { C.akarDariBaris([]); } catch (e) { dilempar = true; }
  ok('log kosong ditolak', dilempar);
}

// ===========================================================================
console.log('\n=== 4. Bukti inklusi satu id ===');

{
  const bukti = C.buktiUntukId(ROWS, 3);
  ok('bukti ada', bukti !== null);
  eq('access_log_id', bukti.access_log_id, 3);
  eq('seq', bukti.seq, 3);
  eq('index (0-based)', bukti.index, 2);
  eq('leafCount', bukti.leafCount, 5);
  eq('leaf = hash(entry_hash)', bukti.leaf, M.leafFromEntryHash(bukti.entry.entry_hash));
  eq('belum ter-anchor', bukti.anchored, false);
  eq('anchor null', bukti.anchor, null);
  eq('verifikasi server lolos', C.verifikasiBukti(bukti), true);

  eq('id tidak ada -> null', C.buktiUntukId(ROWS, 999), null);
  eq('id bukan angka -> null', C.buktiUntukId(ROWS, 'abc'), null);

  // Entri yang dikembalikan harus benar-benar baris itu.
  eq('entry.detail.access_log_id cocok', bukti.entry.detail.access_log_id, 3);
  eq('entry.actor cocok', bukti.entry.actor, 'agency:13');
}

// ===========================================================================
console.log('\n=== 5. Bukti dipotong ke batch yang di-anchor ===');

{
  const akar3 = C.akarDariBaris(ROWS.slice(0, 3));
  const ANCHOR3 = {
    id: 'a1', from_seq: 1, to_seq: 3, leaf_count: 3,
    root: akar3.root, head_hash: akar3.head_hash, algorithm: akar3.algorithm,
  };

  const b2 = C.buktiUntukId(ROWS, 2, { anchors: [ANCHOR3] });
  eq('id=2 ter-anchor', b2.anchored, true);
  eq('leafCount dipotong ke 3', b2.leafCount, 3);
  eq('root sama dengan akar anchor', b2.root, akar3.root);
  eq('verifikasi lolos', C.verifikasiBukti(b2), true);

  const b5 = C.buktiUntukId(ROWS, 5, { anchors: [ANCHOR3] });
  eq('id=5 di luar anchor -> tidak ter-anchor', b5.anchored, false);
  eq('leafCount penuh', b5.leafCount, 5);

  // Pilih anchor dengan to_seq terbesar yang menutupi.
  const akar5 = C.akarDariBaris(ROWS);
  const ANCHOR5 = { id: 'a2', from_seq: 1, to_seq: 5, root: akar5.root, head_hash: akar5.head_hash };
  eq('id=4 pilih anchor terbesar',
    C.pilihAnchor([ANCHOR3, ANCHOR5], 4).id, 'a2');
  eq('id=2 juga pilih yang terbesar',
    C.pilihAnchor([ANCHOR3, ANCHOR5], 2).id, 'a2');
}

// ===========================================================================
console.log('\n=== 6. Perubahan baris terdeteksi lewat akar yang di-anchor ===');

{
  const akar = C.akarDariBaris(ROWS);
  const ANCHOR = {
    id: 'a1', from_seq: 1, to_seq: 5,
    root: akar.root, head_hash: akar.head_hash, algorithm: akar.algorithm,
  };

  const sebelum = C.buktiUntukId(ROWS, 3, { anchors: [ANCHOR] });
  eq('sebelum diubah: verifikasi lolos', C.verifikasiBukti(sebelum), true);

  const diubah = klon(ROWS);
  diubah[2].result = 'error';
  const sesudah = C.buktiUntukId(diubah, 3, { anchors: [ANCHOR] });
  eq('root berubah setelah isi diubah', sesudah.root !== akar.root, true);
  eq('verifikasi GAGAL terhadap akar lama', C.verifikasiBukti(sesudah), false);

  // Mengubah kolom yang TIDAK masuk hash (ip) tidak boleh mengubah entri.
  const ipBerubah = klon(ROWS);
  ipBerubah[2].ip = '10.0.0.9';
  const entriAwal = C.entriMentahDariBaris(ROWS)[2];
  const entriIp = C.entriMentahDariBaris(ipBerubah)[2];
  eq('kolom di luar hash tidak mengubah entri',
    A.computeEntryHash(entriIp, entriAwal.prev_hash),
    A.computeEntryHash(entriAwal, entriAwal.prev_hash));
}

console.log('\n=== 7. verifikasiBukti menolak masukan rusak ===');

{
  eq('null', C.verifikasiBukti(null), false);
  eq('tanpa entry', C.verifikasiBukti({ root: 'x', leaf: 'y', proof: [] }), false);
  const bukti = C.buktiUntukId(ROWS, 1);
  const dirusak = JSON.parse(JSON.stringify(bukti));
  dirusak.root = 'f'.repeat(64);
  eq('root salah -> gagal', C.verifikasiBukti(dirusak), false);
  const dirusak2 = JSON.parse(JSON.stringify(bukti));
  dirusak2.entry.outcome = 'error';
  eq('isi diubah tanpa perbaiki hash -> gagal', C.verifikasiBukti(dirusak2), false);
}

console.log('\nlulus: ' + passed + '   gagal: ' + failed);
if (failed > 0) {
  console.log('\nADA YANG RUSAK.');
  process.exit(1);
} else {
  console.log('\nSEMUA UJI LOLOS');
}
