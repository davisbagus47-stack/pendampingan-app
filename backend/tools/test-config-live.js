'use strict';

/**
 * Uji live F3.10c (`GET`/`PUT /api/v1/config`) terhadap PostgreSQL nyata.
 *
 * Yang tidak bisa dibuktikan uji murni `test-config.js`:
 *   1. Route sungguhan memakai identitas terverifikasi (kunci API F3.10a) dan
 *      menulis/membaca sebagai peran `agency` dengan klaim instansi pemanggil,
 *      jadi RLS `agency_config_own_write` benar-benar menegakkan "hanya baris
 *      sendiri" di lapisan database.
 *   2. UPSERT ganti-utuh tersimpan dan terbaca ulang.
 *   3. FR-4.11: perubahan konfigurasi muncul di `access_log` yang sama
 *      (category `config`, `params.konfigurasi` = nilai yang tersimpan).
 *   4. FR-4.12: nama dan kontak instansi tersedia di respons konfigurasi.
 *   5. FR-4.10 (kriteria keluar F3): kolom yang DISEMBUNYIKAN lewat
 *      `hidden_fields` tetap dapat diambil lewat Query API dan ekspor selama
 *      kategorinya dihibahkan -- menyembunyikan adalah preferensi tampilan,
 *      bukan pengurangan otorisasi.
 *
 * Kontrak seperti live test lain:
 *   - Tanpa `DATABASE_URL`: DILEWATI exit 0.
 *   - Tidak meninggalkan data: instansi ber-watermark `uji-cfg-*` dihapus di
 *     `finally` lewat koneksi utama (BYPASSRLS); `agency_config`,
 *     `agency_api_keys`, dll ikut lewat `ON DELETE CASCADE`. `records` TIDAK
 *     cascade (`institution_id` -> `agencies.institution_key` tanpa aksi),
 *     jadi barisnya dihapus lebih dulu (sejak bagian 6 menyemai record).
 *   - Logger akses ditukar ke penangkap di memori supaya tidak menumpuk baris
 *     `access_log` produksi; baris yang harus dicek dibaca dari penangkap.
 */

const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

try { require('dotenv').config(); } catch (e) {}

const app = require(path.join(__dirname, '..', 'index.js'));
const db = require(path.join(__dirname, '..', 'lib', 'db.js'));
const accessLog = require(path.join(__dirname, '..', 'lib', 'access-log.js'));
const canonical = require(path.join(__dirname, '..', 'lib', 'canonical.js'));

const FIELD_ORDER = app.FIELD_ORDER;
const { columnName } = require(path.join(__dirname, '..', 'lib', 'field-types.js'));
const KOLOM = FIELD_ORDER.map(columnName);

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

const tertangkap = [];
const loggerUji = accessLog.buatLogger({ sink: (entri) => { tertangkap.push(entri); } });

async function minta(jalur, opsi) {
  const o = opsi || {};
  const headers = {};
  if (o.token) headers.authorization = 'Bearer ' + o.token;
  if (o.metode !== 'GET' && o.badan !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch('http://127.0.0.1:' + port + jalur, {
    method: o.metode || 'GET',
    headers,
    body: o.badan === undefined ? undefined : JSON.stringify(o.badan),
  });
  const teks = await res.text();
  let body = null;
  try { body = JSON.parse(teks); } catch (e) {}
  return { status: res.status, body, teks };
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.log('\nDLEWATI: tidak ada DATABASE_URL. Uji live tidak dijalankan (bukan bukti pass).');
    return;
  }
  berjalan = true;

  const utama = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  utama.on('error', () => {});

  const rand = Date.now() + '-' + crypto.randomBytes(3).toString('hex');
  const kunciInstitusi = 'uji-cfg-' + rand; // pola slug: angka + tanda hubung, sah di CHECK
  const namaInstansi = 'Uji Konfigurasi ' + rand;
  const rahasia = crypto.randomBytes(32).toString('base64url');
  const TOKEN = 'pa_sk_live_' + rahasia;
  const keyHash = crypto.createHash('sha256').update(rahasia, 'utf8').digest('hex');

  let server = null;
  let idA = 0;

  try {
    const ins = await utama.query(
      "INSERT INTO agencies (institution_key, name, contact, status) VALUES ($1, $2, $3, 'active') RETURNING id",
      [kunciInstitusi, namaInstansi, 'kontak@uji.test']
    );
    idA = Number(ins.rows[0].id);
    await utama.query(
      'INSERT INTO agency_api_keys' +
      ' (agency_id, key_hash, key_prefix, status, category, table_name, label, issued_at, activated_at)' +
      ' VALUES ($1, $2, $3, $4::agency_key_status, NULL, NULL, $5, now(), now())',
      [idA, keyHash, 'pa_sk_live_', 'primary', 'uji konfigurasi']
    );

    app.gantiAccessLogger(loggerUji);
    server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    port = server.address().port;

    const f1 = KOLOM[0];
    const f2 = KOLOM[1];
    const f3 = KOLOM[2];

    console.log('\n=== 1. Identitas wajib ===');

    const tanpaKunci = await minta('/api/v1/config');
    eq('tanpa kunci -> 401', tanpaKunci.status, 401);

    console.log('\n=== 2. GET sebelum ada baris: bawaan ===');

    const awal = await minta('/api/v1/config', { token: TOKEN });
    eq('status 200', awal.status, 200);
    eq('agency_id', awal.body && awal.body.config.agency_id, idA);
    eq('agency_name terisi (FR-4.12)', awal.body && awal.body.config.agency_name, namaInstansi);
    eq('agency_contact terisi (FR-4.12)', awal.body && awal.body.config.agency_contact, 'kontak@uji.test');
    ok('hidden_fields bawaan kosong', Array.isArray(awal.body.config.hidden_fields) && awal.body.config.hidden_fields.length === 0);
    ok('column_order bawaan kosong', Array.isArray(awal.body.config.column_order) && awal.body.config.column_order.length === 0);
    eq('default_filters bawaan', awal.body && awal.body.config.default_filters, {});
    eq('default_format bawaan', awal.body && awal.body.config.default_format, 'json');

    console.log('\n=== 3. PUT valid tersimpan & terbaca ulang ===');

    const kirim = {
      hidden_fields: [f1, f2],
      column_order: [f3, f1],
      default_filters: { desa: ['Desa Harapan'], kategori_1: 'Catin' },
      default_format: 'xlsx',
    };
    const tulis = await minta('/api/v1/config', { token: TOKEN, metode: 'PUT', badan: kirim });
    eq('status 200', tulis.status, 200);
    eq('hidden_fields tersimpan', tulis.body && tulis.body.config.hidden_fields, [f1, f2]);
    eq('column_order tersimpan', tulis.body && tulis.body.config.column_order, [f3, f1]);
    eq('default_filters tersimpan', tulis.body && tulis.body.config.default_filters, kirim.default_filters);
    eq('default_format tersimpan', tulis.body && tulis.body.config.default_format, 'xlsx');
    ok('updated_at terisi', !!tulis.body.config.updated_at);

    const baca = await minta('/api/v1/config', { token: TOKEN });
    eq('GET setelah PUT cocok', baca.body && baca.body.config.hidden_fields, [f1, f2]);
    eq('format persisten', baca.body && baca.body.config.default_format, 'xlsx');

    const barisDb = (await utama.query(
      'SELECT updated_by FROM agency_config WHERE agency_id = $1', [idA]
    )).rows[0];
    eq('updated_by = agency:<id> (klaim RLS benar)', barisDb && barisDb.updated_by, 'agency:' + idA);

    console.log('\n=== 4. Penolakan bentuk (sebelum menyentuh baris) ===');

    eq('format tak dikenal -> 400 INVALID_FORMAT',
      (await minta('/api/v1/config', { token: TOKEN, metode: 'PUT', badan: { default_format: 'pdf' } })).status, 400);
    eq('kolom tak dikenal -> 400 FIELD_UNKNOWN',
      (await minta('/api/v1/config', { token: TOKEN, metode: 'PUT', badan: { hidden_fields: ['gg:rahasia'] } })).status, 400);
    eq('kunci puncak tak dikenal -> 400 VALIDATION_FAILED',
      (await minta('/api/v1/config', { token: TOKEN, metode: 'PUT', badan: { komentar: 'x' } })).status, 400);
    eq('badan bukan objek -> 400',
      (await minta('/api/v1/config', { token: TOKEN, metode: 'PUT', badan: [1, 2] })).status, 400);
    eq('badan kosong -> 400',
      (await minta('/api/v1/config', { token: TOKEN, metode: 'PUT', badan: {} })).status, 400);
    eq('filter tak dikenal -> 400',
      (await minta('/api/v1/config', { token: TOKEN, metode: 'PUT', badan: { default_filters: { ham: 1 } } })).status, 400);

    // Baris tidak boleh berubah karena pintu penolakan di atas.
    const masih = (await utama.query(
      'SELECT hidden_fields FROM agency_config WHERE agency_id = $1', [idA]
    )).rows[0];
    eq('baris utuh setelah penolakan', masih && masih.hidden_fields, [f1, f2]);

    console.log('\n=== 5. FR-4.11: perubahan tercatat di log akses yang sama ===');

    const entriConfig = tertangkap.filter((e) => e.endpoint === '/api/v1/config');
    const entriSukses = entriConfig.filter((e) => e.result === 'success');
    const entriPut = entriSukses.find((e) => e.category === 'config' && e.params && e.params.diubah);
    ok('ada entri access_log kategori config', !!entriPut);
    eq('hidden_fields tersimpan terlihat di log', entriPut && entriPut.params && entriPut.params.hidden_fields, [f1, f2]);
    eq('format tersimpan terlihat di log', entriPut && entriPut.params.default_format, 'xlsx');
    eq('filter diserialkan agar lulus sanitasi log', entriPut && JSON.parse(entriPut.params.default_filters), {
      desa: ['Desa Harapan'],
      kategori_1: 'Catin',
    });
    eq('kunci yang diubah tercantum', entriPut && entriPut.params.diubah, ['hidden_fields', 'column_order', 'default_filters', 'default_format']);
    eq('aktor config = instansi', entriPut && entriPut.actor_id, idA);

    console.log('\n=== 6. FR-4.10: kolom yang disembunyikan konfigurasi TETAP di API ===');

    // Hibah `Catin` supaya instansi boleh membaca record (tanpa itu justru
    // ditolak CATEGORY_NOT_GRANTED -- kriteria F3 yang lain).
    await utama.query('INSERT INTO agency_categories (agency_id, jenis_sasaran) VALUES ($1, $2)', [idA, 'Catin']);

    const payloadUji = {
      namaTPK: 'Petugas Uji', peranTPK: 'TPK', namaDesa: 'Desa Harapan',
      namaKecamatan: 'Cimanggis', nik: '3273011234560001', namaLengkap: 'Ahmad Fauzi',
      jenisSasaran: 'Catin', tanggalKunjungan: '2026-09-29', catatanTPK: 'uji config ' + rand,
    };
    await utama.query(
      'INSERT INTO records (record_id, version, status, institution_id, record_hash, payload_json, sections,' +
      ' nama_tpk, peran_tpk, nama_desa, nama_kecamatan, nik, nama_lengkap, jenis_sasaran, tanggal_kunjungan, catatan_tpk)' +
      " VALUES ($1,1,'active',$2,$3,$4::jsonb,$5::text[],$6,$7,$8,$9,$10,$11,$12,$13::date,$14)",
      [crypto.randomUUID(), kunciInstitusi, canonical.recordHash(payloadUji),
        JSON.stringify(payloadUji), ['B', 'I'],
        'Petugas Uji', 'TPK', 'Desa Harapan', 'Cimanggis', '3273011234560001',
        'Ahmad Fauzi', 'Catin', '2026-09-29', 'uji config ' + rand]
    );

    const kolomDesa = columnName('namaDesa');
    const sembunyi = await minta('/api/v1/config', {
      token: TOKEN, metode: 'PUT', badan: { hidden_fields: [kolomDesa] },
    });
    eq('konfigurasi menyembunyikan nama_desa', sembunyi.body && sembunyi.body.config.hidden_fields, [kolomDesa]);

    const hasilJson = await minta('/api/v1/records?kategori_1=Catin', { token: TOKEN });
    eq('records: status 200', hasilJson.status, 200);
    const barisUji = (hasilJson.body && hasilJson.body.data ? hasilJson.body.data : [])
      .find((r) => r.namaDesa === 'Desa Harapan');
    ok('kolom tersembunyi konfigurasi TETAP dikembalikan API (FR-4.10)', !!barisUji);
    eq('nilai kolom tersembunyi utuh', barisUji && barisUji.namaDesa, 'Desa Harapan');
    ok('metadata commitment tetap ikut walau ada kolom disembunyikan',
      !!(barisUji && barisUji.commitment && barisUji.record_hash));

    const hasilCsv = await minta('/api/v1/records?kategori_1=Catin&format=csv', { token: TOKEN });
    ok('ekspor CSV juga memuat kolom tersembunyi', /Desa Harapan/.test(hasilCsv.teks || ''));
  } finally {
    if (server) await new Promise((r) => server.close(r));

    if (berjalan) {
      const sisa = (await utama.query(
        'SELECT count(*)::int AS n FROM agencies WHERE institution_key LIKE $1',
        ['uji-cfg-%']
      ).catch(() => ({ rows: [{ n: -1 }] }))).rows[0].n;
      await utama.query('DELETE FROM records WHERE institution_id LIKE $1', ['uji-cfg-%']).catch(() => {});
      await utama.query('DELETE FROM agencies WHERE institution_key LIKE $1', ['uji-cfg-%']).catch(() => {});
      const sisaKunci = (await utama.query(
        'SELECT count(*)::int AS n FROM agency_api_keys WHERE key_hash = $1', [keyHash]
      ).catch(() => ({ rows: [{ n: -1 }] }))).rows[0].n;
      console.log('\nbersih: ' + sisa + ' instansi uji, ' + sisaKunci + ' kunci uji tersisa');
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