'use strict';

/**
 * Uji live integrasi ZKP (`no_match`, F4.7) terhadap access_log PostgreSQL nyata.
 *
 * Yang dibuktikan di sini, dan tidak bisa dibuktikan uji murni:
 *   1. Route sungguhan menarik 4 baris access_log nyata (dipilih lewat `ids`),
 *      memetakannya ke tuple, dan membuktikan klaim negatif.
 *   2. Bukti yang dikembalikan lolos verifikasi MANDIRI (snarkjs groth16.verify
 *      terhadap verification key `no_match`), bukan hanya klaim server.
 *   3. Bila tuple target BENAR-BENAR ada di jendela, server menolak membuktikan
 *      (klaim negatif palsu) dan menyebut id yang cocok.
 *   4. Majalah parameter: jumlah id salah -> 400, id tak ada -> 404.
 *
 * Kontrak seperti live test lain:
 *   - Tanpa DATABASE_URL: DILEWATI exit 0 (bukan bukti pass).
 *   - EKSKLUSIF: mengambil advisory lock (tools/uji-live-lock.js) karena
 *     menghapus baris access_log benihnya; penghapusan di dalam prefix yang
 *     sedang di-anchor uji lain membuat akar mereka tak lagi cocok.
 *   - Data uji ber-watermark `uji-f4z-*` dihapus di `finally`.
 *   - Logger PERMINTAAN dialihkan ke penangkap in-memory
 *     (`app.gantiAccessLogger`) supaya permintaan uji tidak menumpuk baris
 *     `/api/v1/audit/zkp-proof` di `access_log` produksi; tabel tetap yang
 *     asli karena empat baris target disemai langsung lewat koneksi owner.
 */

const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

try { require('dotenv').config(); } catch (e) {}

const app = require(path.join(__dirname, '..', 'index.js'));
const db = require(path.join(__dirname, '..', 'lib', 'db.js'));
const accessLog = require(path.join(__dirname, '..', 'lib', 'access-log.js'));
const zkpCli = require(path.join(__dirname, '..', 'zkp', 'src', 'cli.js'));
const ujiLiveLock = require(path.join(__dirname, 'uji-live-lock.js'));

// Penangkap permintaan uji: permintaan ke `/api/v1/audit/zkp-proof` TIDAK
// ditulis ke `access_log` produksi (tak bisa dibedakan dari permintaan nyata,
// jadi membersihkannya tidak mungkin). Tabel tetap asli lewat baris seed.
const tertangkap = [];
const loggerUji = accessLog.buatLogger({ sink: (entri) => { tertangkap.push(entri); } });

let passed = 0;
let failed = 0;
let berjalan = false;
let port = 0;

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

async function minta(jalur) {
  const res = await fetch('http://127.0.0.1:' + port + jalur);
  const teks = await res.text();
  let body = null;
  try { body = JSON.parse(teks); } catch (e) {}
  return { status: res.status, body };
}

const HARI = Math.floor(Date.parse('2026-01-15T00:00:00Z') / 86400000);

async function main() {
  if (!process.env.DATABASE_URL) {
    console.log('\nDILEWATI: tidak ada DATABASE_URL. Uji live tidak dijalankan (bukan bukti pass).');
    return;
  }
  berjalan = true;

  const utama = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  utama.on('error', () => {});

  // Serialkan dengan uji live lain (lihat tools/uji-live-lock.js): uji ini
  // MENGHAPUS baris access_log benihnya, yang bisa berada di dalam prefix yang
  // sedang di-anchor/di-buktikan uji lain sehingga akar mereka tak lagi cocok.
  // Diisi di dalam try supaya `finally` selalu melepas kunci.
  let peganganKunci = null;

  const tanda = 'uji-f4z-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex');
  const endpointAir = '/' + tanda;

  let server = null;
  let idTerbuat = [];

  try {
    peganganKunci = await ujiLiveLock.ambil(process.env.DATABASE_URL);

    app.setCariKunci(null);

    // Permintaan uji dialihkan ke penangkap in-memory supaya tidak menumpuk
    // baris `/api/v1/audit/zkp-proof` di tabel produksi.
    app.gantiAccessLogger(loggerUji);

    const nilai = [];
    const kategori = ['Catin', 'Catin', 'Catin', 'Catin'];
    for (let i = 0; i < 4; i++) {
      nilai.push([
        '2026-01-15T08:0' + i + ':00Z', 'agency', 10 + i, kategori[i],
        JSON.stringify({ i }), 'success', 1, endpointAir,
      ]);
    }
    const ins = await utama.query(
      'INSERT INTO access_log (ts, actor_type, actor_id, category, params, result, response_rows, endpoint)' +
      ' VALUES ' + nilai.map((_, i) =>
        '($' + (i * 8 + 1) + ',$' + (i * 8 + 2) + ',$' + (i * 8 + 3) + ',$' + (i * 8 + 4) + ',' +
        '$' + (i * 8 + 5) + '::jsonb,$' + (i * 8 + 6) + ',$' + (i * 8 + 7) + ',$' + (i * 8 + 8) + ')').join(', ') +
      ' RETURNING id',
      nilai.flat()
    );
    idTerbuat = ins.rows.map((r) => Number(r.id));
    ok('empat baris access_log ter-seed', idTerbuat.length === 4);
    const idsCsv = idTerbuat.join(',');

    server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    port = server.address().port;

    console.log('\n=== 1. Validasi parameter ===');

    const kurang = await minta('/api/v1/audit/zkp-proof?ids=' + idTerbuat[0] + ',' + idTerbuat[1] + '&category=Catin&date=2026-01-15');
    eq('ids kurang dari 4 -> 400', kurang.status, 400);
    eq('kode INVALID_PARAM', kurang.body && kurang.body.code, 'INVALID_PARAM');

    const hilang = await minta('/api/v1/audit/zkp-proof?ids=999999991,999999992,999999993,999999994&category=Catin&date=2026-01-15');
    eq('id tak ada -> 404', hilang.status, 404);
    eq('kode AUDIT_ENTRY_NOT_FOUND', hilang.body && hilang.body.code, 'AUDIT_ENTRY_NOT_FOUND');

    console.log('\n=== 2. Klaim negatif BENAR: terbukti & terverifikasi mandiri ===');

    const absen = await minta('/api/v1/audit/zkp-proof?ids=' + idsCsv + '&category=Catin&institution=9999&date=2026-01-15');
    eq('status 200', absen.status, 200);
    eq('success true', absen.body && absen.body.success, true);
    eq('terbukti true', absen.body && absen.body.terbukti, true);
    eq('verified_by_server true', absen.body && absen.body.verified_by_server, true);
    eq('window.count = 4', absen.body && absen.body.window && absen.body.window.count, 4);

    const vkey = JSON.parse(require('fs').readFileSync(zkpCli.jalurVkey('no_match'), 'utf8'));
    const snarkjs = require(path.join(__dirname, '..', 'zkp', 'node_modules', 'snarkjs'));
    const mandiri = await snarkjs.groth16.verify(vkey, absen.body.public_signals, absen.body.proof);
    eq('verifikasi MANDIRI (snarkjs) true', mandiri, true);
    ok('public signals memuat akar jendela',
      absen.body.public_signals.includes(absen.body.log_root), JSON.stringify(absen.body.public_signals));
    ok('proof_bytes masuk akal (>0)', ukuranProof(absen.body) > 0);
    console.log('        (prove ' + absen.body.prove_ms + ' ms, verify ' + absen.body.verify_ms +
      ' ms, proof ' + absen.body.proof_bytes + ' B)');

    console.log('\n=== 3. Klaim negatif PALSU ditolak (tuple ADA di jendela) ===');

    const ada = await minta('/api/v1/audit/zkp-proof?ids=' + idsCsv + '&category=Catin&institution=11&date=2026-01-15');
    eq('status 200', ada.status, 200);
    eq('success true', ada.body && ada.body.success, true);
    eq('terbukti false', ada.body && ada.body.terbukti, false);
    ok('menyebut id yang cocok', Array.isArray(ada.body.cocok) && ada.body.cocok.includes(idTerbuat[1]),
      JSON.stringify(ada.body && ada.body.cocok));
    ok('tidak memuat proof', !ada.body.proof);

    console.log('\n=== 4. Tanggal berbeda -> klaim negatif benar ===');

    const lain = await minta('/api/v1/audit/zkp-proof?ids=' + idsCsv + '&category=Catin&institution=11&date=2025-12-31');
    eq('terbukti true (tanggal lain)', lain.body && lain.body.terbukti, true);
    eq('verified_by_server true', lain.body && lain.body.verified_by_server, true);

    console.log('\n        hari jendela = ' + HARI);
  } finally {
    if (server) await new Promise((r) => server.close(r));

    if (berjalan) {
      await utama.query('DELETE FROM access_log WHERE endpoint LIKE $1', [endpointAir + '%']).catch(() => {});
      const sisaLog = (await utama.query(
        'SELECT count(*)::int AS n FROM access_log WHERE endpoint LIKE $1', [endpointAir + '%']
      ).catch(() => ({ rows: [{ n: -1 }] }))).rows[0].n;
      console.log('\nbersih: ' + sisaLog + ' baris access_log sisa');
    }

    await utama.end().catch(() => {});
    await db.matikan().catch(() => {});
    await ujiLiveLock.lepas(peganganKunci);
  }

  console.log('\n' + (berjalan ? 'lulus: ' + passed + '   gagal: ' + failed : 'DILEWATI'));
  if (failed > 0) process.exitCode = 1;
}

function ukuranProof(body) {
  try { return Buffer.byteLength(JSON.stringify(body.proof)); } catch (e) { return 0; }
}

main().then(() => {
  // snarkjs/circomlibjs menyisakan worker thread yang menahan event loop hidup.
  // Semua pembersihan (server, pool, db) sudah selesai di `finally`; keluar paksa
  // di sini hanya untuk CLI/test, bukan kebiasaan untuk kode produksi.
  process.exit(process.exitCode || 0);
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
