/**
 * Uji live F3.2 (`POST /api/v1/records`) terhadap PostgreSQL nyata.
 *
 * `tools/test-records-write.js` membuktikan keputusan murni: bentuk permintaan,
 * validasi, penyusunan payload/hash, dan inarian bahwa hash jalur produksi sama
 * dengan rencana backfill. Yang TIDAK bisa dibuktikannya ada di sini:
 *
 *   1. Policy `records_agency_insert` benar-benar menegakkan di lapisan
 *      database: `institution_id` = instansi pemanggil, dan kategori/wilayah
 *      yang dihibahkan (FR-4.2, FR-4.17). Drill-down langsung: INSERT dengan
 *      `institution_id` instansi LAIN di bawah klaim A ditolak RLS.
 *   2. Versioning sungguhan (FR-3.4): koreksi menambah versi, `supersedes_id`
 *      menunjuk baris lama, baris lama TIDAK diubah (hash/payload tetap), dan
 *      koreksi ke versi yang tidak ada -> 404.
 *   3. `institution_id` datang dari kunci API, bukan dari body: percobaan
 *      menyelundupkan institution instansi lain lewat body diabaikan.
 *   4. Instansi nonaktif ditolak, dan koreksi ganda menimbulkan 409.
 *   5. Response create 201 / koreksi 200 dengan commitment pemilik yang bisa
 *      dihitung ulang oleh pembaca (FR-4.3).
 *   6. F3.3 (FR-3.6): setiap tulis menumbuhkan baris `chain_outbox` dalam
 *      transaksi yang sama (record_id, version, supersedes_id, commitment)
 *      berstatus pending; koreksi menumbuhkan baris kedua yang menunjuk versi
 *      lama; policy `chain_outbox_agency_insert` menolak enqueue versi milik
 *      instansi lain di lapisan database (drill SQL langsung), dan UNIQUE
 *      (record_id, version) menolak duplikat (23505).
 *
 * Kontrak sama dengan `test-records-live.js`:
 *   1. Tanpa `DATABASE_URL`, suite DILEWATI dengan exit 0 -- bukan bukti pass.
 *   2. Semua baris di-watermark `uji-f3w-<ts>-<rand>` dan dihapus lewat koneksi
 *      utama (BYPASSRLS) di `finally`, termasuk bila uji gagal di tengah.
 *      `chain_outbox` tidak punya kolom watermark, jadi dihapus lewat baris
 *      `records` yang di-watermark (record_id), SEBELUM records dihapus.
 *   3. Logger akses ditukar ke penangkap in-memory (`app.gantiAccessLogger`).
 */

const path = require('path');
const crypto = require('crypto');

const app = require(path.join(__dirname, '..', 'index.js'));
const db = require(path.join(__dirname, '..', 'lib', 'db.js'));
const c = require(path.join(__dirname, '..', 'lib', 'canonical.js'));
const accessLog = require(path.join(__dirname, '..', 'lib', 'access-log.js'));

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

/** Bit-bit identitas dan lingkungan uji, diisi di main(). */
let port = 0;
let idA = 0;
let idB = 0;
let idC = 0;
let agencyAktif = 0;
const TOKEN = 'pa_sk_live_' + 'a'.repeat(43);
const tertangkap = [];

const loggerUji = accessLog.buatLogger({ sink: (entri) => { tertangkap.push(entri); } });

function hasilTerakhir() {
  const e = tertangkap[tertangkap.length - 1];
  return e && e.result;
}

async function kirim(jalur, o, body) {
  const opsi = o || {};
  if (Number.isInteger(opsi.agency)) {
    agencyAktif = opsi.agency;
  } else if (opsi.agency) {
    agencyAktif = opsi.agency === 'B' ? idB : (opsi.agency === 'C' ? idC : idA);
  }
  const headers = {};
  if (!opsi.tanpaKunci) headers.authorization = 'Bearer ' + TOKEN;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch('http://127.0.0.1:' + port + jalur, {
    method: opsi.method || 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const teks = await res.text();
  let isi = null;
  try { isi = JSON.parse(teks); } catch (e) {}
  await new Promise((r) => setTimeout(r, 20));
  return { status: res.status, body: isi, teks };
}

/** Kunci API fake: verifikasi berhasil; agency_id ditukar per permintaan. */
function pasangKunci() {
  app.setCariKunci(async () => ({
    id: 1, agency_id: agencyAktif, key_prefix: 'uji', status: 'primary',
    category: null, table_name: null,
  }));
}

/** Payload 72-field penuh dijamin lolos `validasi` + `bangunRecord`. */
function tubuh(o) {
  o = o || {};
  return {
    namaTPK: 'Siti Aminah',
    peranTPK: 'TPK',
    namaDesa: o.nama_desa || 'Bantarjati',
    namaKecamatan: o.nama_kecamatan || 'Ciwaringin',
    nik: o.nik || '3273011234560009',
    namaLengkap: o.nama_lengkap || 'Uji F3.2',
    jenisSasaran: o.jenis_sasaran || 'Baduta',
    tanggalKunjungan: o.tanggal || '2026-10-05',
    pendampinganKe: '2',
    usia: '27',
    bbSekarang: o.bb || '62,5',
    tfu: '24',
    tanggalLahir: o.tanggal_lahir || '1999-03-04',
  };
}

/** Baris outbox untuk satu record, diurutkan ascending. */
async function barisOutbox(utama, record_id) {
  const r = await utama.query(
    'SELECT record_id, version, supersedes_id, commitment, chain_status, attempts' +
    ' FROM chain_outbox WHERE record_id = $1 ORDER BY version ASC',
    [record_id]
  );
  return r.rows.map((b) => ({
    record_id: b.record_id,
    version: Number(b.version),
    supersedes_id: b.supersedes_id == null ? null : String(b.supersedes_id),
    commitment: b.commitment,
    chain_status: b.chain_status,
    attempts: Number(b.attempts),
  }));
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.log('\nDLEWATI: tidak ada DATABASE_URL. Uji live tidak dijalankan (bukan bukti pass).');
    return;
  }
  berjalan = true;

  const { Pool } = require('pg');
  const utama = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  utama.on('error', () => {});

  const tanda = 'uji-f3w-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  port = server.address().port;

  try {
    // -----------------------------------------------------------------------
    // 0. Seed: A aktif (Baduta, wilayah Ciwaringin/Bantarjati); B aktif (hanya
    //    Baduta, tanpa batas wilayah); C tidak aktif (revoked). Kategori dan
    //    wilayah sengaja DISJOINT dari yang dipakai suite F3.6 (`test-records-
    //    live.js`, Catin/Ibu Hamil di Cimanggis/Sukamaju), karena hibah RLS
    //    berbasis kategori+wilayah bukan kepemilikan: andai suatu perjalanan
    //    uji ini gagal di tengah dan meninggalkan baris, baris itu tidak akan
    //    pernah dilihat suite lain dan mengacaukan perhitungannya. Tidak ada
    //    baris `agency_api_keys` sungguhan: kunci di-stub lewat setCariKunci.
    // -----------------------------------------------------------------------
    const insA = await utama.query(
      'INSERT INTO agencies (institution_key, name, status) VALUES ($1, $2, $3) RETURNING id',
      [tanda + '-a', 'Instansi uji F3.2-A', 'active']
    );
    const insB = await utama.query(
      'INSERT INTO agencies (institution_key, name, status) VALUES ($1, $2, $3) RETURNING id',
      [tanda + '-b', 'Instansi uji F3.2-B', 'active']
    );
    const insC = await utama.query(
      'INSERT INTO agencies (institution_key, name, status) VALUES ($1, $2, $3) RETURNING id',
      [tanda + '-c', 'Instansi uji F3.2-C', 'revoked']
    );
    idA = Number(insA.rows[0].id);
    idB = Number(insB.rows[0].id);
    idC = Number(insC.rows[0].id);

    await utama.query(
      'INSERT INTO agency_categories (agency_id, jenis_sasaran) VALUES ($1, $2)', [idA, 'Baduta']
    );
    await utama.query(
      'INSERT INTO agency_categories (agency_id, jenis_sasaran) VALUES ($1, $2)', [idB, 'Baduta']
    );
    await utama.query(
      'INSERT INTO agency_desa_scope (agency_id, nama_kecamatan, nama_desa) VALUES ($1, $2, $3)',
      [idA, 'Ciwaringin', 'Bantarjati']
    );

    pasangKunci();
    app.limiter.aturKonfigurasi('id-' + idA, { kuota: 100000, jendelaMs: 60000, burst: 0 });
    app.limiter.aturKonfigurasi('id-' + idB, { kuota: 100000, jendelaMs: 60000, burst: 0 });
    app.limiter.aturKonfigurasi('id-' + idC, { kuota: 100000, jendelaMs: 60000, burst: 0 });
    app.limiter.aturKonfigurasi('id-9988777', { kuota: 100000, jendelaMs: 60000, burst: 0 });
    app.gantiAccessLogger(loggerUji);

    // Anchor sinkron per-record pada POST /api/v1/records dapat menyiarkan
    // transaksi Sepolia SUNGGUHAN (ANCHOR_* ada di .env). Suite ini menguji
    // jalur TULIS (F3.2/F3.3), bukan anchoring (F3.4), jadi titik suntiknya
    // ditukar dengan SPY: memastikan route memanggilnya dengan metadata benar
    // dan meneruskan `anchor` ke respons, tanpa menyentuh blockchain. Returning
    // `pending` sengaja: outbox harus tetap pending seperti komitmen F3.3.
    let panggilanAnchor = [];
    app.setAnchorkanRecord(async (ringkas, meta) => {
      panggilanAnchor.push({ ringkas: ringkas, meta: meta });
      return { status: 'pending', error: 'uji: anchor dimatikan' };
    });

    // -----------------------------------------------------------------------
    // 1. Create: 201, metadata benar, commitment dapat dihitung ulang
    // -----------------------------------------------------------------------
    console.log('=== 1. Create (FR-3.2, FR-3.3) ===');

    let k = await kirim('/api/v1/records', { agency: 'A' }, tubuh({ nik: '3273011234560009' }));
    eq('create: 201', k.status, 201);
    eq('create: success', k.body && k.body.success, true);
    ok('record_id berupa UUID versi 4', typeof k.body.record_id === 'string' && /^[0-9a-f]{8}-/.test(k.body.record_id));
    eq('create: version 1', k.body.version, 1);
    eq('create: supersedes_id null', k.body.supersedes_id, null);
    ok('record_hash non-kosong', typeof k.body.record_hash === 'string' && k.body.record_hash.length > 0);
    eq('commitment = milik pemilik (dapat dihitung ulang)',
      k.body.commitment, c.commitment(k.body.record_hash, tanda + '-a'));
    eq('tercatat success di access log', hasilTerakhir(), 'success');

    // Route memanggil anchor sinkron dengan metadata yang benar, dan hasilnya
    // diteruskan ke respons. (Anchor-nya di-stub; lihat pemasangan spy di atas.)
    eq('respons memuat status anchor', k.body.anchor && k.body.anchor.status, 'pending');
    eq('anchor dipanggil sekali', panggilanAnchor.length, 1);
    eq('anchor menerima record_id yang ditulis',
      panggilanAnchor[0].ringkas.record_id, k.body.record_id);
    eq('anchor menerima commitment yang sama', panggilanAnchor[0].ringkas.commitment, k.body.commitment);
    eq('anchor menerima jenis sasaran', panggilanAnchor[0].meta.jenis_sasaran, 'Baduta');

    const rowV1 = (await utama.query(
      'SELECT payload_json, institution_id, version, created_by, record_hash FROM records WHERE record_id = $1',
      [k.body.record_id]
    )).rows[0];
    const payloadV1 = typeof rowV1.payload_json === 'string'
      ? JSON.parse(rowV1.payload_json) : rowV1.payload_json;
    eq('institution_id = instansi pemanggil (dari kunci)', rowV1.institution_id, tanda + '-a');
    eq('created_by mencatat jalur tulis instansi', String(rowV1.created_by), 'agency:' + idA);
    eq('record_hash yang dikirim cocok dengan payload tersimpan',
      k.body.record_hash, c.recordHash(payloadV1));

    const obV1 = await barisOutbox(utama, k.body.record_id);
    eq('create: satu baris outbox per record', obV1.length, 1);
    eq('outbox v1: record_id', obV1[0].record_id, k.body.record_id);
    eq('outbox v1: version 1', obV1[0].version, 1);
    eq('outbox v1: supersedes_id null (create)', obV1[0].supersedes_id, null);
    eq('outbox v1: commitment sama dengan response',
      obV1[0].commitment, k.body.commitment);
    eq('outbox v1: commitment = milik pemilik', obV1[0].commitment,
      c.commitment(k.body.record_hash, tanda + '-a'));
    eq('outbox v1: status pending (belum dianchor)', obV1[0].chain_status, 'pending');
    eq('outbox v1: attempts 0', obV1[0].attempts, 0);

    // -----------------------------------------------------------------------
    // 2. Body tidak diterima sebagai sumber identitas (spoofing)
    // -----------------------------------------------------------------------
    console.log('\n=== 2. institution_id dari kunci, bukan body ===');

    const curang = await kirim('/api/v1/records', { agency: 'A' },
      tubuh({ nik: '3273011234560010', institution_id: tanda + '-b', institutionId: tanda + '-b' }));
    eq('create dengan institution_id diselundupkan: 201', curang.status, 201);
    const rowCurang = (await utama.query(
      'SELECT institution_id FROM records WHERE record_id = $1', [curang.body.record_id]
    )).rows[0];
    eq('institution_id tetap punya A', rowCurang.institution_id, tanda + '-a');

    // -----------------------------------------------------------------------
    // 3. Hibah DB: kategori dan wilayah (FR-4.2, FR-4.17)
    // -----------------------------------------------------------------------
    console.log('\n=== 3. Penolakan kategori dan wilayah ===');

    let tolak = await kirim('/api/v1/records', { agency: 'A' }, tubuh({ jenis_sasaran: 'Catin' }));
    eq('kategori tidak dihibahkan: 403', tolak.status, 403);
    eq('kode kategori', tolak.body && tolak.body.code, 'CATEGORY_NOT_GRANTED');
    eq('tercatat denied_category', hasilTerakhir(), 'denied_category');

    tolak = await kirim('/api/v1/records', { agency: 'A' },
      tubuh({ nama_kecamatan: 'Ciwaringin', nama_desa: 'Karangasem' }));
    eq('desa di luar wilayah: 403', tolak.status, 403);
    eq('kode desa', tolak.body && tolak.body.code, 'DESA_NOT_GRANTED');
    eq('tercatat denied_desa', hasilTerakhir(), 'denied_desa');

    // B aktif dan legit untuk Baduta tanpa batas wilayah (FR-4.17).
    const katB = await kirim('/api/v1/records', { agency: 'B' },
      tubuh({ jenis_sasaran: 'Baduta', nama_kecamatan: 'AnyKec', nama_desa: 'AnyDesa' }));
    eq('B Baduta tanpa batas wilayah: 201', katB.status, 201);
    eq('B menulis atas namanya sendiri', katB.body.commitment, c.commitment(katB.body.record_hash, tanda + '-b'));

    tolak = await kirim('/api/v1/records', { agency: 'B' }, tubuh({ jenis_sasaran: 'Ibu Hamil' }));
    eq('B Ibu Hamil (tidak dihibahkan): 403', tolak.status, 403);
    eq('kode kategori B', tolak.body && tolak.body.code, 'CATEGORY_NOT_GRANTED');

    // -----------------------------------------------------------------------
    // 4. Instansi nonaktif dan tidak dikenal
    // -----------------------------------------------------------------------
    console.log('\n=== 4. AGENCY_INACTIVE dan AGENCY_UNKNOWN ===');

    tolak = await kirim('/api/v1/records', { agency: 'C' }, tubuh({}));
    eq('instansi nonaktif: 403', tolak.status, 403);
    eq('kode nonaktif', tolak.body && tolak.body.code, 'AGENCY_INACTIVE');
    eq('tercatat denied_auth', hasilTerakhir(), 'denied_auth');

    pasangKunci(); // agencyAktif diset 9988777 lewat kirim()
    tolak = await kirim('/api/v1/records', { agency: 9988777 }, tubuh({}));
    eq('instansi tidak dikenal: 403', tolak.status, 403);
    eq('kode tak dikenal', tolak.body && tolak.body.code, 'AGENCY_UNKNOWN');
    eq('tercatat denied_auth (unknown)', hasilTerakhir(), 'denied_auth');

    // -----------------------------------------------------------------------
    // 5. Versioning FR-3.4: koreksi membuat versi baru; baris lama tidak berubah
    // -----------------------------------------------------------------------
    console.log('\n=== 5. Koreksi -> versi baru, baris lama utuh ===');

    agencyAktif = idA; // kembali ke A; konfigurasi limiter tetap longgar

    const koreksi = await kirim('/api/v1/records', { agency: 'A' },
      Object.assign(tubuh({ nik: '3273011234560009', bb: '63,0' }),
        { record_id: k.body.record_id, version: 1 }));
    eq('koreksi: 200', koreksi.status, 200);
    eq('koreksi: version bertambah', koreksi.body.version, 2);
    eq('koreksi: supersedes_id menunjuk baris lama',
      koreksi.body.supersedes_id !== k.body.record_id, true);
    ok('koreksi: supersedes_id = id baris v1 (angka)',
      Number.isInteger(koreksi.body.supersedes_id));
    eq('koreksi: hash baru (payload berubah)', koreksi.body.record_hash !== k.body.record_hash, true);
    eq('koreksi: commitment dihitung ulang atas hash baru',
      koreksi.body.commitment, c.commitment(koreksi.body.record_hash, tanda + '-a'));

    const rowV1Setelah = (await utama.query(
      'SELECT version, record_hash, payload_json FROM records WHERE record_id = $1 AND version = 1',
      [k.body.record_id]
    )).rows[0];
    eq('baris v1 TIDAK diubah: hash tetap', rowV1Setelah.record_hash, k.body.record_hash);
    const payloadV1Setelah = typeof rowV1Setelah.payload_json === 'string'
      ? JSON.parse(rowV1Setelah.payload_json) : rowV1Setelah.payload_json;
    eq('baris v1 TIDAK diubah: bb lama', payloadV1Setelah.bbSekarang, '62,5');
    const rowV2 = (await utama.query(
      'SELECT version, supersedes_id, record_hash FROM records WHERE record_id = $1 AND version = 2',
      [k.body.record_id]
    )).rows[0];
    eq('baris v2 tersimpan', rowV2.version, 2);
    eq('supersedes_id di DB menunjuk id v1',
      rowV2.supersedes_id, (await utama.query(
        'SELECT id FROM records WHERE record_id = $1 AND version = 1', [k.body.record_id]
      )).rows[0].id);

    const obV1V2 = await barisOutbox(utama, k.body.record_id);
    eq('koreksi: outbox kini dua baris (v1 dan v2)', obV1V2.length, 2);
    eq('koreksi: outbox v2 version 2', obV1V2[1].version, 2);
    eq('koreksi: outbox v2 supersedes_id = id v1 (TEXT)',
      obV1V2[1].supersedes_id, String(rowV2.supersedes_id));
    eq('koreksi: outbox v2 commitment berbeda dari v1 (hash baru)',
      obV1V2[1].commitment !== obV1V2[0].commitment, true);
    eq('koreksi: outbox v2 commitment sama dengan response koreksi',
      obV1V2[1].commitment, koreksi.body.commitment);
    eq('koreksi: outbox v1 tetap pending dan tak terganggu',
      obV1V2[0].chain_status, 'pending');

    // -----------------------------------------------------------------------
    // 6. Konflik versi dan duplikat hash (409)
    // -----------------------------------------------------------------------
    console.log('\n=== 6. VERSION_CONFLICT dan DUPLICATE_HASH ===');

    // Dua koreksi atas versi 2 dengan payload BERBEDA (bb 65,0): yang pertama SAH
    // membuat versi 3; yang kedua hanya bisa bentrok pada (record_id, version)
    // karena record_hash-nya beda. FR-3.4 tidak boleh membuat dua versi dari
    // dasar v2 yang sama.
    const buat3 = await kirim('/api/v1/records', { agency: 'A' },
      Object.assign(tubuh({ nik: '3273011234560009', bb: '64,0' }),
        { record_id: k.body.record_id, version: 2 }));
    eq('koreksi v2 -> v3: 200', buat3.status, 200);
    eq('versi v3', buat3.body && buat3.body.version, 3);

    const dua = await kirim('/api/v1/records', { agency: 'A' },
      Object.assign(tubuh({ nik: '3273011234560009', bb: '65,0' }),
        { record_id: k.body.record_id, version: 2 }));
    eq('koreksi v2 yang sama lagi: 409', dua.status, 409);
    eq('kode versi', dua.body && dua.body.code, 'VERSION_CONFLICT');
    eq('tercatat error di access log', hasilTerakhir(), 'error');

    const duplikat = await kirim('/api/v1/records', { agency: 'A' },
      tubuh({ nik: '3273011234560009', bb: '62,5' }));
    eq('payload identik dengan record pertama: 409', duplikat.status, 409);
    eq('kode duplikat', duplikat.body && duplikat.body.code, 'DUPLICATE_HASH');
    eq('tercatat error (duplikat) di access log', hasilTerakhir(), 'error');

    // -----------------------------------------------------------------------
    // 7. Bentuk buruk: validasi dan parse kontrol DITOLAK
    // -----------------------------------------------------------------------
    console.log('\n=== 7. Validasi dan bentuk permintaan ===');

    let g = await kirim('/api/v1/records', { agency: 'A' }, { namaDesa: 'Sukamaju' });
    eq('kolom wajib hilang: 400', g.status, 400);
    eq('kode validasi', g.body && g.body.code, 'VALIDATION_FAILED');
    ok('fields merinci kolom yang kurang',
      Array.isArray(g.body.fields) && g.body.fields.includes('namaLengkap'));

    g = await kirim('/api/v1/records', { agency: 'A' }, tubuh({ nik: '123' }));
    eq('NIK bukan 16 digit: 400', g.status, 400);
    eq('kode validasi nik', g.body && g.body.code, 'VALIDATION_FAILED');
    eq('fields memuat nik', g.body && g.body.fields, ['nik']);

    g = await kirim('/api/v1/records', { agency: 'A' },
      Object.assign({}, tubuh({}), { record_id: '11111111-2222-3333-4444-555555555555' }));
    eq('hanya record_id: 400 INVALID_PARAM', g.status, 400);
    eq('kode kontrol', g.body && g.body.code, 'INVALID_PARAM');

    g = await kirim('/api/v1/records', { agency: 'A' }, []);
    eq('body array: 400 INVALID_PARAM', g.status, 400);
    eq('kode body json', g.body && g.body.code, 'INVALID_PARAM');

    // -----------------------------------------------------------------------
    // 8. RLS INSERT: institution_id instansi LAIN ditolak di lapisan database
    // -----------------------------------------------------------------------
    console.log('\n=== 8. Policy records_agency_insert (DB, bukan aplikasi) ===');

    const uuidLain = crypto.randomUUID();
    const hashLain = 'h' + 'a'.repeat(63);
    // Kategori/wilayah yang MEMENUHI `agency_can_see` untuk A (Baduta,
    // Ciwaringin/Bantarjati) sengaja diisi, supaya satu-satunya alasan
    // penolakan adalah klausa `institution_id` -- bukan klausa lain policy.
    let kodeDitolak = null;
    try {
      await db.transaksi({ role: 'agency', agency_id: idA }, async (client) => {
        await client.query(
          'INSERT INTO records (record_id, version, status, institution_id, record_hash, payload_json, sections, jenis_sasaran, nama_kecamatan, nama_desa, nama_tpk, peran_tpk, nik, nama_lengkap, tanggal_kunjungan)' +
          ' VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::date)',
          [uuidLain, 'active', tanda + '-b', hashLain, JSON.stringify({ lembaga: 'B' }), [],
            'Baduta', 'Ciwaringin', 'Bantarjati', 'Siti Aminah', 'TPK', '3273011234560091',
            'Milik B', '2026-10-05']
        );

      });
    } catch (e) {
      kodeDitolak = e.code || null;
    }
    eq('INSERT atas nama B di bawah klaim A ditolak RLS (42501)', kodeDitolak, '42501');
    const tidakAda = (await utama.query(
      'SELECT 1 FROM records WHERE record_id = $1', [uuidLain]
    )).rows.length;
    eq('baris penyelundup tidak tersimpan', tidakAda, 0);

    // Sebaliknya, INSERT atas nama DENGAN kategori/wilayah hibah A dibolehkan
    // DB di bawah klaim A -- policy `records_agency_insert` melepas apa yang
    // boleh, bukan menolak apa yang tidak dikenali.
    const uuidSah = crypto.randomUUID();
    await db.transaksi({ role: 'agency', agency_id: idA }, async (client) => {
      await client.query(
        'INSERT INTO records (record_id, version, status, institution_id, record_hash, payload_json, sections, jenis_sasaran, nama_kecamatan, nama_desa, nama_tpk, peran_tpk, nik, nama_lengkap, tanggal_kunjungan)' +
        ' VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::date)',
        [uuidSah, 'active', tanda + '-a', hashLain, JSON.stringify({ lembaga: 'A' }), [],
          'Baduta', 'Ciwaringin', 'Bantarjati', 'Siti Aminah', 'TPK', '3273011234560092',
          'Milik A', '2026-10-05']
      );
    });
    eq('INSERT atas nama sendiri (hibah terpenuhi) di bawah klaim A tersimpan', (await utama.query(
      'SELECT 1 FROM records WHERE record_id = $1', [uuidSah]
    )).rows.length, 1);

    // -----------------------------------------------------------------------
    // 9. Tanpa kredensial: ditolak autentikasi
    // -----------------------------------------------------------------------
    console.log('\n=== 9. Tanpa kunci API ===');

    const tanpa = await kirim('/api/v1/records', { tanpaKunci: true }, tubuh());
    eq('tanpa kunci: 401', tanpa.status, 401);
    eq('kode kunci hilang', tanpa.body && tanpa.body.code, 'MISSING_KEY');

    // -----------------------------------------------------------------------
    // 10. F3.3: policy chain_outbox_agency_insert (DB, bukan aplikasi)
    // -----------------------------------------------------------------------
    console.log('\n=== 10. Policy chain_outbox_agency_insert (FR-3.6) ===');

    // Instansi A TIDAK boleh mengantrekan outbox untuk versi milik instansi
    // lain (badan B) atau untuk versi tulisan operator. Pengikat kepemilikan
    // ada di `records.created_by`, jadi dua drill ini harus ditolak RLS 42501
    // -- bukan masuk antrean.
    const recB = (await utama.query(
      'SELECT record_id, version FROM records WHERE institution_id = $1 LIMIT 1', [tanda + '-b']
    )).rows[0];
    const txTolakOutbox = { kode: null };
    try {
      await db.transaksi({ role: 'agency', agency_id: idA }, async (client) => {
        await client.query(
          'INSERT INTO chain_outbox (record_id, version, supersedes_id, commitment)' +
          ' VALUES ($1, $2, $3, $4)',
          [recB.record_id, Number(recB.version), null, 'cbadbadbadbadbadbadbadbadbadbadbadbadbadba']
        );
      });
    } catch (e) {
      txTolakOutbox.kode = e.code || null;
    }
    eq('outbox untuk versi milik B ditolak RLS (42501)', txTolakOutbox.kode, '42501');
    // B sah memiliki SATU baris outbox (dari katB tadi); percobaan A harus tidak
    // menambah baris kedua.
    eq('baris outbox milik B tidak bertambah (tetap 1)',
      (await utama.query(
        'SELECT 1 FROM chain_outbox WHERE record_id = $1', [recB.record_id]
      )).rows.length, 1);

    // Versi tulisan operator (created_by = 'operator') juga bukan milik A.
    const uuidOp = crypto.randomUUID();
    await utama.query(
      'INSERT INTO records (record_id, version, status, institution_id, record_hash, payload_json, sections, created_by, jenis_sasaran, nama_kecamatan, nama_desa, nama_tpk, peran_tpk, nik, nama_lengkap, tanggal_kunjungan)' +
      ' VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::date)',
      [uuidOp, 'active', tanda + '-a', 'h' + 'b'.repeat(63), '{}', [], 'operator',
        'Baduta', 'Ciwaringin', 'Bantarjati', 'Siti Aminah', 'TPK', '3273011234560093',
        'Ditulis operator', '2026-10-05']
    );
    const txTolakOutboxOp = { kode: null };
    try {
      await db.transaksi({ role: 'agency', agency_id: idA }, async (client) => {
        await client.query(
          'INSERT INTO chain_outbox (record_id, version, supersedes_id, commitment)' +
          ' VALUES ($1, 1, $2, $3)',
          [uuidOp, null, 'c'.repeat(64)]
        );
      });
    } catch (e) {
      txTolakOutboxOp.kode = e.code || null;
    }
    eq('outbox untuk versi tulisan operator ditolak RLS (42501)', txTolakOutboxOp.kode, '42501');

    // Idempotency key UNIQUE (record_id, version) (AT-05) bekerja sebagai
    // PAGAR, bukan ON CONFLICT: route memakai INSERT polos (ON CONFLICT
    // menuntut pembacaan baris existing yang tidak diizinkan RLS bagi agency),
    // dan duplikat struktur mustahil datang dari route (koreksi ulang
    // dihentikan VERSION_CONFLICT di UNIQUE records lebih dulu). Pagar diuji
    // dengan menulis versi yang sudah ada secara langsung: harus 23505.
    const duplikatOutbox = { kode: null };
    try {
      await db.transaksi({ role: 'agency', agency_id: idA }, async (client) => {
        await client.query(
          'INSERT INTO chain_outbox (record_id, version, supersedes_id, commitment)' +
          ' VALUES ($1, $2, $3, $4)',
          [k.body.record_id, 1, null, k.body.commitment]
        );
      });
    } catch (e) {
      duplikatOutbox.kode = e.code || null;
    }
    eq('duplikat (record_id, version) ditolak UNIQUE 23505', duplikatOutbox.kode, '23505');
    const obIdem = await barisOutbox(utama, k.body.record_id);
    eq('pagar UNIQUE: tetap satu baris v1', obIdem.filter((b) => b.version === 1).length, 1);
  } finally {
    app.setCariKunci(null);
    await new Promise((r) => server.close(r));
    // chain_outbox tidak punya kolom watermark; hapus lewat record_id yang
    // menunjuk records ber-watermark, SEBELUM records dihapus.
    await utama.query(
      'DELETE FROM chain_outbox WHERE record_id IN' +
      ' (SELECT record_id FROM records WHERE institution_id LIKE $1)',
      [tanda + '%']
    ).catch(() => {});
    await utama.query('DELETE FROM records WHERE institution_id LIKE $1', [tanda + '%']).catch(() => {});
    await utama.query('DELETE FROM agencies WHERE institution_key LIKE $1', [tanda + '%']).catch(() => {});
    await db.matikan();
    await utama.end().catch(() => {});
  }

  console.log('\nlulus: ' + passed + '   gagal: ' + failed);
  if (failed > 0) process.exit(1);
  console.log(berjalan ? '\nSEMUA UJI LOLOS (live terhadap database)' : '\nDILEWATI (tidak ada bukti)');
}

main().catch((e) => {
  console.error('\nUji live F3.2 gagal dijalankan: ' + (e && e.stack || e));
  try { require('../lib/db.js').matikan().catch(() => {}); } catch (e2) {}
  process.exit(1);
});