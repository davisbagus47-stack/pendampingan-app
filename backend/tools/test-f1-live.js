/**
 * Uji live F1.8 + F1.9 terhadap PostgreSQL sungguhan.
 *
 * F1.8 (sisa): SQL yang dihasilkan `tools/backfill.js` (sqlUntuk) BENAR-BENAR
 * bisa dieksekusi di server nyata. `tools/test-backfill.js` sengaja tidak
 * membuktikan itu -- butuh database. Suite ini menutup celahnya: mengeksekusi
 * SQL backfill yang dihasilkan dari baris contoh ke Supabase, lalu membaca
 * kembali dan memeriksa jumlah serta hash.
 *
 * F1.9 (sisa): round-trip lewat PostgreSQL nyata. Jalur tulis produksi
 * (form body -> buildRow -> payload -> recordHash) ditulis sebagai satu baris
 * `records` di server sungguhan, dibaca kembali, dan hash ulang dari
 * `payload_json` harus sama dengan yang tertulis. Inilah yang tadinya
 * "terkunci F1.8a" -- sekarang F1.8a sudah selesai dan jembatannya terbuka.
 *
 * Kontrak suite seperti `test-db-live.js`:
 *   1. Tanpa `DATABASE_URL`, suite DILEWATI dengan exit 0. Regresi murni tetap
 *      hijau tanpa database; "DLEWATI" bukan bukti pass.
 *   2. Tidak boleh meninggalkan data. Setiap baris yang ditulis di-watermark
 *      `uji-f1live-<ts>-<rand>` (institution_key dan/atau record_id) dan
 *      dihapus lewat koneksi utama (BYPASSRLS) di blok `finally` -- termasuk
 *      ketika uji gagal di tengah. `records` tidak append-only (bisa dihapus),
 *      tapi tetap tidak boleh menumpuk data uji di tabel produksi.
 */

const db = require('../lib/db.js');
const path = require('path');
const crypto = require('crypto');

const app = require(path.join(__dirname, '..', 'index.js'));
const { FIELD_ORDER, buildRow, NORMALIZE_SASARAN } = app;
const c = require(path.join(__dirname, '..', 'lib', 'canonical'));
const { proyeksi } = require(path.join(__dirname, '..', 'lib', 'backfill.js'));
const { NUMERIC_FIELDS, DATE_FIELDS, columnName } =
  require(path.join(__dirname, '..', 'lib', 'field-types.js'));
const sections = require(path.join(__dirname, '..', 'lib', 'sections.js'));
const cli = require(path.join(__dirname, 'backfill.js'));

// dotenv dimuat malas (pola sama test-db-live.js): skrip tetap jalan bila paket
// tidak ada, dan tanpa memaksa .env bila DATABASE_URL sudah ada di lingkungan.
try {
  require('dotenv').config();
} catch (e) {}

const { map: sectionMap } = sections.deriveSections();

const DATE_ORDER = 'ddmmyyyy';

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

function eqIsh(aktual, diharapkan, nama) {
  const a = JSON.stringify(aktual);
  const b = JSON.stringify(diharapkan);
  const label = nama || 'nilai sama (' + a + ')';
  if (a === b) { passed++; console.log('LULUS  ' + label); }
  else { failed++; console.log('GAGAL  ' + label + '   dapat ' + a + '   diharapkan ' + b); }
}

/** Bandingkan isi dua objek berapa pun urutan kunci JSON-nya (jsonb mengurutkan). */
function samaIsi(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] !== kb[i]) return false;
    if (!samaIsi(a[ka[i]], b[ka[i]])) return false;
  }
  return true;
}

/**
 * Simulasikan jalur tulis produksi: body form -> baris sheet -> payload string.
 * Meniru `test-roundtrip.js` (writeToSheet/readFromSheet) supaya uji DB ini
 * memakai payload yang SAMA BENTUKNYA dengan round-trip non-DB.
 */
function payloadDariForm(body) {
  const row = [String(1), ...buildRow(body)];
  const payload = {};
  for (const f of FIELD_ORDER) {
    const i = row.length - FIELD_ORDER.length + FIELD_ORDER.indexOf(f);
    payload[f] = i !== undefined && row[i] !== undefined ? String(row[i]).trim() : '';
  }
  return payload;
}

/** Body form Catin yang valid (semua kolom NOT NULL terisi). */
function formCatin() {
  return {
    namaTPK: 'Siti Aminah',
    peranTPK: 'TPK',
    namaDesa: 'Sukamaju',
    namaKecamatan: 'Cimanggis',
    rw: '0A',
    rt: '005',
    nik: '3273011234560001',
    noKK: '3273011234560002',
    namaLengkap: 'Ahmad Fauzi',
    alamat: 'Jl. Merdeka No. 3',
    tanggalKunjungan: '2026-09-29',
    pendampinganKe: '1',
    jenisSasaran: 'Calon Pengantin',
    jenisKelamin: 'Laki-laki',
    usia: '25',
    tanggalLahir: '2001-04-12',
  };
}

/**
 * INSERT parameterized satu baris `records` tanpa memakai sqlUntuk -- jalur
 * tulis langsung yang akan dipakai POST /records (F3.2). Metadata + 72 kolom
 * proyeksi, sama dengan bentuk yang dihasilkan `sqlUntuk`.
 */
function insertRecord(client, r) {
  const metadata = ['record_id', 'version', 'status', 'schema_version',
    'institution_id', 'record_hash', 'payload_json', 'sections'];
  const kolom = metadata.concat(FIELD_ORDER.map(columnName));
  const payload = r.payload_json || {};

  const nilai = [
    r.record_id, r.version, r.status, r.schema_version,
    r.institution_id, r.record_hash,
    JSON.stringify(payload),
    r.sections || [],
  ].concat(FIELD_ORDER.map((f) => {
    const proy = r.proyeksi || {};
    if (NUMERIC_FIELDS.has(f)) {
      const v = proy[f];
      return v === null || v === undefined ? null : String(v);
    }
    if (DATE_FIELDS.has(f)) {
      const v = proy[f];
      return v === null || v === undefined ? null : v;
    }
    const t = payload[f];
    return t === undefined || t === null ? '' : String(t);
  }));

  const ph = kolom.map((k, i) => {
    const n = i + 1;
    if (k === 'payload_json') return '$' + n + '::jsonb';
    if (k === 'sections') return '$' + n + '::text[]';
    return '$' + n;
  }).join(', ');
  return client.query(
    'INSERT INTO records (' + kolom.join(', ') + ') VALUES (' + ph + ')',
    nilai
  );
}

/** Jalankan isi SQL `sqlUntuk` (tanpa wrapper BEGIN/COMMIT) sebagai operator. */
async function eksekusiSqlBackfill(sql) {
  const blocks = sql
    .split('\n\n')
    .filter((b) => b.includes('INSERT INTO records'));
  if (blocks.length === 0) throw new Error('SQL backfill tidak memuat INSERT apa pun');
  await db.transaksi({ role: 'operator', agency_id: null }, async (client) => {
    for (const b of blocks) await client.query(b);
  });
  return blocks.length;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.log('\nDLEWATI: tidak ada DATABASE_URL. Uji live tidak dijalankan (bukan bukti pass).');
    return;
  }
  berjalan = true;

  // Koneksi utama hanya untuk verifikasi & pembersihan, dipakai SEMPAT lalu
  // dilepas. Aplikasi tidak pernah memakai peran ini.
  const { Pool } = require('pg');
  const utama = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  utama.on('error', () => {});

  // institution_key hanya boleh [a-z0-9-] (CHECK di skema).
  const tanda = 'uji-f1live-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);

  try {
    // Prasyarat FK: records.institution_id REFERENCES agencies(institution_key).
    // Instansi uji dibuat sebagai operator (policy agencies_operator_insert),
    // persis seperti konsol admin akan membuat instansi.
    let galatAgen = null;
    try {
      await db.transaksi({ role: 'operator', agency_id: null }, async (client) => {
        await client.query(
          'INSERT INTO agencies (institution_key, name) VALUES ($1, $2)',
          [tanda, 'Instansi uji F1.8/F1.9']
        );
      });
    } catch (e) {
      galatAgen = e;
    }
    ok('instansi uji dibuat sebagai operator', !galatAgen, galatAgen && galatAgen.message);
    if (galatAgen) throw galatAgen;

    // -------------------------------------------------------------------------
    // F1.9: round-trip lewat PostgreSQL nyata.
    //   1. payload dari jalur tulis produksi (buildRow, bukan dari backfill).
    //   2. hash dihitung SEBELUM menyentuh database.
    //   3. INSERT sebagai operator (policy records_operator_all).
    //   4. Baca kembali, hash ulang payload_json -- harus sama, dan kolom
    //      bertipe khusus harus tersimpan sesuai proyeksi.
    // -------------------------------------------------------------------------
    console.log('=== 1. F1.9: round-trip lewat PostgreSQL nyata ===');

    const body = formCatin();
    const payload = payloadDariForm(body);
    payload.jenisSasaran = NORMALIZE_SASARAN[String(payload.jenisSasaran).toLowerCase()] || payload.jenisSasaran;
    const hash = c.recordHash(payload);
    ok('payload berbentuk 72 field string', Object.keys(payload).length === FIELD_ORDER.length);
    ok('hash dihitung tanpa database', /^[0-9a-f]{64}$/.test(hash));

    const proy = proyeksi(payload, FIELD_ORDER, DATE_ORDER);
    ok('proyeksi tanggal_kunjungan terbaca', proy.tanggalKunjungan === '2026-09-29', String(proy.tanggalKunjungan));
    ok('proyeksi usia numerik terbaca', Math.abs(proy.usia - 25) < 1e-9, String(proy.usia));

    const rec = {
      record_id: crypto.randomUUID(),
      version: 1,
      status: 'active',
      schema_version: c.SCHEMA_VERSION,
      institution_id: tanda,
      record_hash: hash,
      payload_json: payload,
      sections: sections.sectionsFor(sectionMap, payload),
      proyeksi: proy,
    };

    let galatInsert = null;
    try {
      await db.transaksi({ role: 'operator', agency_id: null }, (client) => insertRecord(client, rec));
    } catch (e) {
      galatInsert = e;
    }
    ok('INSERT round-trip sebagai operator tidak melempar', !galatInsert, galatInsert && galatInsert.message);
    if (galatInsert) throw galatInsert;

    const baca = await utama.query(
      'SELECT record_id, record_hash, payload_json, sections,' +
      " tanggal_kunjungan::text AS tanggal_kunjungan, usia FROM records WHERE record_id = $1",
      [rec.record_id]
    );
    ok('satu baris terbaca ulang', baca.rows.length === 1, JSON.stringify(baca.rows));

    if (baca.rows.length === 1) {
      const r = baca.rows[0];
      const tersimpan = typeof r.payload_json === 'string' ? JSON.parse(r.payload_json) : r.payload_json;
      const hashUlang = c.recordHash(tersimpan);
      ok('hash ulang dari database sama dengan hash sebelum tulis', hashUlang === hash, hashUlang);
      eqIsh(samaIsi(tersimpan, payload), true, 'payload_json pulang tanpa berubah');
      eqIsh(String(r.record_hash), hash, 'kolom record_hash di DB cocok');
      // Dibaca sebagai teks (`tanggal_kunjungan::text`), bukan Date: node-pg
      // mengurai DATE ke tengah malam zona waktu lokal, dan toISOString()
      // menggesernya ke hari sebelumnya di WIB -- nilai di database benar,
      // konversi JS yang menyesatkan.
      eqIsh(String(r.tanggal_kunjungan), '2026-09-29', 'kolom DATE terbaca benar');
      eqIsh(Number(r.usia), 25, 'kolom NUMERIC terbaca benar');
      ok('NIK tidak berubah', (tersimpan.nik || '') === body.nik, String(tersimpan.nik));
      ok('RW/RT tetap teks', tersimpan.rw === '0A' && tersimpan.rt === '005',
        (tersimpan.rw || '') + '/' + (tersimpan.rt || ''));
    }

    // -------------------------------------------------------------------------
    // F1.8: SQL backfill benar-benar bisa dieksekusi di server nyata.
    //   Baris contoh -> rencanaBackfill -> sqlUntuk -> eksekusi sebagai
    //   operator. Dijalankan DUA KALI: idempotensi ON CONFLICT DO NOTHING
    //   harus terbukti di server, bukan hanya di bentuk teks SQL.
    // -------------------------------------------------------------------------
    console.log('\n=== 2. F1.8: eksekusi SQL backfill di server nyata ===');

    const barisContoh = [
      { namaTPK: 'Siti Aminah', peranTPK: 'PK', namaDesa: 'Sukamaju', namaKecamatan: 'Cibinong',
        nik: '3201234500001', namaLengkap: 'Sari Dewi', jenisSasaran: 'Ibu Hamil',
        tanggalKunjungan: '2024-03-15', pendampinganKe: '1', usia: '27', bbSekarang: '62,55', tfu: '24', hpht: '2023-10-01' },
      { namaTPK: 'Siti Aminah', peranTPK: 'PK', namaDesa: 'Sukamaju', namaKecamatan: 'Cibinong',
        nik: '3201234500002', namaLengkap: 'Budi Santoso', jenisSasaran: 'Catin',
        tanggalKunjungan: '2024-03-16', pendampinganKe: '2', usia: '24', tanggalLahir: '2000-06-20' },
      { namaTPK: 'Siti Aminah', peranTPK: 'PK', namaDesa: 'Sukamaju', namaKecamatan: 'Cibinong',
        nik: '3201234500003', namaLengkap: 'Dewi Lestari', jenisSasaran: 'Baduta',
        tanggalKunjungan: '2024-03-17', pendampinganKe: '3', tanggalLahirBayi: '2022-01-15', umurBayi: '26' },
    ];

    const normalisasi = (v) => NORMALIZE_SASARAN[String(v).trim().toLowerCase()] || v;
    const hasil = require(path.join(__dirname, '..', 'lib', 'backfill.js')).rencanaBackfill({
      rows: barisContoh,
      fieldOrder: FIELD_ORDER,
      institutionKey: tanda,
      sectionMap,
      normalizeSasaran: normalisasi,
      normalizeNik: app.normalizeNik,
      dateOrder: DATE_ORDER,
    });
    eqIsh(hasil.ditolak.length, 0, 'tidak ada baris ditolak');
    eqIsh(hasil.records.length, 3, 'tiga record siap');

    const sql = cli.sqlUntuk(hasil.records);
    ok('SQL memuat tiga INSERT', (sql.match(/INSERT INTO records/g) || []).length === 3);

    let jmlEksekusi = 0;
    let galatSql = null;
    try {
      jmlEksekusi = await eksekusiSqlBackfill(sql);
    } catch (e) {
      galatSql = e;
    }
    ok('SQL backfill berhasil dieksekusi di server', !galatSql, galatSql && galatSql.message);
    if (galatSql) throw galatSql;
    eqIsh(jmlEksekusi, 3, 'jumlah statement yang dijalankan');

    const idBackfill = new Set(hasil.records.map((r) => r.record_id));
    // Hanya tiga record backfill: baris F1.9 memakai institusi yang sama dan
    // harus ikut terhitung kalau filternya cuma institution_id.
    const hitung = async () => {
      const r = await utama.query('SELECT record_id FROM records WHERE institution_id = $1', [tanda]);
      return r.rows.filter((x) => idBackfill.has(x.record_id)).length;
    };
    eqIsh(await hitung(), 3, 'tiga baris masuk setelah eksekusi pertama');

    await eksekusiSqlBackfill(sql);
    eqIsh(await hitung(), 3, 'eksekusi ulang tidak menggandakan (ON CONFLICT DO NOTHING)');

    // Hash setiap baris yang masuk harus cocok dihitung ulang dari payload_json.
    const semua = await utama.query(
      'SELECT record_id, record_hash, payload_json FROM records WHERE institution_id = $1 ORDER BY record_id',
      [tanda]
    );
    const barisBackfill = semua.rows.filter((x) => idBackfill.has(x.record_id));
    eqIsh(barisBackfill.length, 3, 'semua baris terbaca untuk verifikasi hash');

    const byId = new Map(hasil.records.map((r) => [r.record_id, r]));
    let hashCocok = true;
    let contohSalah = null;
    for (const r of barisBackfill) {
      const asli = byId.get(r.record_id);
      const tersimpan = typeof r.payload_json === 'string' ? JSON.parse(r.payload_json) : r.payload_json;
      const ulang = c.recordHash(tersimpan);
      const cocok = asli && ulang === r.record_hash && r.record_hash === asli.record_hash;
      if (!cocok) { hashCocok = false; contohSalah = r.record_id; }
    }
    ok('hash backfill cocok dihitung ulang dari database untuk semua baris', hashCocok, contohSalah);
  } finally {
    // Pembersihan mutlak: hapus baris records uji dulu, baru agency (FK
    // institution_id -> agencies.institution_key). Dihapus lewat koneksi utama
    // (BYPASSRLS); records juga mengikuti pola test-db-live.
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
  console.error('\nUji live F1.8/F1.9 gagal dijalankan: ' + e.message);
  try { require('../lib/db.js').matikan().catch(() => {}); } catch (e2) {}
  process.exit(1);
});