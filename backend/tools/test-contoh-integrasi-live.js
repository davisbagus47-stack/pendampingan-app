'use strict';

/**
 * Uji live FR-4.14/FR-4.15: menjalankan CONTOH INTEGRASI yang akan dipakai
 * instansi (Model B) terhadap server sungguhan, bukan memanggil `fetch` dari
 * dalam uji.
 *
 * Yang dibuktikan (kriteria keluar F3: "contoh integrasi dari dokumen
 * spesifikasi berhasil menarik data dan memverifikasi commitment"):
 *   1. `tools/contoh-integrasi-javascript.js` menarik `GET /api/v1/records`
 *      memakai kunci API dan memverifikasi commitment -- keluar 0.
 *   2. `tools/contoh-integrasi-python.py` melakukan hal yang sama dalam Python
 *      (pustaka standar) -- keluar 0.
 *   3. Keduanya juga memverifikasi ulang `record_hash` dari payload lokal
 *      (FR-4.14), bukan sekadar mempercayai nilai yang dikirim server.
 *
 * Kontrak seperti live test lain:
 *   - Tanpa `DATABASE_URL`: DILEWATI exit 0 (bukan bukti pass).
 *   - Data ber-watermark `uji-int-<ts>-<rand>` dan dihapus di `finally`.
 *   - Logger akses ditukar ke penangkap in-memory supaya tidak menumpuk baris.
 */

const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const app = require(path.join(__dirname, '..', 'index.js'));
const db = require(path.join(__dirname, '..', 'lib', 'db.js'));
const canonical = require(path.join(__dirname, '..', 'lib', 'canonical.js'));
const accessLog = require(path.join(__dirname, '..', 'lib', 'access-log.js'));

try { require('dotenv').config(); } catch (e) {}

let passed = 0;
let failed = 0;
let berjalan = false;

function ok(nama, kondisi, detail) {
  if (kondisi) { passed++; console.log('LULUS  ' + nama); }
  else {
    failed++;
    console.log('GAGAL  ' + nama + (detail === undefined ? '' : '   [' + detail + ']'));
  }
}

const TOKEN = 'pa_sk_live_' + 'a'.repeat(43);
const loggerUji = accessLog.buatLogger({ sink: () => {} });

async function main() {
  if (!process.env.DATABASE_URL) {
    console.log('\nDILEWATI: tidak ada DATABASE_URL. Uji live tidak dijalankan (bukan bukti pass).');
    return;
  }
  berjalan = true;

  const { Pool } = require('pg');
  const utama = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  utama.on('error', () => {});

  const tanda = 'uji-int-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
  let server = null;

  try {
    const ins = await utama.query(
      'INSERT INTO agencies (institution_key, name, contact) VALUES ($1, $2, $3) RETURNING id',
      [tanda, 'Instansi uji integrasi ' + tanda, 'kontak@uji.test']
    );
    const idA = Number(ins.rows[0].id);
    await utama.query(
      'INSERT INTO agency_categories (agency_id, jenis_sasaran) VALUES ($1, $2)', [idA, 'Catin']
    );

    const payload = {
      namaTPK: 'Siti Aminah',
      peranTPK: 'TPK',
      namaDesa: 'Sukamaju',
      namaKecamatan: 'Cimanggis',
      nik: '3273011234560001',
      namaLengkap: 'Ahmad Fauzi',
      jenisSasaran: 'Catin',
      tanggalKunjungan: '2026-09-29',
      catatanTPK: 'uji integrasi ' + tanda,
    };
    const recordId = crypto.randomUUID();
    const recordHash = canonical.recordHash(payload);
    await utama.query(
      'INSERT INTO records (' +
      'record_id, version, status, institution_id, record_hash, payload_json, sections, ' +
      'nama_tpk, peran_tpk, nama_desa, nama_kecamatan, nik, nama_lengkap, jenis_sasaran, ' +
      'tanggal_kunjungan, catatan_tpk' +
      ") VALUES ($1,1,'active',$2,$3,$4::jsonb,$5::text[],$6,$7,$8,$9,$10,$11,$12,$13::date,$14)",
      [recordId, tanda, recordHash, JSON.stringify(payload), ['B', 'I'],
        'Siti Aminah', 'TPK', 'Sukamaju', 'Cimanggis', '3273011234560001',
        'Ahmad Fauzi', 'Catin', '2026-09-29', 'uji integrasi ' + tanda]
    );

    // Identitas lewat kunci API (stub): token bentuk apa pun memetakan ke
    // instansi uji. Middleware SUNGGUHAN tetap dijalankan (bacaToken,
    // bentukValid, verifikasi), hanya pencarian hash-nya yang di-stub.
    app.setCariKunci(async () => ({
      id: 1, agency_id: idA, key_prefix: 'pa_sk_live_', status: 'primary',
      category: null, table_name: null,
    }));
    app.gantiAccessLogger(loggerUji);

    server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const port = server.address().port;

    const env = Object.assign({}, process.env, {
      PA_BASE_URL: 'http://127.0.0.1:' + port,
      PA_API_KEY: TOKEN,
      PA_KATEGORI: 'Catin',
      PA_PAYLOAD: JSON.stringify(payload),
    });

    console.log('\n=== 1. Contoh integrasi JavaScript menyentuh server sungguhan ===');
    const js = await jalankan(process.execPath, [path.join(__dirname, 'contoh-integrasi-javascript.js')], env);
    process.stdout.write(indent(js.stdout));
    process.stderr.write(indent(js.stderr));
    ok('contoh JavaScript keluar 0', js.status === 0, 'status=' + js.status);
    ok('contoh JavaScript melaporkan commitment konsisten', /OK: commitment/.test(js.stdout || ''));
    ok('contoh JavaScript menghitung record_hash dari payload lokal',
      /termasuk record_hash dari payload lokal/.test(js.stdout || ''));

    console.log('\n=== 2. Contoh integrasi Python menyentuh server sungguhan ===');
    const py = await jalankan('python', [path.join(__dirname, 'contoh-integrasi-python.py')], env);
    process.stdout.write(indent(py.stdout));
    process.stderr.write(indent(py.stderr));
    ok('contoh Python keluar 0', py.status === 0, 'status=' + py.status);
    ok('contoh Python melaporkan commitment konsisten', /OK: commitment/.test(py.stdout || ''));
    ok('contoh Python menghitung record_hash dari payload lokal',
      /termasuk record_hash dari payload lokal/.test(py.stdout || ''));

    console.log('\n=== 3. Penolakan kredensial tetap terbaca contoh ===');
    const envSalah = Object.assign({}, env, { PA_API_KEY: 'bukan-token' });
    const pySalah = await jalankan('python', [path.join(__dirname, 'contoh-integrasi-python.py')], envSalah);
    ok('contoh menolak token cacat dengan exit non-nol', pySalah.status !== 0, 'status=' + pySalah.status);
    ok('contoh mencetak kode mesin penolakan', /MALFORMED_KEY/.test(pySalah.stderr || ''));
  } finally {
    app.setCariKunci(null);
    if (server) await new Promise((r) => server.close(r));
    await utama.query('DELETE FROM records WHERE institution_id LIKE $1', [tanda + '%']).catch(() => {});
    await utama.query('DELETE FROM agencies WHERE institution_key LIKE $1', [tanda + '%']).catch(() => {});
    await db.matikan();
    await utama.end().catch(() => {});
  }

  console.log('\nlulus: ' + passed + '   gagal: ' + failed);
  if (failed > 0) process.exit(1);
  console.log(berjalan ? '\nSEMUA UJI LOLOS (contoh integrasi dijalankan terhadap server)' : '');
}

/**
 * Jalankan proses anak TANPA memblokir event loop, supaya server in-process
 * tetap bisa melayani permintaan HTTP-nya. `spawnSync` akan mematikan uji ini
 * (deadlock), jadi jangan diganti.
 */
function jalankan(cmd, args, env) {
  return new Promise((resolve) => {
    const anak = spawn(cmd, args, { env });
    let stdout = '';
    let stderr = '';
    const jam = setTimeout(() => anak.kill(), 30000);
    anak.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    anak.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    anak.on('error', (e) => { clearTimeout(jam); resolve({ status: -1, stdout, stderr: stderr + String(e) }); });
    anak.on('close', (status) => { clearTimeout(jam); resolve({ status, stdout, stderr }); });
  });
}

/** Beri indentasi agar keluaran anak terbaca sebagai bagian uji. */
function indent(teks) {
  if (!teks) return '';
  return teks.split('\n').map((b) => (b === '' ? '' : '    | ' + b)).join('\n') + '\n';
}

main().catch((e) => {
  console.error('\nUji live contoh integrasi gagal dijalankan: ' + (e && e.stack || e));
  try { require('../lib/db.js').matikan().catch(() => {}); } catch (e2) {}
  process.exit(1);
});
