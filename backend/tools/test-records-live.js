/**
 * Uji live Query API F3.6 (`GET /api/v1/records`) terhadap PostgreSQL nyata.
 *
 * `tools/test-records-query.js` membuktikan keputusan yang murni: bentuk
 * permintaan, kodekursor, penolakan hibah, dan bentuk SQL. Yang TIDAK bisa
 * dibuktikannya, dan justru inti deliverable ini, ada di sini:
 *
 *   1. RLS benar-benar menapis baris (FR-4.2, FR-4.17) -- satu instansi tidak
 *      pernah melihat baris instansi lain, walau kueri tidak memfilter apa pun.
 *   2. `commitment` yang dikirim benar-benar `SHA256(record_hash ||
 *      institution_id)` milik PEMILIK (FR-4.3, koreksi 1.2), dan `record_hash`
 *      cocok dengan `payload_json` yang tersimpan.
 *   3. Penolakan eksplisit FR-4.6 sampai sebagai kode mesin yang benar.
 *   4. Paginasi kursor (FR-4.7) stabil terhadap penyisipan baris baru.
 *
 * Kontrak seperti `test-db-live.js` / `test-f1-live.js`:
 *   1. Tanpa `DATABASE_URL`, suite DILEWATI dengan exit 0 -- bukan bukti pass.
 *   2. Tidak boleh meninggalkan data. Semua baris di-watermark
 *      `uji-f3q-<ts>-<rand>` dan dihapus lewat koneksi utama (BYPASSRLS) di
 *      blok `finally`, termasuk bila uji gagal di tengah.
 *   3. Logger akses ditukar ke penangkap di memori supaya suite tidak menumpuk
 *      baris `access_log` di tabel produksi; pencatatan DB-nya sudah diuji
 *      terpisah (`test-db-live.js`, `test-access-log.js`).
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
let agencyAktif = 0;
const TOKEN = 'pa_sk_live_' + 'a'.repeat(43);
const tertangkap = [];

const loggerUji = accessLog.buatLogger({ sink: (entri) => { tertangkap.push(entri); } });

function ids(body) {
  return (body && Array.isArray(body.data) ? body.data : []).map((d) => d.record_id).sort();
}

function kodeTerakhir() {
  const e = tertangkap[tertangkap.length - 1];
  return e && e.result;
}

async function minta(jalur, opsi) {
  const o = opsi || {};
  if (o.agency) agencyAktif = o.agency === 'B' ? idB : idA;
  const headers = {};
  if (!o.tanpaKunci) headers.authorization = 'Bearer ' + TOKEN;
  const res = await fetch('http://127.0.0.1:' + port + jalur, { headers });
  const teks = await res.text();
  let body = null;
  try { body = JSON.parse(teks); } catch (e) {}
  await new Promise((r) => setTimeout(r, 20));
  return { status: res.status, body, teks, tipe: res.headers.get('content-type') || '' };
}

/** Payload 72-field bukan keharusan di uji ini: yang penting hash dihitung dari payload yang sama. */
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
  return Object.assign({}, o, {
    record_id: crypto.randomUUID(),
    payload,
    hash: c.recordHash(payload),
  });
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

async function main() {
  if (!process.env.DATABASE_URL) {
    console.log('\nDLEWATI: tidak ada DATABASE_URL. Uji live tidak dijalankan (bukan bukti pass).');
    return;
  }
  berjalan = true;

  const { Pool } = require('pg');
  const utama = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  utama.on('error', () => {});

  const tanda = 'uji-f3q-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  port = server.address().port;

  // Kuota longgar: yang diuji di sini otorisasi dan paginasi, bukan limiter.
  let recA1;
  let recA2;
  let recA3;
  let recA4;
  let recA5;
  let recB1;

  try {
    // -----------------------------------------------------------------------
    // 0. Seed: dua instansi dengan hibah BERBEDA, dan lima record A + satu B.
    // -----------------------------------------------------------------------
    const insA = await utama.query(
      'INSERT INTO agencies (institution_key, name) VALUES ($1, $2) RETURNING id',
      [tanda + '-a', 'Instansi uji F3.6-A']
    );
    const insB = await utama.query(
      'INSERT INTO agencies (institution_key, name) VALUES ($1, $2) RETURNING id',
      [tanda + '-b', 'Instansi uji F3.6-B']
    );
    idA = Number(insA.rows[0].id);
    idB = Number(insB.rows[0].id);

    for (const kat of ['Catin', 'Ibu Hamil']) {
      await utama.query(
        'INSERT INTO agency_categories (agency_id, jenis_sasaran) VALUES ($1, $2)', [idA, kat]
      );
    }
    await utama.query(
      'INSERT INTO agency_categories (agency_id, jenis_sasaran) VALUES ($1, $2)', [idB, 'Catin']
    );
    await utama.query(
      'INSERT INTO agency_desa_scope (agency_id, nama_kecamatan, nama_desa) VALUES ($1, $2, $3)',
      [idA, 'Cimanggis', 'Sukamaju']
    );

    const mk = (o) => buatRecord(Object.assign({ institusi: tanda + '-a' }, o));

    recA1 = mk({ jenis_sasaran: 'Catin', nama_kecamatan: 'Cimanggis', nama_desa: 'Sukamaju',
      nik: '3273011234560001', nama_lengkap: 'Ahmad Fauzi', nama_tpk: 'Siti Aminah',
      peran_tpk: 'TPK', tanggal: '2026-09-29', created_at: '2026-09-29T10:00:00Z',
      sections: ['B', 'I'], catatan: 'RAHASIA-A1' });
    recA2 = mk({ jenis_sasaran: 'Ibu Hamil', nama_kecamatan: 'Cimanggis', nama_desa: 'Sukamaju',
      nik: '3273011234560002', nama_lengkap: 'Sari Dewi', nama_tpk: 'Siti Aminah',
      peran_tpk: 'TPK', tanggal: '2026-09-28', created_at: '2026-09-28T10:00:00Z',
      sections: ['F'], catatan: 'RAHASIA-A2' });
    // Di luar wilayah A: RLS harus menyembunyikannya walau pemiliknya A.
    recA3 = mk({ jenis_sasaran: 'Catin', nama_kecamatan: 'Cimanggis', nama_desa: 'Luarmen',
      nik: '3273011234560003', nama_lengkap: 'Budi Santoso', nama_tpk: 'Siti Aminah',
      peran_tpk: 'TPK', tanggal: '2026-09-27', created_at: '2026-09-27T10:00:00Z',
      sections: ['B'] });
    // Kategori tidak dihibahkan ke A: RLS harus menyembunyikannya.
    recA4 = mk({ jenis_sasaran: 'Baduta', nama_kecamatan: 'Cimanggis', nama_desa: 'Sukamaju',
      nik: '3273011234560004', nama_lengkap: 'Dewi Lestari', nama_tpk: 'Siti Aminah',
      peran_tpk: 'TPK', tanggal: '2026-09-26', created_at: '2026-09-26T10:00:00Z',
      sections: ['F'] });
    // Redacted: tidak boleh muncul di Query API.
    recA5 = mk({ jenis_sasaran: 'Catin', nama_kecamatan: 'Cimanggis', nama_desa: 'Sukamaju',
      nik: '3273011234560005', nama_lengkap: 'Redaksi', nama_tpk: 'Siti Aminah',
      peran_tpk: 'TPK', tanggal: '2026-09-25', created_at: '2026-09-25T10:00:00Z',
      sections: ['B'], status: 'redacted' });
    recB1 = buatRecord({ institusi: tanda + '-b', jenis_sasaran: 'Catin',
      nama_kecamatan: 'OtherKec', nama_desa: 'OtherDesa', nik: '3273011234561001',
      nama_lengkap: 'Milik B', nama_tpk: 'Petugas B', peran_tpk: 'TPK',
      tanggal: '2026-09-24', created_at: '2026-09-24T10:00:00Z', sections: ['B'] });

    for (const r of [recA1, recA2, recA3, recA4, recA5, recB1]) await sisip(utama, r);

    // Identitas lewat kunci API: agency_id ditukar per permintaan.
    app.setCariKunci(async () => ({
      id: 1, agency_id: agencyAktif, key_prefix: 'uji', status: 'primary',
      category: null, table_name: null,
    }));
    app.limiter.aturKonfigurasi('id-' + idA, { kuota: 100000, jendelaMs: 60000, burst: 0 });
    app.limiter.aturKonfigurasi('id-' + idB, { kuota: 100000, jendelaMs: 60000, burst: 0 });
    app.gantiAccessLogger(loggerUji);

    // -----------------------------------------------------------------------
    // 1. RLS: penapisan di lapisan database (FR-4.2, FR-4.17)
    // -----------------------------------------------------------------------
    console.log('=== 1. RLS: isolasi instansi dan wilayah ===');

    let a = await minta('/api/v1/records', { agency: 'A' });
    eq('A tanpa filter: 200', a.status, 200);
    eq('A melihat tepat miliknya di wilayahnya', ids(a.body), [recA1.record_id, recA2.record_id].sort());
    eq('A tidak melihat baris luar wilayah', ids(a.body).includes(recA3.record_id), false);
    eq('A tidak melihat kategori yang tidak dihibahkan', ids(a.body).includes(recA4.record_id), false);
    eq('A tidak melihat baris redacted', ids(a.body).includes(recA5.record_id), false);
    eq('A tidak melihat baris instansi lain', ids(a.body).includes(recB1.record_id), false);
    eq('halaman lengkap: has_more false', a.body.has_more, false);
    eq('halaman lengkap: next_cursor null', a.body.next_cursor, null);
    eq('count cocok dengan data', a.body.count, 2);

    // Hibah RLS berbasis kategori+wilayah, BUKAN kepemilikan (ADR: satu record
    // bisa dibaca banyak instansi). B punya `Catin` dan tanpa batas wilayah,
    // jadi ia melihat SEMUA baris Catin aktif dari instansi mana pun -- tapi
    // bukan `Ibu Hamil` (tidak dihibahkan) dan bukan yang redacted.
    let b = await minta('/api/v1/records', { agency: 'B' });
    eq('B (Catin, tanpa batas wilayah) melihat semua baris Catin aktif lintas pemilik', ids(b.body),
      [recA1.record_id, recA3.record_id, recB1.record_id].sort());
    eq('B tidak melihat kategori yang tidak dihibahkan', ids(b.body).includes(recA2.record_id), false);
    eq('B tidak melihat baris redacted', ids(b.body).includes(recA5.record_id), false);

    // -----------------------------------------------------------------------
    // 2. Metadata per baris: commitment milik PEMILIK (FR-4.3, koreksi 1.2)
    // -----------------------------------------------------------------------
    console.log('\n=== 2. Metadata dan commitment per baris ===');

    const item = a.body.data.find((d) => d.record_id === recA1.record_id);
    ok('baris memuat record_id', !!item);
    eq('version berupa angka', item && item.version, 1);
    eq('sections ikut', item && item.sections, ['B', 'I']);
    eq('institution_id = pemilik', item && item.institution_id, tanda + '-a');
    eq('commitment = SHA256(record_hash || institution_id)',
      item && item.commitment, c.commitment(item.record_hash, tanda + '-a'));
    ok('catatanTPK (kolom diblokir bawaan) tidak ikut', item && item.catatanTPK === undefined);
    ok('nik ikut karena bukan kolom diblokir', item && typeof item.nik === 'string');

    const rowDb = await utama.query(
      'SELECT record_hash, payload_json FROM records WHERE record_id = $1', [recA1.record_id]
    );
    const payloadDb = typeof rowDb.rows[0].payload_json === 'string'
      ? JSON.parse(rowDb.rows[0].payload_json) : rowDb.rows[0].payload_json;
    eq('record_hash yang dikirim cocok dengan payload_json tersimpan',
      item.record_hash, c.recordHash(payloadDb));

    // -----------------------------------------------------------------------
    // 3. Penolakan eksplisit FR-4.6 (bukan halaman kosong)
    // -----------------------------------------------------------------------
    console.log('\n=== 3. Penolakan eksplisit FR-4.6 ===');

    tertangkap.length = 0;
    let tolak = await minta('/api/v1/records?kategori_1=Baduta', { agency: 'A' });
    eq('kategori sah tapi tidak dihibahkan: 403', tolak.status, 403);
    eq('kode kategori', tolak.body.code, 'CATEGORY_NOT_GRANTED');
    eq('tercatat denied_category (FR-4.4)', kodeTerakhir(), 'denied_category');

    tolak = await minta('/api/v1/records?desa=Luarmen', { agency: 'A' });
    eq('desa di luar wilayah: 403', tolak.status, 403);
    eq('kode desa', tolak.body.code, 'DESA_NOT_GRANTED');
    eq('tercatat denied_desa', kodeTerakhir(), 'denied_desa');

    tolak = await minta('/api/v1/records?fields=catatanTPK', { agency: 'A' });
    eq('meminta kolom diblokir: 403', tolak.status, 403);
    eq('kode kolom', tolak.body.code, 'FIELD_NOT_GRANTED');
    eq('tercatat denied_column', kodeTerakhir(), 'denied_column');

    tolak = await minta('/api/v1/records?fields=kolomHantu', { agency: 'A' });
    eq('kolom tidak dikenal: 400 FIELD_UNKNOWN', tolak.status, 400);
    eq('kode kolom asing', tolak.body.code, 'FIELD_UNKNOWN');

    tolak = await minta('/api/v1/records?kategori_1=Z', { agency: 'A' });
    eq('kategori di luar taksonomi: 400 INVALID_PARAM', tolak.status, 400);
    eq('kode param', tolak.body.code, 'INVALID_PARAM');

    tolak = await minta('/api/v1/records?limit=abc', { agency: 'A' });
    eq('limit bukan angka: 400 INVALID_PARAM', tolak.status, 400);
    eq('kode limit', tolak.body.code, 'INVALID_PARAM');

    tolak = await minta('/api/v1/records?cursor=bukan-kursor', { agency: 'A' });
    eq('kursor rusak: 400 INVALID_CURSOR', tolak.status, 400);
    eq('kode kursor', tolak.body.code, 'INVALID_CURSOR');

    // -----------------------------------------------------------------------
    // 4. Filter yang sah dan proyeksi `fields`
    // -----------------------------------------------------------------------
    console.log('\n=== 4. Filter sah dan proyeksi kolom ===');

    eq('kategori_1=Catin', ids((await minta('/api/v1/records?kategori_1=Catin', { agency: 'A' })).body),
      [recA1.record_id]);
    eq('kategori_2=B (section)', ids((await minta('/api/v1/records?kategori_2=b', { agency: 'A' })).body),
      [recA1.record_id]);
    eq('desa=Sukamaju', ids((await minta('/api/v1/records?desa=Sukamaju', { agency: 'A' })).body),
      [recA1.record_id, recA2.record_id].sort());
    eq('rentang tanggal', ids((await minta(
      '/api/v1/records?tanggal_mulai=2026-09-28&tanggal_selesai=2026-09-29', { agency: 'A' }
    )).body), [recA1.record_id, recA2.record_id].sort());

    const proy = await minta('/api/v1/records?fields=nik', { agency: 'A' });
    const pItem = proy.body.data[0];
    ok('fields=nik tetap memuat metadata', !!pItem.record_id && !!pItem.commitment);
    ok('fields=nik memuat nik', typeof pItem.nik === 'string');
    ok('fields=nik tidak memuat nama_lengkap', pItem.namaLengkap === undefined);
    ok('fields=nik tidak memuat kolom diblokir', pItem.catatanTPK === undefined);

    // -----------------------------------------------------------------------
    // 5. Paginasi kursor stabil terhadap data baru (FR-4.7)
    // -----------------------------------------------------------------------
    console.log('\n=== 5. Paginasi kursor (FR-4.7) ===');

    const hal1 = await minta('/api/v1/records?limit=1', { agency: 'A' });
    eq('halaman 1 berisi 1 baris', hal1.body.count, 1);
    eq('halaman 1 punya halaman berikutnya', hal1.body.has_more, true);
    ok('halaman 1 memberi next_cursor', typeof hal1.body.next_cursor === 'string' && hal1.body.next_cursor.length > 0);
    const idHal1 = hal1.body.data[0].record_id;
    eq('halaman 1 = baris terbaru', idHal1, recA1.record_id);

    // Sisipkan baris BARU setelah halaman 1 dibaca. Kursor berbasis keyset harus
    // mengabaikannya (ia lebih baru dari batas kursor), bukan menggesernya masuk.
    const recA6 = buatRecord({ institusi: tanda + '-a', jenis_sasaran: 'Catin',
      nama_kecamatan: 'Cimanggis', nama_desa: 'Sukamaju', nik: '3273011234560006',
      nama_lengkap: 'Baru Datang', nama_tpk: 'Siti Aminah', peran_tpk: 'TPK',
      tanggal: '2026-09-30', created_at: '2026-09-30T10:00:00Z', sections: ['B'] });
    await sisip(utama, recA6);

    const hal2 = await minta(
      '/api/v1/records?limit=1&cursor=' + encodeURIComponent(hal1.body.next_cursor), { agency: 'A' }
    );
    eq('halaman 2 berisi 1 baris', hal2.body.count, 1);
    eq('halaman 2 = baris berikutnya, bukan baris baru', hal2.body.data[0].record_id, recA2.record_id);
    eq('baris baru tidak menggeser halaman 2', hal2.body.data[0].record_id !== recA6.record_id, true);
    eq('halaman 2 tidak mengulang halaman 1', hal2.body.data[0].record_id !== idHal1, true);
    eq('halaman 2 selesai', hal2.body.has_more, false);
    eq('halaman 2 tanpa next_cursor', hal2.body.next_cursor, null);

    // Total tiga baris aktif sekarang (rA1, rA2, rA6); halaman tanpa batas harus lengkap.
    eq('daftar tanpa batas memuat ketiga baris aktif',
      ids((await minta('/api/v1/records', { agency: 'A' })).body),
      [recA1.record_id, recA2.record_id, recA6.record_id].sort());

    // -----------------------------------------------------------------------
    // 6. Format CSV ikut membawa metadata (FR-4.3 lintas format)
    // -----------------------------------------------------------------------
    console.log('\n=== 6. CSV: metadata di depan kolom payload ===');

    const csv = await minta('/api/v1/records?format=csv&fields=nik', { agency: 'A' });
    eq('CSV 200', csv.status, 200);
    ok('CSV bertipe text/csv', csv.tipe.includes('text/csv'), csv.tipe);
    const headerCsv = csv.teks.split('\r\n')[0];
    eq('header CSV diawali kolom metadata', headerCsv.split(',').slice(0, 3).join(','),
      'record_id,version,commitment');
    ok('header CSV memuat label NIK', headerCsv.includes('NIK'));
    ok('header CSV tidak memuat kolom diblokir', !headerCsv.includes('Catatan TPK'));

    // -----------------------------------------------------------------------
    // 7. Tanpa kredensial: ditolak autentikasi, bukan dibaca tanpa identitas
    // -----------------------------------------------------------------------
    console.log('\n=== 7. Tanpa kunci API ===');

    const tanpa = await minta('/api/v1/records', { tanpaKunci: true });
    eq('tanpa kunci: 401', tanpa.status, 401);
    eq('kode kunci hilang', tanpa.body && tanpa.body.code, 'MISSING_KEY');
  } finally {
    app.setCariKunci(null);
    await new Promise((r) => server.close(r));
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
  console.error('\nUji live F3.6 gagal dijalankan: ' + (e && e.stack || e));
  try { require('../lib/db.js').matikan().catch(() => {}); } catch (e2) {}
  process.exit(1);
});
