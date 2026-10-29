'use strict';

/**
 * Uji murni `lib/records-write.js` (F3.2).
 *
 * Yang diuji di sini adalah keputusan yang tidak bisa dibuktikan RLS: bentuk
 * permintaan create-vs-koreksi, validasi kolom wajib, penyusunan payload dan
 * `record_hash`, serta perakitan kolom/nilai INSERT. Pembuktian terhadap
 * PostgreSQL (policy `records_agency_insert`, versioning nyata) ada di
 * `tools/test-records-write-live.js`; keduanya dipisah supaya suite ini tetap
 * hijau tanpa `DATABASE_URL`.
 *
 * Invarian terpenting diuji di sini: record yang ditulis jalur produksi punya
 * `record_hash`, `payload_json`, dan `sections` yang SAMA PERSIS dengan yang
 * akan dihasilkan `rencanaBackfill` untuk isi yang sama. Kalau menyimpang,
 * record yang dikirim form tidak akan cocok dengan record hasil backfill, dan
 * perbedaannya tidak terlihat tanpa membandingkan hash secara manual.
 */

const path = require('path');
const w = require(path.join(__dirname, '..', 'lib', 'records-write.js'));
const bf = require(path.join(__dirname, '..', 'lib', 'backfill.js'));
const c = require(path.join(__dirname, '..', 'lib', 'canonical.js'));
const { deriveSections } = require(path.join(__dirname, '..', 'lib', 'sections.js'));
const app = require(path.join(__dirname, '..', 'index.js'));

const { FIELD_ORDER, NORMALIZE_SASARAN, normalizeNik } = app;
const { map: sectionMap } = deriveSections();

let passed = 0;
let failed = 0;

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

function kode(fn) {
  try { fn(); return null; } catch (e) { return e.code || e.name || null; }
}

function bodyValid(extra) {
  return Object.assign({
    namaTPK: 'Siti Aminah',
    peranTPK: 'PK',
    namaDesa: 'Sukamaju',
    namaKecamatan: 'Cibinong',
    nik: '3201234567890001',
    namaLengkap: 'Sari Dewi',
    jenisSasaran: 'ibu hamil',
    tanggalKunjungan: '2024-03-15',
    pendampinganKe: '1',
    usia: '27',
    bbSekarang: '62,5',
    tfu: '24',
    tanggalLahir: '1996-01-02',
  }, extra || {});
}

function main() {
  console.log('=== 1. parseKontrol: create vs koreksi ===');

  const buat = w.parseKontrol(bodyValid());
  eq('tanpa record_id/version -> create', buat.mode, 'create');
  eq('create: recordId null (dibuat server)', buat.recordId, null);
  eq('create: supersededVersion null', buat.supersededVersion, null);

  const koreksi = w.parseKontrol(bodyValid({ record_id: '11111111-2222-3333-4444-555555555555', version: 3 }));
  eq('record_id + version -> correct', koreksi.mode, 'correct');
  eq('correct: recordId dibaca', koreksi.recordId, '11111111-2222-3333-4444-555555555555');
  eq('correct: supersededVersion dibaca', koreksi.supersededVersion, 3);

  console.log('\n=== 2. parseKontrol: bentuk buruk DITOLAK, bukan diabaikan ===');

  eq('hanya record_id ditolak (bukan create diam-diam)',
    kode(() => { const r = w.parseKontrol(bodyValid({ record_id: '11111111-2222-3333-4444-555555555555' })); if (r.error) throw r.error; }),
    'INVALID_PARAM');
  eq('hanya version ditolak',
    kode(() => { const r = w.parseKontrol(bodyValid({ version: 2 })); if (r.error) throw r.error; }),
    'INVALID_PARAM');
  eq('record_id bukan UUID ditolak',
    kode(() => { const r = w.parseKontrol(bodyValid({ record_id: 'bukan-uuid', version: 1 })); if (r.error) throw r.error; }),
    'INVALID_PARAM');
  eq('version 0 ditolak',
    kode(() => { const r = w.parseKontrol(bodyValid({ record_id: '11111111-2222-3333-4444-555555555555', version: 0 })); if (r.error) throw r.error; }),
    'INVALID_PARAM');
  eq('version pecahan ditolak',
    kode(() => { const r = w.parseKontrol(bodyValid({ record_id: '11111111-2222-3333-4444-555555555555', version: 1.5 })); if (r.error) throw r.error; }),
    'INVALID_PARAM');

  console.log('\n=== 3. validasi: kolom wajib dan NIK ===');

  const kurangs = w.validasi({}, normalizeNik);
  const bidangKurang = kurangs.errors.map((e) => e.field).sort();
  eq('enam kolom wajib dilaporkan',
    bidangKurang,
    ['namaDesa', 'namaLengkap', 'namaTPK', 'nik', 'peranTPK', 'tanggalKunjungan'].sort());

  eq('NIK bukan 16 digit dilaporkan',
    w.validasi(bodyValid({ nik: '123' }), normalizeNik).errors,
    [{ field: 'nik', code: 'NIK_INVALID' }]);
  eq('NIK 16 digit lolos', w.validasi(bodyValid(), normalizeNik).errors, []);

  console.log('\n=== 4. bangunRecord: normalisasi dan hash ===');

  const rec = w.bangunRecord({
    body: bodyValid({ foo: 'diabaikan' }),
    fieldOrder: FIELD_ORDER,
    institutionId: 'bidang-kb-cibinong',
    sectionMap,
    normalizeSasaran: (v) => NORMALIZE_SASARAN[String(v).trim().toLowerCase()] || v,
    normalizeNik,
    recordId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    version: 1,
    supersedesId: null,
  });

  eq('jenisSasaran dinormalisasi ke taksonomi', rec.payload_json.jenisSasaran, 'Ibu Hamil');
  eq('NIK dinormalisasi', rec.payload_json.nik, '3201234567890001');
  eq('field asing tidak ikut payload', rec.payload_json.foo, undefined);
  eq('institution_id diisi dari pemanggil', rec.institution_id, 'bidang-kb-cibinong');
  eq('status active', rec.status, 'active');
  eq('version dari parameter', rec.version, 1);
  eq('supersedes_id null untuk create', rec.supersedes_id, null);
  eq('record_hash = canonical.recordHash(payload)', rec.record_hash, c.recordHash(rec.payload_json));
  ok('sections berisi minimal A', Array.isArray(rec.sections) && rec.sections.length > 0, JSON.stringify(rec.sections));
  ok('payload_json memuat seluruh FIELD_ORDER',
    FIELD_ORDER.every((f) => Object.prototype.hasOwnProperty.call(rec.payload_json, f)));

  console.log('\n=== 5. Invarian: hash sama dengan rencanaBackfill ===');

  const hasilBf = bf.rencanaBackfill({
    rows: [bodyValid()],
    fieldOrder: FIELD_ORDER,
    institutionKey: 'bidang-kb-cibinong',
    sectionMap,
    normalizeSasaran: (v) => NORMALIZE_SASARAN[String(v).trim().toLowerCase()] || v,
    normalizeNik,
    dateOrder: 'ddmmyyyy',
  });
  eq('backfill menerima baris', hasilBf.records.length, 1);
  const recBf = hasilBf.records[0];
  eq('record_hash jalur tulis == backfill', rec.record_hash, recBf.record_hash);
  eq('payload_json jalur tulis == backfill', rec.payload_json, recBf.payload_json);
  eq('sections jalur tulis == backfill', rec.sections, recBf.sections);

  console.log('\n=== 6. kolomDanNilai: bentuk INSERT ===');

  const { columns, values } = w.kolomDanNilai(rec, FIELD_ORDER, 'agency:7');
  eq('jumlah kolom = metadata + FIELD_ORDER', columns.length, w.KOLOM_METADATA.length + FIELD_ORDER.length);
  eq('jumlah nilai cocok kolom', values.length, columns.length);
  eq('kolom metadata urut', columns.slice(0, w.KOLOM_METADATA.length), w.KOLOM_METADATA.slice());
  eq('created_by diteruskan', values[w.KOLOM_METADATA.indexOf('created_by')], 'agency:7');
  eq('identitas writer kosong untuk jalur agency', values[w.KOLOM_METADATA.indexOf('writer_nik')], null);
  const withWriter = w.kolomDanNilai(rec, FIELD_ORDER, 'form-publik', {
    nik: '3201234567890001',
    name: 'Siti Aminah',
    walletAddress: '0x1111111111111111111111111111111111111111',
  });
  eq('NIK writer disimpan', withWriter.values[w.KOLOM_METADATA.indexOf('writer_nik')], '3201234567890001');
  eq('nama writer disimpan', withWriter.values[w.KOLOM_METADATA.indexOf('writer_name')], 'Siti Aminah');
  eq('wallet writer disimpan', withWriter.values[w.KOLOM_METADATA.indexOf('writer_wallet_address')], '0x1111111111111111111111111111111111111111');
  ok('payload_json dikirim sebagai teks JSON',
    typeof values[w.KOLOM_METADATA.indexOf('payload_json')] === 'string');
  eq('sections dikirim sebagai array', Array.isArray(values[w.KOLOM_METADATA.indexOf('sections')]), true);

  const nilaiUntuk = (field) => values[columns.indexOf(require(path.join(__dirname, '..', 'lib', 'field-types.js')).columnName(field))];
  eq('kolom numeric di-parse jadi angka', nilaiUntuk('bbSekarang'), 62.5);
  eq('kolom tanggal jadi ISO', nilaiUntuk('tanggalKunjungan'), '2024-03-15');
  eq('kolom teks apa adanya', nilaiUntuk('namaDesa'), 'Sukamaju');

  console.log('\n=== 7. barisOutbox (F3.3, FR-3.6) ===');

  const outboxCreate = w.barisOutbox(rec, 'bidang-kb-cibinong');
  eq('record_id diteruskan', outboxCreate.record_id, rec.record_id);
  eq('version diteruskan', outboxCreate.version, 1);
  eq('supersedes_id null untuk create', outboxCreate.supersedes_id, null);
  eq('commitment outbox = commitment pembaca (canonical.commitment)',
    outboxCreate.commitment, c.commitment(rec.record_hash, 'bidang-kb-cibinong'));

  // Pemanggil route menghitung commitment SEKALI dan memakainya untuk outbox
  // DAN response, jadi keduanya harus selalu identik untuk record yang sama.
  const recKoreksi = w.bangunRecord({
    body: bodyValid({ bb: '70,0' }),
    fieldOrder: FIELD_ORDER,
    institutionId: 'bidang-kb-cibinong',
    sectionMap,
    normalizeSasaran: (v) => NORMALIZE_SASARAN[String(v).trim().toLowerCase()] || v,
    normalizeNik,
    recordId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    version: 3,
    supersedesId: 42,
  });
  const outboxKoreksi = w.barisOutbox(recKoreksi, 'bidang-kb-cibinong');
  eq('supersedes_id BIGINT dijadikan TEXT', outboxKoreksi.supersedes_id, '42');
  eq('commitment koreksi terhitung dari hash baru',
    outboxKoreksi.commitment, c.commitment(recKoreksi.record_hash, 'bidang-kb-cibinong'));
  ok('baris outbox berisi hanya 4 kolom DDL (record_id, version, supersedes_id, commitment)',
    JSON.stringify(Object.keys(outboxCreate).sort()),
    JSON.stringify(['commitment', 'record_id', 'supersedes_id', 'version'].sort()));

  console.log('\n' + (failed === 0 ? 'SEMUA ' + passed + ' UJI LOLOS' : passed + ' lulus, ' + failed + ' GAGAL'));
  process.exit(failed === 0 ? 0 : 1);
}

main();
