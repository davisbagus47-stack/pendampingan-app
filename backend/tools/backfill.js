'use strict';

/**
 * Backfill dari sheet TPK legacy ke tabel `records` (F1.8).
 *
 * ============================ REKONSTRUKSI ============================
 * Berkas ini DITULIS ULANG pada 2026-10-05. Salinan sebelumnya tertimpa
 * tidak sengaja dengan isi `lib/backfill.js` ketika berkas cadangan dikirim
 * ke lokasi yang salah saat memulihkan diri dari debug. Berkas itu tidak
 * pernah terlacak git, jadi tidak ada pemulihan yang mungkin dilakukan.
 *
 * Yang hilang hanya pembungkus command-line ini. `lib/backfill.js` -- tempat
 * seluruh logika transform, penolakan, dan identitas record berada -- tidak
 * tersentuh dan tetap utuh, begitu juga `tools/test-backfill.js`.
 *
 * Kontrak berkas ini dipulihkan dari `tools/test-backfill.js`, yang menguji
 * CLI ini sebagai proses anak. Jadi perilakunya terverifikasi oleh uji, bukan
 * hanya berdasarkanWayback ingatan. Tapi ini tetap REKONSTRUKSI: baris demi
 * baris tidak sama dengan aslinya. Untuk lampiran skripsi itu harus disebut,
 * bukan disamarkan.
 * =====================================================================
 */

const fs = require('fs');
const path = require('path');

const app = require(path.join(__dirname, '..', 'index.js'));
const { deriveSections } = require(path.join(__dirname, '..', 'lib', 'sections.js'));
const { columnName } = require(path.join(__dirname, '..', 'lib', 'field-types.js'));
const { rencanaBackfill, NUMERIC_FIELDS, DATE_FIELDS } =
  require(path.join(__dirname, '..', 'lib', 'backfill.js'));

const { FIELD_ORDER, HEADERS, LABELS, NORMALIZE_SASARAN, normalizeNik, headerToIndex, pickField } = app;

/**
 * Locale bawaan untuk proyek ini.
 *
 * `parseArgs` sengaja TIDAK memakai nilai ini sebagai bawaan: parser murni
 * harus melaporkan apa yang diminta pemanggil saja, tanpa opinion sendiri.
 * Provenance keputusan ini milik `main()`, di tempat keputusan proyek berada.
 *
 * Nilai ini sudah dikonfirmasi pemilik proyek: sheet TPK menulis tanggal
 * `hari/bulan/tahun`, jadi `03/04/2024` dibaca 3 April 2024. Setiap tebakan
 * yang terjadi tetap dilaporkan, jadi locale yang keliru masih bisa ditemukan
 * setelah run selesai.
 */
const DATE_ORDER_DEFAULT = 'ddmmyyyy';

const BANTUAN = [
  'Backfill TPK legacy -> tabel records.',
  '',
  'Pemakaian:',
  '  node tools/backfill.js --institution KODE --input BERKAS [pilihan]',
  '',
  'Pilihan:',
  '  --institution KODE  WAJIB. institution_key instansi pemilik sheet: huruf',
  '                     kecil, angka, dan tanda hubung saja. Harus cocok dengan',
  '                     agencies.institution_key di server, jadi jangan menebak.',
  '  --input BERKAS     WAJIB. JSON berupa array of objects, atau',
  '                     { "headers": [...], "rows": [[...]] }.',
  '  --out FILE         Tulis SQL ke FILE. Tanpa ini hanya laporan.',
  '  --dry-run          Tidak menulis berkas apa pun. Keluar dengan galat bila',
  '                     ada baris yang ditolak.',
  '  --skip-balita      Izinkan baris taksonomi di luar ADR-5 dilewati.',
  '  --date-order FORMAT Dulu hari \'ddmmyyyy\' (bawaan proyek ini) atau bulan',
  '                     dulu \'mmddyyyy\', untuk tanggal bergaris miring yang',
  '                     ambigu seperti 03/04/2024. Yang ditebak tetap dilaporkan.',
  '  --sample N         Tulis N baris contoh ke stdout lalu berhenti.',
  '',
  'Tanpa --dry-run maupun --out, skrip hanya mencetak laporan.',
  '',
  'Tidak ada --identity-row, dan itu disengaja: tanggal_kunjungan bertipe',
  'NOT NULL, jadi setiap record yang bisa masuk database pasti punya tanggal',
  'kunjungan. Kolom identitas sudah terisi tanpa perlu ersatz.',
].join('\n');

// ---------------------------------------------------------------------------
// Argumen
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const o = {
    institution: null, input: null, out: null, dateOrder: null,
    dryRun: false, skipBalita: false, sample: null, help: false,
  };

  const butuh = (a, i) => {
    const v = argv[i + 1];
    if (v === undefined || String(v).startsWith('--')) {
      throw new Error(a + ' butuh nilai');
    }
    return v;
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--institution') { o.institution = butuh(a, i); i++; }
    else if (a === '--input') { o.input = butuh(a, i); i++; }
    else if (a === '--out') { o.out = butuh(a, i); i++; }
    else if (a === '--date-order') { o.dateOrder = butuh(a, i); i++; }
    else if (a === '--sample') { o.sample = butuh(a, i); i++; }
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--skip-balita') o.skipBalita = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else throw new Error('argumen tak dikenal: ' + a);
  }

  if (o.dateOrder && o.dateOrder !== 'ddmmyyyy' && o.dateOrder !== 'mmddyyyy') {
    throw new Error('--date-order hanya boleh ddmmyyyy atau mmddyyyy');
  }
  return o;
}

// ---------------------------------------------------------------------------
// Pembacaan input
// ---------------------------------------------------------------------------

function bacaInput(file) {
  const mentah = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const data = JSON.parse(mentah);

  if (Array.isArray(data)) {
    return { headers: null, rows: data };
  }
  if (data && Array.isArray(data.rows)) {
    return { headers: data.headers || HEADERS, rows: data.rows };
  }
  throw new Error(
    'Format input tidak dikenali. Expected array of objects, atau ' +
    '{ "headers": [...], "rows": [[...]] }'
  );
}

/**
 * Baris array -> objek field, lewat LABEL header.
 *
 * `headerToIndex` diisi dengan label sheet ("NIK"), bukan nama field ("nik"),
 * dan `pickField` mencari `LABELS[field]` di dalamnya. Karena itu pemetaan
 * dilakukan lewat `pickField`, bukan indeks tetap: sheet yang kolomnya tidak
 * lengkap akan menggeser semua nilai kalau indeks tetap dipakai, dan
 * pergeseran itu tidak kelihatan di sheet.
 *
 * Field yang tidak punya kolom diberi string kosong, bukan dibiarkan
 * `undefined`, dan namanya dikembalikan di `hilang` supaya DeficiencyVisible --
 * nilai kosong yang tidak dilaporkan indistinguishable dari nilai kosong yang
 * memang ada di sheet.
 */
function barisKeObjek(headers, rows) {
  const colIndex = headerToIndex(headers);
  const objek = [];
  const hilang = [];

  for (const r of rows || []) {
    const o = {};
    for (const f of FIELD_ORDER) {
      const v = pickField(r, colIndex, f);
      if (v === undefined) {
        o[f] = '';
        if (hilang.indexOf(f) === -1) hilang.push(f);
      } else {
        o[f] = v;
      }
    }
    objek.push(o);
  }
  return { objek, hilang };
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

function sqlQuote(v) {
  if (v === null || v === undefined) return 'NULL';
  return "'" + String(v).replace(/'/g, "''") + "'";
}

/**
 * Nilai satu kolom proyeksi untuk statement INSERT.
 *
 * Kolom bertipe khusus (DATE, NUMERIC) menulis hasil `parse`, atau NULL kalau
 * gagal. Nilai mentah dari sheet TIDAK boleh ditulis ke sana: PostgreSQL
 * menolak `'31 Feb 2024'` dengan "invalid input syntax for type date", padahal
 * kebijakan di `sql/001_schema.sql` menetapkan NULL untuk nilai yang tidak
 * terbaca -- dan pesan PostgreSQL itu tidak menyebut baris mana yang salah.
 * Kolom TEXT ditulis apa adanya dari payload, karena tidak ada yang perlu di-parse.
 */
function nilaiKolom(f, record) {
  const proy = record.proyeksi || {};
  const payload = record.payload_json || {};
  if (NUMERIC_FIELDS.has(f)) {
    const v = proy[f];
    return v === null || v === undefined ? 'NULL' : String(v);
  }
  if (DATE_FIELDS.has(f)) {
    const v = proy[f];
    return v === null || v === undefined ? 'NULL' : sqlQuote(v);
  }
  const t = payload[f];
  return sqlQuote(t === undefined || t === null ? '' : t);
}

function sqlUntuk(records) {
  const daftar = records || [];
  if (daftar.length === 0) return '';

  const metadata = ['record_id', 'version', 'status', 'schema_version',
    'institution_id', 'record_hash', 'payload_json', 'sections'];
  const kolomSql = metadata.concat(FIELD_ORDER.map(columnName)).join(', ');

  const stmt = daftar.map((r) => {
    const nilai = [
      sqlQuote(r.record_id),
      sqlQuote(r.version),
      sqlQuote(r.status),
      sqlQuote(r.schema_version),
      sqlQuote(r.institution_id),
      sqlQuote(r.record_hash),
      sqlQuote(JSON.stringify(r.payload_json)) + '::jsonb',
      'ARRAY[' + (r.sections || []).map(sqlQuote).join(', ') + ']::text[]',
    ].concat(FIELD_ORDER.map((f) => nilaiKolom(f, r)));

    return 'INSERT INTO records (' + kolomSql + ')\n  VALUES (' + nilai.join(', ') +
      ')\nON CONFLICT (record_id, version) DO NOTHING;';
  });

  return [
    '-- Hasil tools/backfill.js. Jangan diedit tangan.',
    '-- Idempoten: menjalankan ulang berkas ini tidak menggandakan data, karena',
    '-- record_id berasal dari isi record (uuid v5), bukan dari urutan baris.',
    '',
    'BEGIN;',
    '',
    stmt.join('\n\n'),
    '',
    'COMMIT;',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Laporan
// ---------------------------------------------------------------------------

function cetakLaporan(hasil, opsi, jumlahBaris) {
  const { records, ditolak, duplikat, peringatan, tanggalRusak, diasumsikan: tanggalAsumsi, diubah } = hasil;

  console.log('baris dibaca : ' + jumlahBaris);
  console.log('record siap  : ' + records.length);
  console.log('ditolak      : ' + ditolak.length);
  console.log('duplikat     : ' + duplikat.length);

  if (records.length > 0) {
    const perJenis = {};
    for (const r of records) {
      const k = r.payload_json.jenisSasaran;
      perJenis[k] = (perJenis[k] || 0) + 1;
    }
    console.log('\ntaksonomi yang lolos:');
    for (const k of Object.keys(perJenis).sort()) {
      console.log('  ' + k.padEnd(12) + perJenis[k]);
    }
  }

  // Nilai yang bentuknya berubah antara sheet dan kolom bertipe. Dicetak penuh
  // dan bukan hanya jumlahnya, karena ini daftar tempat isi database akan
  // berbeda dari isi sheet -- dan yang perlu memeriksa laporan ini adalah
  // orang, bukan skrip.
  if (diubah && diubah.length > 0) {
    console.log('\nnilai yang bentuknya diubah saat disimpan (' + diubah.length + '):');
    console.log('  kolom database akan berbeda dari teks di sheet:');
    for (const u of diubah.slice(0, 12)) {
      console.log('    baris ' + u.baris + '  ' + u.field + ': "' + u.asal + '" -> "' + u.jadi + '"');
    }
    if (diubah.length > 12) console.log('    ... ' + (diubah.length - 12) + ' lagi');
    console.log('  payload_json tetap menyimpan teks asli apa adanya.');
  }

  // Tanggal ambigu yang diterjemahkan oleh locale bawaan proyek. Dilaporkan
  // karena ini asumsi manusia, bukan pembacaan yang pasti: kalau locale-nya
  // keliru, tidak ada tempat lain yang mengatakannya.
  if (tanggalAsumsi && tanggalAsumsi.length > 0) {
    console.log('\ntanggal ambigu yang ditebak (' + tanggalAsumsi.length +
      '): asumsi "' + opsi.dateOrder + '" dipakai');
    for (const t of tanggalAsumsi.slice(0, 8)) {
      console.log('    baris ' + t.baris + '  ' + t.field + '="' + t.nilai + '"  -> ' + t.dipakai);
    }
    if (tanggalAsumsi.length > 8) {
      console.log('    ... ' + (tanggalAsumsi.length - 8) + ' lagi');
    }
    console.log('  Ini memakai asumsi, bukan pembacaan yang pasti. Kalau satu saja');
    console.log('  terasa salah, jalankan ulang dengan --date-order mmddyyyy.');
  }

  if (tanggalRusak && tanggalRusak.length > 0) {
    const ambigu = tanggalRusak.filter((t) => t.masalah === 'ambigu');
    const rusak = tanggalRusak.filter((t) => t.masalah !== 'ambigu');
    if (ambigu.length > 0) {
      console.log('\ntanggal ambigu (' + ambigu.length + '): urutan hari/bulan tidak bisa dipastikan');
      for (const t of ambigu.slice(0, 8)) {
        console.log('    baris ' + t.baris + '  ' + t.field + '="' + t.nilai + '"  -> ' +
          t.ddmmyyyy + ' atau ' + t.mmddyyyy);
      }
      console.log('  Isi kolomnya NULL. Perbaiki dengan --date-order bila sheet memang');
      console.log('  memakai satu urutan itu, atau perbaiki di sheet bila tidak.');
    }
    if (rusak.length > 0) {
      console.log('\ntanggal tidak terbaca (' + rusak.length + '): kolomnya jadi NULL');
      for (const t of rusak.slice(0, 8)) {
        console.log('    baris ' + t.baris + '  ' + t.field + '="' + t.nilai + '"');
      }
      console.log('  Teks aslinya tetap ada di payload_json. Nilai ini perlu dilihat manusia.');
    }
  }

  if (ditolak.length > 0) {
    console.log('\nDITOLAK:');
    const perKategori = {};
    for (const d of ditolak) perKategori[d.kategori] = (perKategori[d.kategori] || 0) + 1;
    for (const k of Object.keys(perKategori).sort()) {
      console.log('  ' + k + ' ' + perKategori[k]);
    }
    console.log('\n  contoh baris yang ditolak:');
    for (const d of ditolak.slice(0, 10)) {
      console.log('    baris ' + d.baris + '  nik=' + (d.nik || '-') + '  ' + d.alasan);
    }
    if (ditolak.length > 10) console.log('    ... ' + (ditolak.length - 10) + ' lagi');
  }

  if (duplikat.length > 0) {
    console.log('\nduplikat di dalam berkas (' + duplikat.length + '):');
    for (const d of duplikat.slice(0, 8)) {
      console.log('    baris ' + d.baris + '  kunci=' + (d.kunci || '-'));
    }
  }

  if (peringatan && peringatan.length > 0) {
    console.log('\nperingatan:');
    for (const p of peringatan) console.log('  ~ ' + p);
  }
}

// ---------------------------------------------------------------------------
// Contoh baris untuk --sample
// ---------------------------------------------------------------------------

function contohBaris(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      namaTPK: 'Siti Aminah', peranTPK: 'PK', namaDesa: 'Sukamaju',
      namaKecamatan: 'Cibinong', nik: '320123456789' + i,
      namaLengkap: 'Sari Dewi', jenisSasaran: 'Ibu Hamil',
      tanggalKunjungan: '2024-03-15', pendampinganKe: String(i + 1),
      usia: '27', bbSekarang: '62,55', tfu: '24', hpht: '2023-10-01',
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(argv) {
  let opsi;
  try {
    opsi = parseArgs(argv);
  } catch (e) {
    console.error('GALAT: ' + e.message);
    console.error('Lihat bantuan: node tools/backfill.js --help');
    return 2;
  }

  if (opsi.help) {
    console.log(BANTUAN);
    return 0;
  }

  const kurang = [];
  if (!opsi.institution) kurang.push('--institution');
  if (!opsi.input && !opsi.sample) kurang.push('--input');
  if (kurang.length > 0) {
    console.error('GALAT: ' + kurang.join(' dan ') + ' wajib diberikan.');
    console.error('Lihat bantuan: node tools/backfill.js --help');
    return 2;
  }

  // Locale proyek diterapkan di sini, bukan di `parseArgs`.
  if (!opsi.dateOrder) opsi.dateOrder = DATE_ORDER_DEFAULT;

  const { map: sectionMap } = deriveSections();

  let jumlahBaris = 0;
  let hasil;

  try {
    if (opsi.sample) {
      // jalur uji: payload contoh untuk menguji transform tanpa data nyata.
      hasil = rencanaBackfill({
        rows: contohBaris(Number(opsi.sample) || 3),
        fieldOrder: FIELD_ORDER,
        institutionKey: opsi.institution,
        sectionMap,
        normalizeSasaran: (v) => NORMALIZE_SASARAN[String(v).trim().toLowerCase()] || v,
        normalizeNik,
        dateOrder: opsi.dateOrder,
      });
      jumlahBaris = hasil.records.length + hasil.ditolak.length;
    } else {
      const { headers, rows } = bacaInput(opsi.input);
      let objek = rows;
      if (headers) {
        const konversi = barisKeObjek(headers, rows);
        objek = konversi.objek;
        if (konversi.hilang.length) {
          console.error('PERINGATAN: ' + konversi.hilang.length +
            ' field tidak ada di header sheet, nilainya akan kosong: ' +
            konversi.hilang.slice(0, 8).join(', ') +
            (konversi.hilang.length > 8 ? ', ...' : ''));
        }
      }
      jumlahBaris = objek.length;
      hasil = rencanaBackfill({
        rows: objek,
        fieldOrder: FIELD_ORDER,
        institutionKey: opsi.institution,
        sectionMap,
        normalizeSasaran: (v) => NORMALIZE_SASARAN[String(v).trim().toLowerCase()] || v,
        normalizeNik,
        dateOrder: opsi.dateOrder,
      });
    }
  } catch (e) {
    // Galat input harus keluar sebagai pesan satu baris, bukan stack trace.
    // Pengguna tidak bisa memperbaiki berkas yang rusak dari nomor baris kode.
    console.error('GALAT: ' + e.message);
    if (e.code === 'ENOENT') {
      console.error('Berkas tidak ditemukan: ' + opsi.input);
    } else if (e instanceof SyntaxError) {
      console.error('Berkas bukan JSON yang valid: ' + opsi.input);
    }
    return 2;
  }

  cetakLaporan(hasil, opsi, jumlahBaris);

  // Taksonomi punya aturan sendiri: tidak boleh dilewati tanpa opt-in.
  const taksonomiDitolak = hasil.ditolak.filter((d) => d.kategori === 'taksonomi');
  if (taksonomiDitolak.length > 0 && !opsi.skipBalita) {
    console.error('\nGAGAL: baris taksonomi ditolak dan --skip-balita tidak diberikan.');
    return 1;
  }

  // Opt-in hanya berlaku untuk taksonomi. Penolakan lain tetap menggagalkan,
  // atau opt-innya jadi terlalu luas dan ikut menutupi NIK kosong.
  const ditolakLain = opsi.skipBalita
    ? hasil.ditolak.filter((d) => d.kategori !== 'taksonomi')
    : hasil.ditolak;

  if (opsi.sample) {
    console.log(JSON.stringify(hasil.records[0], null, 2));
    return hasil.records.length > 0 ? 0 : 1;
  }

  if (opsi.out) {
    fs.writeFileSync(opsi.out, sqlUntuk(hasil.records), 'utf8');
    console.log('\nSQL ditulis: ' + opsi.out + '  (' + hasil.records.length + ' record)');
    if (hasil.ditolak.length > 0) {
      console.error('PERINGATAN: ' + hasil.ditolak.length +
        ' baris ditolak dan TIDAK ikut ditulis ke SQL.');
    }
    return 0;
  }

  if (ditolakLain.length > 0) {
    console.error('\nGAGAL: dry-run dengan ' + ditolakLain.length +
      ' baris ditolak. Perbaiki sumbernya atau beri opt-in yang sesuai.');
    return 1;
  }

  console.log('\ndry-run bersih. Tidak ada berkas ditulis.');
  return 0;
}

module.exports = {
  BANTUAN,
  parseArgs,
  bacaInput,
  barisKeObjek,
  sqlQuote,
  sqlUntuk,
};

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}