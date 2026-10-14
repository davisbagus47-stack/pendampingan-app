'use strict';

/**
 * Uji chain mati F3.12 (M-2, ADR-2) terhadap PostgreSQL nyata.
 *
 * M-2 menuntut: mematikan rantai (RPC ke contract) TIDAK boleh memblokir
 * Query API. Uji ini membuktikannya dengan menutup rantai secara sengaja --
 * panggilan anchor dibuat gagal total -- lalu memastikan `GET /api/v1/records`
 * tetap mengembalikan data.
 *
 * Keputusan F3.12 menetapkan tiga kasus yang wajib terbukti:
 *
 *   1. RPC mati -> query tetap mengembalikan data (M-2), dan baris outbox
 *      berakhir `failed` tanpa menggagalkan permintaan. Inilah inti ADR-2
 *      ("on-chain advisory"): kegagalan rantai menghentikan anchoring, bukan
 *      penyimpanan maupun pembacaan.
 *   2. Rantai audit (F4.1) tetap dapat diverifikasi; mengubah entri di tengah
 *      merusak verifikasi dan terdeteksi pada indeks yang tepat.
 *   3. `expectedHead` (F4.2) mendeteksi pemotongan di ujung yang TIDAK dapat
 *      dideteksi rantai hash sendiri. Ini keterbatasan yang ditulis terbuka di
 *      laporan, bukan disembunyikan sebagai kegagalan.
 *
 * Kasus 2 dan 3 tidak menyentuh database maupun RPC sama sekali -- itulah
 * pokoknya: integritas off-chain tetap dapat diperiksa walau rantai mati.
 *
 * Kontrak seperti `test-anchor-worker-live.js` / `test-records-live.js`:
 *   1. Tanpa `DATABASE_URL`, suite DILEWATI dengan exit 0 -- bukan bukti pass.
 *   2. Semua baris di-watermark `uji-f3c-<ts>-<rand>` dan dihapus di `finally`.
 *   3. `chain_outbox` tidak punya FK ke `records`; dihapus lewat record_id.
 */

const path = require('path');

const app = require(path.join(__dirname, '..', 'index.js'));
const db = require(path.join(__dirname, '..', 'lib', 'db.js'));
const c = require(path.join(__dirname, '..', 'lib', 'canonical.js'));
const accessLog = require(path.join(__dirname, '..', 'lib', 'access-log.js'));
const worker = require(path.join(__dirname, '..', 'tools', 'worker-anchor.js'));
const A = require(path.join(__dirname, '..', 'lib', 'audit-chain.js'));

try { require('dotenv').config(); } catch (e) {}

let passed = 0;
let failed = 0;
let berjalan = false;

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

// ---------------------------------------------------------------------------
// Kasus 2 dan 3: murni, tanpa database dan tanpa RPC.
// ---------------------------------------------------------------------------

const ENTRI = [
  { seq: 1, ts: '2026-10-01T08:00:00.000Z', actor: 'agency:a', action: 'query', resource: 'records', outcome: 'allow', detail: { rows: 2 } },
  { seq: 2, ts: '2026-10-01T08:00:01.000Z', actor: 'agency:a', action: 'export', resource: 'records', outcome: 'allow', detail: { format: 'csv' } },
  { seq: 3, ts: '2026-10-01T08:00:02.000Z', actor: 'agency:b', action: 'query', resource: 'records', outcome: 'deny', detail: { code: 'CATEGORY_NOT_GRANTED' } },
  { seq: 4, ts: '2026-10-01T08:00:03.000Z', actor: 'anon', action: 'query', resource: 'records', outcome: 'deny', detail: { code: 'AUTH_REQUIRED' } },
];

function kasusRantaiOffline() {
  console.log('=== 2. Rantai audit: entri diubah di tengah (F4.1) ===');

  const chain = A.buildChain(ENTRI);
  eq('rantai utuh lolos verifikasi', A.verifyChain(chain).ok, true);

  // Ubah isi entri TENGAH tanpa memperbaiki entry_hash-nya. Bila verifikasi
  // tidak menangkap ini, hash chain tidak membuktikan apa pun.
  const diubah = chain.map((e) => ({ ...e }));
  diubah[1].action = 'hapus';
  const vTengah = A.verifyChain(diubah);
  eq('entri tengah diubah: verifikasi gagal', vTengah.ok, false);
  eq('lokasi rusak tepat di indeks 1', vTengah.brokenAt, 1);
  ok('alasan menyebut entry_hash tidak cocok dengan isi',
    /entry_hash tidak cocok dengan isi/.test(vTengah.reason || ''), vTengah.reason);

  // Menyisipkan entri asing di tengah juga harus menggagalkan verifikasi.
  const disisip = chain.slice();
  disisip.splice(2, 0, { ...chain[1], seq: 3, detail: { palsu: true } });
  eq('entri disisipkan di tengah: verifikasi gagal', A.verifyChain(disisip).ok, false);

  console.log('\n=== 3. Pemotongan ujung dan expectedHead (F4.2) ===');

  const head = chain[chain.length - 1].entry_hash;
  // Buang entri terakhir. Rantai yang tersisa tetap konsisten dengan dirinya
  // sendiri, jadi verifikasi TANPA anchor tidak bisa mengetahuinya.
  const dipotong = chain.slice(0, chain.length - 1);

  eq('tanpa anchor: pemotongan ujung TIDAK terdeteksi (keterbatasan yang diakui)',
    A.verifyChain(dipotong).ok, true);
  eq('dengan expectedHead: pemotongan ujung terdeteksi',
    A.verifyChain(dipotong, { expectedHead: head }).ok, false);
  eq('rantai utuh + expectedHead benar: lolos',
    A.verifyChain(chain, { expectedHead: head }).ok, true);
}

// ---------------------------------------------------------------------------
// Kasus 1: live terhadap PostgreSQL. Query harus tetap melayani data walau
// panggilan anchor gagal total.
// ---------------------------------------------------------------------------

let port = 0;
const TOKEN = 'pa_sk_live_' + 'c'.repeat(43);
const tertangkap = [];

const loggerUji = accessLog.buatLogger({ sink: (entri) => { tertangkap.push(entri); } });

async function minta(jalur) {
  const res = await fetch('http://127.0.0.1:' + port + jalur, {
    headers: { authorization: 'Bearer ' + TOKEN },
  });
  const teks = await res.text();
  let body = null;
  try { body = JSON.parse(teks); } catch (e) {}
  await new Promise((r) => setTimeout(r, 20));
  return { status: res.status, body, teks };
}

function ids(body) {
  return (body && Array.isArray(body.data) ? body.data : []).map((d) => d.record_id).sort();
}

function buatRecord(o) {
  const payload = {
    namaTPK: o.nama_tpk,
    peranTPK: o.peran_tpk,
    namaDesa: o.nama_desa,
    namaKecamatan: o.nama_kecamatan,
    nik: o.nik,
    namaLengkap: o.nama_lengkap,
    jenisSasaran: o.jenis_sasaran,
    tanggalKunjungan: o.tanggal,
    catatanTPK: o.catatan || '',
  };
  return Object.assign({}, o, { payload, hash: c.recordHash(payload) });
}

async function sisip(utama, r) {
  await utama.query(
    'INSERT INTO records (' +
    'record_id, version, status, institution_id, record_hash, payload_json, sections, ' +
    'nama_tpk, peran_tpk, nama_desa, nama_kecamatan, nik, nama_lengkap, jenis_sasaran, ' +
    'tanggal_kunjungan, catatan_tpk, created_at' +
    ') VALUES ($1,1,$2,$3,$4,$5::jsonb,$6::text[],$7,$8,$9,$10,$11,$12,$13,$14::date,$15,$16)',
    [r.record_id, r.status || 'active', r.institusi, r.hash, JSON.stringify(r.payload),
      r.sections, r.nama_tpk, r.peran_tpk, r.nama_desa, r.nama_kecamatan,
      r.nik, r.nama_lengkap, r.jenis_sasaran, r.tanggal, r.catatan || '', r.created_at]
  );
}

async function outboxSatu(utama, recordId) {
  const res = await utama.query(
    'SELECT chain_status, attempts, next_retry_at, last_error, tx_hash' +
    ' FROM chain_outbox WHERE record_id = $1', [recordId]
  );
  const r = res.rows[0];
  if (!r) return null;
  return {
    chain_status: r.chain_status,
    attempts: Number(r.attempts) || 0,
    next_retry_at: r.next_retry_at === null ? null : new Date(r.next_retry_at).getTime(),
    last_error: r.last_error,
    tx_hash: r.tx_hash,
  };
}

async function main() {
  // Kasus 2 dan 3 tidak butuh prasarana: selalu dijalankan.
  kasusRantaiOffline();

  if (!process.env.DATABASE_URL) {
    console.log('\nDLEWATI: tidak ada DATABASE_URL. Bagian live (kasus 1) tidak dijalankan (bukan bukti pass).');
    return;
  }
  berjalan = true;

  const { Pool } = require('pg');
  const utama = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  utama.on('error', () => {});

  const tanda = 'uji-f3c-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  port = server.address().port;

  const rid1 = tanda + '-r1';
  const rid2 = tanda + '-r2';
  let comp1 = null;

  try {
    // -----------------------------------------------------------------------
    // 0. Seed: satu instansi ber-hibah Catin, dua record, satu baris outbox
    //    pending untuk record pertama.
    // -----------------------------------------------------------------------
    const ins = await utama.query(
      'INSERT INTO agencies (institution_key, name) VALUES ($1, $2) RETURNING id',
      [tanda, 'Instansi uji F3.12']
    );
    const idA = Number(ins.rows[0].id);
    await utama.query(
      'INSERT INTO agency_categories (agency_id, jenis_sasaran) VALUES ($1, $2)', [idA, 'Catin']
    );

    const rec1 = buatRecord({ institusi: tanda, nama_tpk: 'Petugas', peran_tpk: 'TPK',
      nama_desa: 'Sukamaju', nama_kecamatan: 'Cimanggis', nik: '3273011234570001',
      nama_lengkap: 'Satu', jenis_sasaran: 'Catin', tanggal: '2026-09-29',
      created_at: '2026-09-29T10:00:00Z', sections: ['B'], record_id: rid1 });
    const rec2 = buatRecord({ institusi: tanda, nama_tpk: 'Petugas', peran_tpk: 'TPK',
      nama_desa: 'Sukamaju', nama_kecamatan: 'Cimanggis', nik: '3273011234570002',
      nama_lengkap: 'Dua', jenis_sasaran: 'Catin', tanggal: '2026-09-28',
      created_at: '2026-09-28T10:00:00Z', sections: ['B'], record_id: rid2 });
    await sisip(utama, rec1);
    await sisip(utama, rec2);

    comp1 = c.commitment(rec1.hash, tanda);
    await utama.query(
      'INSERT INTO chain_outbox (record_id, version, supersedes_id, commitment, chain_status)' +
      ' VALUES ($1, 1, NULL, $2, $3)', [rid1, comp1, 'pending']
    );

    app.setCariKunci(async () => ({
      id: 1, agency_id: idA, key_prefix: 'uji', status: 'primary',
      category: null, table_name: null,
    }));
    app.limiter.aturKonfigurasi('id-' + idA, { kuota: 100000, jendelaMs: 60000, burst: 0 });
    app.gantiAccessLogger(loggerUji);

    // -----------------------------------------------------------------------
    // 1. Sebelum rantai mati: baseline query sehat.
    // -----------------------------------------------------------------------
    console.log('\n=== 1. RPC mati: query tetap melayani (M-2) ===');

    const sebelum = await minta('/api/v1/records');
    eq('baseline: 200', sebelum.status, 200);
    eq('baseline: kedua record terlihat', ids(sebelum.body), [rid1, rid2].sort());

    // -----------------------------------------------------------------------
    // 2. Tutup RPC: setiap panggilan anchor gagal. MAKS_CUBA=1 supaya baris
    //    langsung mencapai keadaan terminal `failed` dalam satu pass.
    // -----------------------------------------------------------------------
    const ringkasan = await worker.sekali({
      aturan: { MAKS_CUBA: 1, TUNDA_AWAL: 1000, GANDA: 2, TUNDA_MAKS: 100000 },
      batas: 50,
      tandai: async () => { throw new Error('ECONNREFUSED 127.0.0.1:8545 (RPC mati)'); },
    });
    const putusan1 = ringkasan.rincian.find((r) => r.record_id === rid1);
    ok('worker menandai record sebagai gagal, tidak melempar', !!putusan1 && putusan1.putusan === 'failed');

    const ob = await outboxSatu(utama, rid1);
    eq('outbox berakhir failed (terminal)', ob && ob.chain_status, 'failed');
    eq('outbox attempts = 1', ob && ob.attempts, 1);
    ok('outbox last_error menyebut RPC mati', /ECONNREFUSED/.test((ob && ob.last_error) || ''));
    eq('outbox belum punya tx_hash (tidak ter-anchor)', ob && ob.tx_hash, null);

    // -----------------------------------------------------------------------
    // 3. Sesudah rantai mati: query HARUS tetap mengembalikan data (inti M-2).
    // -----------------------------------------------------------------------
    const sesudah = await minta('/api/v1/records');
    eq('M-2: setelah RPC mati, query tetap 200', sesudah.status, 200);
    eq('M-2: data tetap lengkap meski outbox failed', ids(sesudah.body), [rid1, rid2].sort());

    const item = sesudah.body.data.find((d) => d.record_id === rid1);
    ok('M-2: record yang gagal di-anchor tetap dikembalikan', !!item);
    eq('M-2: commitment pemilik tetap benar', item && item.commitment, comp1);
    eq('M-2: record_hash tetap dibawa', item && item.record_hash, rec1.hash);

    // Filter tetap bekerja walau rantai mati.
    const filter = await minta('/api/v1/records?kategori_1=Catin');
    eq('M-2: filter kategori tetap bekerja', ids(filter.body), [rid1, rid2].sort());

    const eAkhir = tertangkap[tertangkap.length - 1];
    eq('M-2: permintaan sesudah rantai mati tercatat sukses (FR-4.4)',
      eAkhir && eAkhir.result, 'success');
  } finally {
    app.setCariKunci(null);
    await new Promise((r) => server.close(r));
    await utama.query('DELETE FROM chain_outbox WHERE record_id LIKE $1', [tanda + '%']).catch(() => {});
    await utama.query('DELETE FROM records WHERE institution_id LIKE $1', [tanda + '%']).catch(() => {});
    await utama.query('DELETE FROM agencies WHERE institution_key LIKE $1', [tanda + '%']).catch(() => {});
    await utama.end().catch(() => {});
    await db.matikan();
  }

  console.log('\nlulus: ' + passed + '   gagal: ' + failed);
  if (failed > 0) process.exit(1);
  console.log(berjalan ? '\nSEMUA UJI LOLOS (live terhadap database)' : '\nDILEWATI (tidak ada bukti)');
}

if (require.main === module) {
  main().catch((e) => {
    console.error('\nUji chain mati F3.12 gagal dijalankan: ' + (e && e.stack || e));
    try { require('../lib/db.js').matikan().catch(() => {}); } catch (e2) {}
    process.exit(1);
  });
}

module.exports = { kasusRantaiOffline };
