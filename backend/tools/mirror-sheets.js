'use strict';

/**
 * Worker mirror PostgreSQL ke Google Sheets (F1.11).
 *
 * Tujuannya satu: TPK lama yang masih membaca spreadsheet tidak kehilangan
 * alur. Postgres sumber kebenaran, Sheets salinan.
 *
 * Semua keputusan tentang APA yang ditulis sudah ada di lib/sheets-mirror.js
 * dan diuji di tools/test-sheets-mirror.js. File ini hanya menjangkarkan
 * keputusan itu ke sumber data nyata: menarik record dari PostgreSQL, membaca
 * penanda dari sheet Mirror, lalu menulis sesuai rencana.
 *
 * Yang TIDAK ada di sini dan disengaja: penghapusan baris. Sheet legacy bukan
 * milik job ini. TPK lama boleh menambah baris sendiri di sana, dan mirror yang
 * menghapus baris berarti mengambil keputusan data yang bukan haknya.
 *
 * Pemakaian:
 *   node tools/mirror-sheets.js --dry-run     tampilkan rencana, jangan tulis
 *   node tools/mirror-sheets.js --batch 500   jumlah record per penetrated
 *   node tools/mirror-sheets.js --dry-run --json
 *
 * Variabel lingkungan:
 *   DATABASE_URL                PostgreSQL (wajib)
 *   SHEET_ID                    spreadsheet tujuan (wajib)
 *   SHEET_NAME                  nama sheet legacy, default Sheet1
 *   MIRROR_SHEET_NAME           nama sheet penanda, default Mirror
 *   GOOGLE_CREDENTIALS_JSON     isi service account, atau
 *   ./service_account.json
 */

const path = require('path');
const fs = require('fs');

const app = require(path.join(__dirname, '..', 'index.js'));
const mirror = require(path.join(__dirname, '..', 'lib', 'sheets-mirror.js'));

const { FIELD_ORDER } = app;

const SHEET_ID = process.env.SHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || 'Sheet1';
const MIRROR_SHEET_NAME = process.env.MIRROR_SHEET_NAME || 'Mirror';

// ---------------------------------------------------------------------------
// Argumen baris perintah
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { dryRun: false, batch: 200, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--batch') opts.batch = parseInt(argv[++i], 10) || opts.batch;
    else if (a === '--help' || a === '-h') opts.help = true;
    else {
      console.error('Argumen tidak dikenal: ' + a);
      process.exit(2);
    }
  }
  if (!(opts.batch > 0)) {
    console.error('--batch harus angka positif.');
    process.exit(2);
  }
  return opts;
}

function usage() {
  console.log([
    'Pakai: node tools/mirror-sheets.js [opsi]',
    '',
    '  --dry-run    tampilkan rencana, jangan menulis apa pun',
    '  --batch N    jumlah record per batch (default 200)',
    '  --json       keluarkan rencana sebagai JSON',
    '',
    'Wajib: DATABASE_URL dan SHEET_ID.',
  ].join('\n'));
}

// ---------------------------------------------------------------------------
// PostgreSQL
//
// Klien dimuat malas (lazily) supaya `--help` dan uji unit tidak perlu paket
// 'pg' terpasang. Pemisahan ini penting: logika mirror sudah teruji penuh
// tanpa database, dan tidak seharusnya ikut gagal hanya karena dependensi
// jaringan belum ada.
// ---------------------------------------------------------------------------

let pgModule = null;
function pg() {
  if (pgModule === null) {
    try {
      pgModule = require('pg');
    } catch (e) {
      throw new Error(
        'Paket "pg" belum terpasang. Jalankan `npm install pg` di backend/ ' +
        'atau set SKIP_DB=1 untuk uji yang tidak butuh database.'
      );
    }
  }
  return pgModule;
}

/**
 * Tarik record dari PostgreSQL.
 *
 * Hanya `active` dan `redacted` yang diambil. `payload_json` dikembalikan
 * sebagai objek -- bukan teks -- karena lib/sheets-mirror.js butuh isinya.
 *
 * Urutan `version DESC` sengaja: kalau nanti pembacaan tidak(batch) dan
 * penanda tidak Thermos, versi tertinggi tetap yang lebih dulu terlihat.
 */
async function ambilRecords(client, sejakRecordId, batas) {
  const sql =
    'SELECT record_id, version, status, record_hash, payload_json ' +
    'FROM records ' +
    'WHERE $1::text IS NULL OR record_id > $1 ' +
    "ORDER BY record_id ASC, version DESC " +
    'LIMIT $2';
  const res = await client.query(sql, [sejakRecordId || null, batas]);
  return res.rows.map((r) => ({
    record_id: r.record_id,
    version: r.version,
    status: r.status,
    record_hash: r.record_hash,
    payload: typeof r.payload_json === 'string'
      ? JSON.parse(r.payload_json)
      : r.payload_json,
  }));
}



// ---------------------------------------------------------------------------
// Google Sheets
// ---------------------------------------------------------------------------

function kredensial() {
  if (process.env.GOOGLE_CREDENTIALS_JSON) {
    return JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
  }
  const p = path.join(__dirname, '..', 'service_account.json');
  if (!fs.existsSync(p)) {
    throw new Error(
      'Kredensial Google tidak ditemukan. Set GOOGLE_CREDENTIALS_JSON atau ' +
      'taruh service_account.json di backend/.'
    );
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

async function sheetsClient() {
  const { google } = require('googleapis');
  const auth = new google.auth.GoogleAuth({
    credentials: kredensial(),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

/**
 * Baca sheet penanda dan sheet legacy.
 *
 * Dua panggilan terpisah memang memakan kuota, tapi keduanya wajib: penanda
 * memberi idempotensi, dan baris terakhir sheet legacy memberi penomoran. Kalau
 * keduanya diambil dalam satu rentang, sheet Mirror yang letaknya berbeda tidak
 * ikut terbaca dan penomoran jadi salah.
 */
async function bacaSheet(sheets) {
  const marker = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${MIRROR_SHEET_NAME}!A1:E`,
  });
  const legacy = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A1:A`,
  });

  return {
    tercermin: mirror.bacaTercermin(marker.data.values),
    posisiMarker: bacaMarkerPosisi(marker.data.values),
    barisTerakhir: hitungBarisTerakhir(legacy.data.values),
  };
}

/**
 * Pasangkan `markerBaris` ke rencana, lalu kembalikan Venture yang sama.
 *
 * Planner tidak tahu posisi baris di sheet Mirror -- itu urusan worker, karena
 * hanya worker yang tahu indeks aktual di sheet. Dipasangkan di sini, bukan
 * di dalam `rencanaMirror`, supaya planner tetap murni (bisa diuji tanpa Google)
 * dan tidak perlu tahu bentuk physical sheet.
 */
function pasangkanPosisiMarker(rencana, posisiMarker) {
  const pos = posisiMarker || {};
  for (const u of rencana.perbarui) {
    u.markerBaris = pos[u.record_id];
  }
  for (const k of rencana.kosongkan) {
    k.markerBaris = pos[k.record_id];
  }
  return rencana;
}

/** Nomor `No` terakhir di kolom A, dengan baris 1 (header) diabaikan. */
function hitungBarisTerakhir(values) {
  const rows = values || [];
  let n = 0;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r && r[0] !== undefined && r[0] !== null && String(r[0]).trim() !== '') {
      const v = Number(r[0]);
      if (Number.isFinite(v) && v > n) n = v;
    }
  }
  return n;
}

/**
 * Pastikan sheet penanda ada dan punya header.
 *
 * Tab Mirror dibuat kalau belum ada. Sheet API menjawab 404/400 untuk tab yang
 * tidak ada -- bukan nilai kosong -- jadi tanpa penanganan ini job berhenti
 * sebelum pernah menulis apa pun, dan tab Mirror yang belum ada akan selalu
 * menggagalkan job, bukan hanya pada run pertama.
 *
 * @returns {Promise<boolean>} true kalau tab baru dibuat
 */
async function pastikanMarker(sheets) {
  let ada = null;
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${MIRROR_SHEET_NAME}!A1`,
    });
    ada = res.data.values;
  } catch (e) {
    // 404 = tab tidak ada. Galat lain (izin, jaringan) harus naik supaya tidak
    //Dipalsukan jadi "tab baru dibuat".
    if (!isTabTidakAda(e)) throw e;
  }

  if (ada) {
    const first = ada[0] ? ada[0][0] : '';
    if (first !== undefined && first !== null && String(first).trim() !== '') return false;
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${MIRROR_SHEET_NAME}!A1`,
      valueInputOption: 'RAW',
      resource: { values: [mirror.HEADER_MIRROR] },
    });
    return false;
  }

  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const adaSudah = (meta.data.sheets || []).some(
    (s) => s.properties && s.properties.title === MIRROR_SHEET_NAME
  );
  if (!adaSudah) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      resource: { requests: [{ addSheet: { properties: { title: MIRROR_SHEET_NAME } } }] },
    });
  }
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${MIRROR_SHEET_NAME}!A1`,
    valueInputOption: 'RAW',
    resource: { values: [mirror.HEADER_MIRROR] },
  });
  return true;
}

/**
 * Apakah galat berarti "tab ini tidak ada".
 *
 * Sheets API balas 404 dengan pesan unable to parse range untuk tab yang hilang.
 * Kode 400 juga muncul kalau spreadsheet-nya sendiri tidak ada -- itu kondisi
 * lain dan harus tetap jadi galat, jadi yang diperiksa pesannya, bukan kodenya.
 */
function isTabTidakAda(e) {
  const msg = String((e && (e.message || e)) || '');
  return /unable to parse range/i.test(msg) || /not found/i.test(msg);
}

/**
 * Terapkan rencana ke sheet.
 *
 * Penulisan memakai `values.append` untuk baris baru dan `values.update` untuk
 * penulisan ulang. Dua operasi terpisah disengaja: append tidak menimpa apa pun,
 * sedangkan update ditulis pada baris yang sudah diketahui sebelumnya -- sehingga
 * kalau salah satu gagal, sheet tetap dalam keadaan yang bisa dibaca dan job
 * berikutnya mengulangi bagian yang gagal tanpa merusak apa pun.
 */
async function terapkan(sheets, rencana, syncedAt) {
  let ditulis = 0;

  for (const t of rencana.tambah) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!A1`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      resource: { values: [[t.no, ...t.values]] },
    });
    ditulis++;
  }

  const kolomTerakhir = kolomKe(FIELD_ORDER.length + 1); // +1 untuk kolom No

  for (const u of rencana.perbarui) {
    // `u.baris` sudah dihitung dari kolom `no` di sheet Mirror -- bukan dari
    // indeks baris Mirror. Sheet legacy juga berisi baris TPK, jadi keduanya
    // tidak bisa diasumsikan sejajar.
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!A${u.baris}:${kolomTerakhir}${u.baris}`,
      valueInputOption: 'RAW',
      resource: { values: [[u.no, ...u.values]] },
    });
    ditulis++;
  }

  for (const k of rencana.kosongkan) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!A${k.baris}:${kolomTerakhir}${k.baris}`,
      valueInputOption: 'RAW',
      // Kolom No dipertahankan supaya penomoran TPK tidak ikut bergeser.
      resource: { values: [[k.no, ...mirror.selKosong(FIELD_ORDER.length)]] },
    });
    ditulis++;
  }

  return ditulis;
}

/** Kolom Excel dari indeks 1-based: 1 -> A, 26 -> Z, 27 -> AA. */
function kolomKe(n) {
  let s = '';
  let v = n;
  while (v > 0) {
    const rem = (v - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    v = Math.floor((v - 1) / 26);
  }
  return s;
}

/**
 * Perbarui penanda di sheet Mirror.
 *
 * Penanda TIDAK pernah append. Kalau update menulis baris penanda baru, sheet
 * Mirror akan punya dua baris untuk satu `record_id` setiap kali record
 * diperbarui, dan setiap baris itu dibaca kembali sebagai entri yang valid. Selain
 * sheet membengkak tanpa batas, `bacaTercermin` akan memakai entri paling akhir
 * -- yang benar secara kebetulan, tapi hanya selama tidak ada job yang berjalan
 * di tengah.
 *
 * Menulis di baris yang sudah ada membuat sheet Mirror tetap satu baris per
 * record. Baris baru hanya ditulis untuk record yang benar-benar baru.
 */
async function tulisMarker(sheets, rencana, syncedAt) {
  let baru = 0;
  let diperbarui = 0;

  for (const t of rencana.tambah) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${MIRROR_SHEET_NAME}!A1`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      resource: { values: [mirror.marker(t, t.no, syncedAt)] },
    });
    baru++;
  }

  // Penanda untuk record yang diperbarui atau dikosongkan sudah ADA di sheet
  // Mirror -- posisinya ada di `markerBaris`, diisi oleh bacaMarkerPosisi.
  for (const u of rencana.perbarui) {
    const pos = u.markerBaris;
    if (!pos) continue;
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${MIRROR_SHEET_NAME}!A${pos}:E${pos}`,
      valueInputOption: 'RAW',
      resource: { values: [mirror.marker(u, u.no, syncedAt)] },
    });
    diperbarui++;
  }

  for (const k of rencana.kosongkan) {
    const pos = k.markerBaris;
    if (!pos) continue;
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${MIRROR_SHEET_NAME}!A${pos}:E${pos}`,
      valueInputOption: 'RAW',
      resource: { values: [mirror.marker(k, k.no, syncedAt)] },
    });
    diperbarui++;
  }

  return { baru, diperbarui };
}

/**
 * Posisi baris penanda di sheet Mirror, supaya update menulis di tempat yang
 * benar dan bukan append.
 *
 * Sheet Mirror bisa juga berisi baris yang tidak dibaca `bacaTercermin` (misal
 * `no` kosong), jadi posisinya dicari langsung dari isi sheet, bukan dari indeks
 * hasil filter.
 */
function bacaMarkerPosisi(values) {
  const posisi = {};
  const rows = values || [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.length === 0) continue;
    const id = r[0];
    if (id === undefined || id === null || String(id).trim() === '') continue;
    posisi[String(id)] = i + 1;
  }
  return posisi;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { usage(); return; }

  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL belum diset. Mirror butuh PostgreSQL.');
    process.exit(2);
  }
  if (!SHEET_ID) {
    console.error('SHEET_ID belum diset. Mirror butuh spreadsheet tujuan.');
    process.exit(2);
  }

  const Client = pg().Client;
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  const sheets = await sheetsClient();
  if (await pastikanMarker(sheets)) {
    console.log('Sheet penanda "' + MIRROR_SHEET_NAME + '" dibuat dengan header.');
  }

  try {
    let sejak = null;
    let total = { tambah: 0, perbarui: 0, kosongkan: 0, lewati: 0, anomali: 0 };


    for (;;) {
      const baris = await ambilRecords(client, sejak, opts.batch);
      if (baris.length === 0) break;

      const { tercermin, posisiMarker, barisTerakhir } = await bacaSheet(sheets);
      const rencana = mirror.rencanaMirror(baris, tercermin, FIELD_ORDER, barisTerakhir);
      pasangkanPosisiMarker(rencana, posisiMarker);

      total.tambah += rencana.ringkas.tambah;
      total.perbarui += rencana.ringkas.perbarui;
      total.kosongkan += rencana.ringkas.kosongkan;
      // `lewati` dan `anomali` dihitung terpisah oleh planner: keduanya berarti
      // record tidak ditulis, tapi anomali juga perlu dilaporkan.
      total.lewati += rencana.ringkas.lewati;
      total.anomali += rencana.ringkas.anomali;

      if (rencana.anomali.length > 0) {
        // Anomali dilaporkan, bukan diperbaiki. Dua hash untuk satu versi
        // berarti ada perubahan di luar job ini, dan menimpanya berarti
        // membatalkan apa yang sudah tercatat di anchor.
        console.error(
          'PERINGATAN: ' + rencana.anomali.length +
          ' record punya hash berbeda pada versi yang sama. Tidak ditulis.'
        );
        for (const a of rencana.anomali) console.error('  ' + a.record_id + ': ' + a.reason);
      }

      if (opts.dryRun) {
        console.log('[dry-run] ' + JSON.stringify(rencana.ringkas));
        if (opts.json) console.log(JSON.stringify(rencana, null, 2));
      } else {
        const syncedAt = new Date().toISOString();
        const n = await terapkan(sheets, rencana, syncedAt);
        // Penanda ditulis SETELAH data legacy. Urutan ini penting: kalau penanda
        // lebih dulu dan penulisan data gagal, job berikutnya akan melihat
        // record sebagai "sudah tercermin" dan melompatinya -- perubahan
        // hilang tanpa pernah masuk sheet.
        await tulisMarker(sheets, rencana, syncedAt);
        console.log('ditulis ' + n + ' baris');
      }

      // Batch berikutnya mulai dari record_id terakhir. `version DESC` di query
      // membuat semua versi satu record datang berurutan dan versi tertinggi
      // lebih dulu, jadi membatasinya di `record_id` terakhir tidak
      // melewatkan versi yang lebih baru.
      sejak = baris[baris.length - 1].record_id;
      if (baris.length < opts.batch) break;
    }

    console.log('selesai: ' + JSON.stringify(total));
  } finally {
    await client.end();
  }
}

module.exports = {
  parseArgs,
  hitungBarisTerakhir,
  kolomKe,
  ambilRecords,
  bacaSheet,
  pastikanMarker,
  terapkan,
  tulisMarker,
  bacaMarkerPosisi,
  pasangkanPosisiMarker,
};

if (require.main === module) {
  main().catch((e) => {
    console.error('Mirror gagal: ' + e.message);
    process.exit(1);
  });
}
