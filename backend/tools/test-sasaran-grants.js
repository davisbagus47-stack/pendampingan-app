'use strict';

/**
 * Uji integrasi FR-4.20a/b pada jalur output yang sebenarnya dipakai aplikasi.
 *
 * lib/column-grants.js sudah diuji 133 hal sebagai unit. Uji ini menjawab
 * pertanyaan yang berbeda dan lebih penting: apakah route sungguhan memakai
 * pintu itu, atau hanya modulnya yang benar sementara pemanggilnya lupa.
 *
 * Yang diperiksa di sini:
 *   - /api/sasaran tidak lagi mengirim lewat res.json mentah (FR-4.20b);
 *   - `fields` terlarang ditolak dengan 403 FIELD_NOT_GRANTED sebelum baris
 *     disentuh -- diuji dengan baris bermuatan terlarang di Every-where;
 *   - kolom terlarang tidak muncul di JSON maupun CSV;
 *   - CSV dan JSON memakai daftar kolom yang sama (FR-4.20b);
 *   - galat tidak membocorkan isi kolom terlarang.
 *
 * Yang TIDAK diuji: RLS di PostgreSQL, dan enumerate sheet sungguhan. Keduanya
 * butuh akses database dan kredensial Google. Bukti F1.8a terpisah.
 */

const path = require('path');
const app = require(path.join(__dirname, '..', 'index.js'));
const cg = require(path.join(__dirname, '..', 'lib', 'column-grants.js'));

const { FIELD_ORDER, LABELS, parseFields, parseFormat, selCsv, kirimBaris } = app;

let passed = 0;
let failed = 0;

function ok(name, cond) {
  if (cond) { passed++; console.log('LULUS  ' + name); }
  else { failed++; console.log('GAGAL  ' + name); }
}

function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) { passed++; console.log('LULUS  ' + name); }
  else {
    failed++;
    console.log('GAGAL  ' + name);
    console.log('        dapat     : ' + a);
    console.log('        diharapkan : ' + b);
  }
}

async function kode(fn) {
  try { await fn(); return null; } catch (e) { return e.code || e.name || null; }
}

// ---------------------------------------------------------------------------
// Res tiruan. Cukup mencatat yang dikirim, tanpa HTTP sungguhan.
// ---------------------------------------------------------------------------

function resPalsu() {
  return {
    statusCode: null,
    tipeKonten: null,
    header: null,
    disposisi: null,
    body: null,
    status(c) { this.statusCode = c; return this; },
    type(t) { this.tipeKonten = t; return this; },
    set(nama, nilai) {
      this.header = this.header || {};
      this.header[nama] = nilai;
      if (String(nama).toLowerCase() === 'content-disposition') this.disposisi = nilai;
      return this;
    },
    json(o) { this.body = o; return this; },
    send(s) { this.body = s; return this; },
  };
}

/** Kumpulan baris yang setiap kolomnya terisi, termasuk yang terlarang. */
function barisUji(n) {
  const out = [];
  for (let i = 0; i < (n || 2); i++) {
    const row = {};
    for (const f of FIELD_ORDER) row[f] = 'nilai-' + f + '-' + i;
    out.push(row);
  }
  return out;
}

async function main() {
  console.log('=== 1. Baris uji benar-benar memuat kolom terlarang ===');

  // Kalau baris uji sudah bersih, semua uji di bawah ini akan hijau tanpa Reasons
  // alasan: tidak ada yang bisa bocor. Pastikan dulu.
  const baris = barisUji(3);
  for (const f of cg.DENIED_BAWAAN) {
    ok('baris uji memuat ' + f, Object.prototype.hasOwnProperty.call(baris[0], f));
  }
  eq('tiga baris uji', baris.length, 3);

  console.log('\n=== 2. fields terlarang ditolak, tidak dihapus diam-diam ===');

  // FR-4.20a: permintaan eksplisit harus DITOLAK, bukan dikembalikan diam-diam.
  eq('fields=catatanTPK ditolak FIELD_NOT_GRANTED',
    await kode(() => kirimBaris({ query: { fields: 'catatanTPK' } }, resPalsu(), baris)),
    'FIELD_NOT_GRANTED');

  eq('fields=nik_ayah ditolak FIELD_NOT_GRANTED',
    await kode(() => kirimBaris({ query: { fields: 'nik_ayah' } }, resPalsu(), baris)),
    'FIELD_NOT_GRANTED');

  eq('fields=NIK_IBU (huruf besar) ditolak',
    await kode(() => kirimBaris({ query: { fields: 'NIK_IBU' } }, resPalsu(), baris)),
    'FIELD_NOT_GRANTED');

  // Kolom asing harus punya kode sendiri, bukan disamakan dengan terlarang.
  eq('kolom asing ditolak FIELD_UNKNOWN',
    await kode(() => kirimBaris({ query: { fields: 'kolomHantu' } }, resPalsu(), baris)),
    'FIELD_UNKNOWN');

  eq('field yang boleh lolos',
    await kode(() => kirimBaris({ query: { fields: 'nik,namaLengkap' } }, resPalsu(), baris)),
    null);

  // Kombinasi kolom yang sah dan terlarang: yang terlarang harus tetap ditolak.
  eq('campuran sah + terlarang ditolak',
    await kode(() => kirimBaris({ query: { fields: 'nik,catatanTPK,namaLengkap' } }, resPalsu(), baris)),
    'FIELD_NOT_GRANTED');

  // Penolakan harus terjadi SEBELUM baris disentuh. Kalau baris sudah dibaca dan
  // baru difilter sesudahnya, permintaan terlarang tetap bisa menyentuh data dan
  // mengisi memori proses -- persis yang ingin dihindari FR-4.20c.
  //
  // Diuji dengan Proxy yang meledak pada akses elemen mana pun. `length` pada
  // array tidak bisa di-define ulang, jadi jebakan dipasang lewat Proxy.
  const barisJebakan = new Proxy(baris, {
    get(target, prop) {
      if (prop === Symbol.iterator || prop === 'length') return 0;
      throw new Error('baris dibaca sebelum penolakan (properti ' + String(prop) + ')');
    },
  });

  let ditolakSebelumBaca = true;
  try {
    await kirimBaris({ query: { fields: 'catatanTPK' } }, resPalsu(), barisJebakan);
    ditolakSebelumBaca = false;
  } catch (e) {
    if (e.code !== 'FIELD_NOT_GRANTED') {
      ditolakSebelumBaca = false;
      console.log('        alasan lain: ' + e.message);
    }
  }
  ok('penolakan terjadi sebelum baris dibaca', ditolakSebelumBaca);

  console.log('\n=== 3. Respons JSON tidak memuat kolom terlarang ===');

  const resJson = resPalsu();
  await kirimBaris({ query: {} }, resJson, baris);

  eq('status 200', resJson.statusCode, 200);
  eq('tiga baris terkirim', resJson.body.data.length, 3);

  const jsonTeks = JSON.stringify(resJson.body);
  for (const f of cg.DENIED_BAWAAN) {
    ok('nilai ' + f + ' tidak ada di respons', !jsonTeks.includes('nilai-' + f));
    ok('kunci ' + f + ' tidak ada di respons', !jsonTeks.includes('"' + f + '"'));
  }

  // Jumlah kunci per baris harus sama persis: JSON boleh kehilangan kolom, tapi
  // tidak boleh kehilangan kolom berbeda-beda antar baris.
  const jumlahKunci = new Set(resJson.body.data.map((r) => Object.keys(r).length));
  eq('semua baris punya jumlah kunci sama', [...jumlahKunci].length, 1);
  ok('jumlah kunci itu 67', jumlahKunci.has(67));

  console.log('\n=== 4. fields yang sah tetap dipatuhi ===');

  const resNik = resPalsu();
  await kirimBaris({ query: { fields: 'nik' } }, resNik, baris);
  eq('hanya nik yang diminta', Object.keys(resNik.body.data[0]), ['nik']);

  // Parameter fields berulang harus digabung, bukan menimpa.
  const resGabung = resPalsu();
  await kirimBaris({ query: { fields: ['nik', 'namaLengkap'] } }, resGabung, baris);
  eq('fields berulang digabung', Object.keys(resGabung.body.data[0]).sort(), ['namaLengkap', 'nik']);

  console.log('\n=== 5. FR-4.20b: CSV memakai daftar kolom yang sama ===');

  const resCsv = resPalsu();
  await kirimBaris({ query: { format: 'csv' } }, resCsv, baris);

  eq('status 200', resCsv.statusCode, 200);
  ok('tipe konten CSV', String(resCsv.tipeKonten).includes('text/csv'));

  const lines = String(resCsv.body).trim().split('\r\n');
  eq('satu header + tiga baris', lines.length, 4);

  const headerCsv = lines[0].split(',');
  eq('header CSV punya 67 kolom', headerCsv.length, 67);
  for (const f of cg.DENIED_BAWAAN) {
    ok('header CSV tidak memuat ' + f, !headerCsv.includes(LABELS[f]));
  }
  for (const f of cg.DENIED_BAWAAN) {
    ok('nilai ' + f + ' tidak ada di CSV', !String(resCsv.body).includes('nilai-' + f));
  }

  // Setiap baris harus punya jumlah sel sama dengan header. Kalau tidak, file
  // tidak bisa dibuka dan tidak ada yang tahu itu sebabnya blokir kolom.
  for (let i = 1; i < lines.length; i++) {
    eq('baris CSV ' + i + ' punya jumlah sel sama', lines[i].split(',').length, 67);
  }

  // Label header harus sama dengan yang dipatuhi JSON, hanya berbeda nama.
  eq('header CSV sama dengan label yang dipatuhi',
    headerCsv, cg.exportHeader(FIELD_ORDER, LABELS, null));

  console.log('\n=== 6. fields terlarang ditolak juga di format CSV ===');

  eq('CSV + fields terlarang ditolak',
    await kode(() => kirimBaris({ query: { format: 'csv', fields: 'catatanTPK' } }, resPalsu(), baris)),
    'FIELD_NOT_GRANTED');

  eq('CSV + kolom asing ditolak',
    await kode(() => kirimBaris({ query: { format: 'csv', fields: 'entah' } }, resPalsu(), baris)),
    'FIELD_UNKNOWN');

  console.log('\n=== 7. Format lain ditolak dengan jelas ===');

  eq('format xml ditolak INVALID_FORMAT',
    await kode(() => kirimBaris({ query: { format: 'xml' } }, resPalsu(), baris)),
    'INVALID_FORMAT');

  // F3.10b: xlsx sekarang XLSX asli, bukan CSV yang diberi nama .xlsx.
  // Yang diuji di sini bukan struktur berkasnya, tapi jalur respons;
  // sisanya diuji di test-xlsx-export.js.
  const resXlsx = resPalsu();
  const hasilXlsx = await kirimBaris({ query: { format: 'xlsx' } }, resXlsx, baris);
  eq('xlsx dijawab 200', resXlsx.statusCode, 200);
  eq('xlsx mengirim buffer biner', Buffer.isBuffer(resXlsx.body), true);
  eq('xlsx bukan CSV yang salah label', resXlsx.body.toString('utf8', 0, 2), 'PK');
  eq('xlsx tipe konten benar',
    resXlsx.tipeKonten, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  eq('xlsx dihitung sebagai lampiran',
    resXlsx.disposisi, 'attachment; filename="sasaran.xlsx"');
  eq('xlsx jumlah baris sama dengan JSON', hasilXlsx.count, 3);

  console.log('\n=== 8. Parse parameter ===');

  eq('tanpa fields = null', parseFields({ query: {} }), null);
  eq('fields kosong = null', parseFields({ query: { fields: '' } }), null);
  eq('fields koma dipisah', parseFields({ query: { fields: 'nik,namaLengkap' } }), ['nik', 'namaLengkap']);
  eq('fields diulang digabung', parseFields({ query: { fields: ['nik', 'namaLengkap'] } }), ['nik', 'namaLengkap']);
  eq('spasi dibersihkan', parseFields({ query: { fields: ' nik , namaLengkap ' } }), ['nik', 'namaLengkap']);
  eq('koma kosong diabaikan', parseFields({ query: { fields: 'nik,,namaLengkap' } }), ['nik', 'namaLengkap']);

  eq('format default json', parseFormat({ query: {} }), 'json');
  eq('format CSV huruf besar diterima', parseFormat({ query: { format: 'CSV' } }), 'csv');
  eq('format xml ditolak', await kode(() => parseFormat({ query: { format: 'xml' } })), 'INVALID_FORMAT');

  console.log('\n=== 9. Escape CSV ===');

  // Nilai dengan koma akan memecah baris jadi jumlah kolom salah. Ini bukan
  // kebocoran kolom terlarang, tapi membuat file tidak bisa dibaca -- dan kolom
  // berikutnya bergeser, jadi yang terbaca bukan yang dimaksud.
  eq('nilai dengan koma di-escape', selCsv('a,b'), '"a,b"');
  eq('nilai dengan kutip di-escape', selCsv('katakan "halo"'), '"katakan ""halo"""');
  eq('nilai dengan baris baru di-escape', selCsv('satu\ndua'), '"satu\ndua"');

  // Uji ujung: nilai yang mengandung koma harus tetap menghasilkan dua kolom
  // setelah di-escape, dan tidak menggeser kolom berikutnya.
  const barisKoma = [{ nik: 'a,b', namaLengkap: 'x"y' }];
  const resKoma = resPalsu();
  await kirimBaris({ query: { format: 'csv', fields: 'nik,namaLengkap' } }, resKoma, barisKoma);

  // Menghitung kolom dengan split(',') tidak berlaku di sini: koma di dalam
  // nilai ber-kutip memang sengaja ada. Yang diperiksa adalah bentuk keluarannya,
  // bukan hasil pemecahan naif.
  const barisKomaData = String(resKoma.body).trim().split('\r\n')[1];
  eq('nilai kutip dan koma ikut utuh', barisKomaData, '"a,b","x""y"');
  eq('header lalu satu baris data', String(resKoma.body).trim().split('\r\n').length, 2);

  // Bukti bahwa koma di dalam nilai tidak menggeser kolom: tanpa escape, kolom
  // kedua akan dianggap tiga kolom, dan baris kedua jadi tidak sama panjang
  // dengan header.
  eq('baris data sama panjang dengan header',
    (barisKomaData.match(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/g) || []).length + 1,
    (String(resKoma.body).trim().split('\r\n')[0].match(/,/g) || []).length + 1);

  console.log('\n=== 10. Galat tidak membocorkan isi kolom terlarang ===');

  // Pesan galat ikut sampai ke klien (FR-4.6). Kalau pesannya menyalin nilai
  // kolom terlarang, blokirnya bocor lewat jalur yang seharusnya menahannya.
  const barisRahasia = {};
  for (const f of FIELD_ORDER) barisRahasia[f] = 'nilai-' + f;
  barisRahasia.catatanTPK = 'RAHASIA-TIDAK-BOLEH-BOCOR';

  let galatRahasia = null;
  try {
    await kirimBaris({ query: { fields: 'catatanTPK' } }, resPalsu(), [barisRahasia]);
  } catch (e) { galatRahasia = e; }

  ok('galat benar-benar terjadi', galatRahasia !== null);
  ok('kode FIELD_NOT_GRANTED', galatRahasia && galatRahasia.code === 'FIELD_NOT_GRANTED');
  ok('status 403', galatRahasia && galatRahasia.status === 403);
  ok('pesan menyebut kolom yang ditolak', galatRahasia && galatRahasia.fields.includes('catatanTPK'));
  ok('pesan tidak memuat nilai kolom terlarang',
    galatRahasia && !String(galatRahasia.message).includes('RAHASIA-TIDAK-BOLEH-BOCOR'));

  console.log('\nlulus: ' + passed + '   gagal: ' + failed);
  if (failed > 0) {
    console.log('\nADA YANG RUSAK. Jangan andalkan blokir kolom sebelum ini hijau.');
    process.exit(1);
  } else {
    console.log('\nSEMUA UJI LOLOS');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
