'use strict';

/**
 * Uji live F4.3 endpoint bukti inklusi Merkle terhadap PostgreSQL nyata.
 *
 * Yang dibuktikan di sini, dan tidak bisa dibuktikan uji murni:
 *   1. Route sungguhan memakai jalur yang benar (membaca access_log sebagai
 *      operator, memilih anchor, mengembalikan bukti).
 *   2. Setelah akar di-anchor (worker-audit-anchor), bukti untuk satu entri
 *      benar-benar tertaut ke akar yang TERSIMPAN (anchored=true,
 *      root == audit_anchor.root).
 *   3. Mengubah SATU baris access_log setelah anchoring membuat bukti tidak
 *      lagi cocok dengan akar lama -- ini inti nilai T1, dibuktikan terhadap
 *      database sungguhan, bukan terhadap data di memori.
 *   4. Majalah: id tak ada -> 404, id hilang -> 400.
 *
 * Kontrak seperti live test lain:
 *   - Tanpa DATABASE_URL: DILEWATI exit 0 (bukan bukti pass).
 *   - Tidak meninggalkan data: baris access_log ber-watermark `uji-f4a-*`
 *     dan anchor yang dibuat uji ini dihapus di `finally` lewat koneksi
 *     utama (owner, bypass RLS).
 *   - Logger akses TIDAK ditukar: uji ini justru butuh access_log nyata.
 *     Karena itu verifikasi dibatasi pada baris milik uji, dan baris yang
 *     ditulis oleh permintaan uji ikut dibersihkan lewat watermark endpoint.
 */

const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

try { require('dotenv').config(); } catch (e) {}

const app = require(path.join(__dirname, '..', 'index.js'));
const db = require(path.join(__dirname, '..', 'lib', 'db.js'));
const auditLogChain = require(path.join(__dirname, '..', 'lib', 'audit-log-chain.js'));
const anchorWorker = require(path.join(__dirname, '..', 'tools', 'worker-audit-anchor.js'));

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
  // Tunggu entri access_log permintaan ini selesai ditulis (event finish).
  await new Promise((r) => setTimeout(r, 30));
  return { status: res.status, body };
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.log('\nDLEWATI: tidak ada DATABASE_URL. Uji live tidak dijalankan (bukan bukti pass).');
    return;
  }
  berjalan = true;

  const utama = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  utama.on('error', () => {});

  const tanda = 'uji-f4a-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex');
  const endpointAir = '/' + tanda;

  let server = null;
  let idTerbuat = [];
  let anchorSebelum = [];
  let anchorSesudah = [];

  try {
    // Mode legacy: matikan verifikasi kunci supaya endpoint bisa dipanggil
    // tanpa menyemai instansi + kunci. Ini menguji route, bukan autentikasi.
    app.setCariKunci(null);

    // --- seed access_log langsung lewat koneksi utama (owner)
    const nilai = [];
    for (let i = 0; i < 4; i++) {
      nilai.push([
        'agency', 10 + i, 'Catin', JSON.stringify({ limit: 100 + i }),
        i === 0 ? 'success' : 'success', 1, endpointAir,
      ]);
    }
    const ins = await utama.query(
      'INSERT INTO access_log (actor_type, actor_id, category, params, result, response_rows, endpoint)' +
      ' VALUES ' + nilai.map((_, i) =>
        '($' + (i * 7 + 1) + ',$' + (i * 7 + 2) + ',$' + (i * 7 + 3) + ',$' + (i * 7 + 4) + '::jsonb,' +
        '$' + (i * 7 + 5) + ',$' + (i * 7 + 6) + ',$' + (i * 7 + 7) + ')').join(', ') +
      ' RETURNING id',
      nilai.flat()
    );
    idTerbuat = ins.rows.map((r) => Number(r.id)).sort((a, b) => a - b);
    ok('empat baris access_log ter-seed', idTerbuat.length === 4);
    const idTengah = idTerbuat[1];

    anchorSebelum = (await utama.query('SELECT id FROM audit_anchor')).rows.map((r) => String(r.id));

    server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    port = server.address().port;

    console.log('\n=== 1. Validasi parameter ===');

    const tanpaId = await minta('/api/v1/audit/proof');
    eq('tanpa id -> 400', tanpaId.status, 400);
    eq('kode INVALID_PARAM', tanpaId.body && tanpaId.body.code, 'INVALID_PARAM');

    const idSalah = await minta('/api/v1/audit/proof?id=abc');
    eq('id bukan angka -> 400', idSalah.status, 400);
    eq('kode INVALID_PARAM', idSalah.body && idSalah.body.code, 'INVALID_PARAM');

    const takAda = await minta('/api/v1/audit/proof?id=999999999');
    eq('id tak ada -> 404', takAda.status, 404);
    eq('kode AUDIT_ENTRY_NOT_FOUND', takAda.body && takAda.body.code, 'AUDIT_ENTRY_NOT_FOUND');

    console.log('\n=== 2. Bukti sebelum ada anchor uji ===');

    const sebelum = await minta('/api/v1/audit/proof?id=' + idTengah);
    eq('status 200', sebelum.status, 200);
    eq('success true', sebelum.body && sebelum.body.success, true);
    eq('access_log_id cocok', sebelum.body && sebelum.body.access_log_id, idTengah);
    eq('entry.access_log_id terikat', sebelum.body && sebelum.body.entry.detail.access_log_id, idTengah);
    eq('verifikasi mandiri lolos', auditLogChain.verifikasiBukti(sebelum.body), true);

    console.log('\n=== 3. Anchor akar (FR-8.1) ===');

    const ringkasan = await anchorWorker.sekali();
    ok('anchor tidak dilewati', ringkasan.dilewati === false, ringkasan.alasan || '');
    ok('anchor menyimpan akar hex64', /^[0-9a-f]{64}$/.test(ringkasan.anchor && ringkasan.anchor.root));
    ok('tx_hash NULL (Foundry belum ada)', ringkasan.anchor.tx_hash === null);

    anchorSesudah = (await utama.query('SELECT id FROM audit_anchor')).rows.map((r) => String(r.id));

    console.log('\n=== 4. Bukti TERTAUT ke akar yang tersimpan ===');

    const sesudah = await minta('/api/v1/audit/proof?id=' + idTengah);
    eq('status 200', sesudah.status, 200);
    eq('anchored true', sesudah.body && sesudah.body.anchored, true);
    eq('root == akar anchor', sesudah.body && sesudah.body.root, ringkasan.anchor.root);
    eq('verified_by_server true', sesudah.body && sesudah.body.verified_by_server, true);
    eq('verifikasi mandiri lolos', auditLogChain.verifikasiBukti(sesudah.body), true);
    ok('to_seq menutupi seq entri',
      Number(sesudah.body.anchor.to_seq) >= Number(sesudah.body.seq));
    eq('leafCount == leaf_count anchor',
      sesudah.body.leafCount, Number(sesudah.body.anchor.leaf_count));

    console.log('\n=== 5. Bukti entri lain tertaut ke akar yang sama ===');

    const idAkhir = idTerbuat[3];
    const lain = await minta('/api/v1/audit/proof?id=' + idAkhir);
    eq('entri lain anchored', lain.body && lain.body.anchored, true);
    eq('verified_by_server true', lain.body && lain.body.verified_by_server, true);
    eq('root sama dengan akar anchor', lain.body && lain.body.root, ringkasan.anchor.root);

    console.log('\n=== 6. Perubahan pasca-anchor terdeteksi (global) ===');

    await utama.query("UPDATE access_log SET result = 'error' WHERE id = $1", [idTengah]);

    const setelahUbah = await minta('/api/v1/audit/proof?id=' + idTengah);
    eq('status tetap 200', setelahUbah.status, 200);
    eq('anchored tetap true', setelahUbah.body && setelahUbah.body.anchored, true);
    ok('root TIDAK lagi sama dengan akar lama',
      setelahUbah.body.root !== ringkasan.anchor.root);
    eq('verified_by_server false', setelahUbah.body && setelahUbah.body.verified_by_server, false);
    eq('verifikasi mandiri juga gagal',
      auditLogChain.verifikasiBukti(setelahUbah.body), false);

    // Akar pohon berubah untuk SEMUA entri -- ini justru yang diinginkan:
    // satu baris diubah membuat seluruh batch tidak lagi cocok dengan akar lama.
    const lainUbah = await minta('/api/v1/audit/proof?id=' + idAkhir);
    eq('entri lain ikut gagal (akar global berubah)',
      lainUbah.body && lainUbah.body.verified_by_server, false);
  } finally {
    if (server) await new Promise((r) => server.close(r));

    if (berjalan) {
      await utama.query("DELETE FROM access_log WHERE endpoint LIKE $1", [endpointAir + '%']).catch(() => {});
      const baru = anchorSesudah.filter((id) => !anchorSebelum.includes(id));
      if (baru.length) {
        await utama.query('DELETE FROM audit_anchor WHERE id = ANY($1::bigint[])', [baru]).catch(() => {});
      }
      const sisaLog = (await utama.query(
        "SELECT count(*)::int AS n FROM access_log WHERE endpoint LIKE $1", [endpointAir + '%']
      ).catch(() => ({ rows: [{ n: -1 }] }))).rows[0].n;
      const sisaAnchor = (await utama.query(
        'SELECT count(*)::int AS n FROM audit_anchor WHERE id = ANY($1::bigint[])',
        [anchorSesudah.length ? anchorSesudah : ['0']]
      ).catch(() => ({ rows: [{ n: -1 }] }))).rows[0].n;
      console.log('\nbersih: ' + sisaLog + ' baris access_log, ' + sisaAnchor + ' anchor sisa');
    }

    await utama.end().catch(() => {});
    await db.matikan().catch(() => {});
  }

  console.log('\n' + (berjalan ? 'lulus: ' + passed + '   gagal: ' + failed : 'DILEWATI'));
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
