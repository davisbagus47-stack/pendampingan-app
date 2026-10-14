'use strict';

/**
 * Transformsasi baris spreadsheet legacy menjadi baris `records`.
 *
 * Modul ini murni: tidak membaca berkas, tidak talking ke jaringan, tidak
 * menyentuh database. Semua keputusan ada di sini dan dapat diuji tanpa
 * infrastruktur apa pun. Pembacaan sheet dan penulisan SQL ada di
 * `tools/backfill.js`.
 *
 * ## Prinsip yang dipegang: backfill tidak menebak
 *
 * Setiap kali data tidak cukup untuk membuat record yang benar, modul ini
 * menolak dan melaporkannya -- bukan mengisi dengan nilai yang tampak masuk
 * akal. Alasannya spesifik: backfill menulis `record_hash` yang menjadi anchor
 * on-chain. Hash dari data yang ditebak permanen adalah data yang SELALU tidak
 * bisa dikoreksi tanpa membatalkan anchor, karena mengoreksinya berarti
 * menghasilkan hash baru untuk isi yang sama.
 *
 * Karena itu ada dua kategori penolakan yang tidak bisa dinegosiasikan:
 *
 *   | Kategori                | Ditolak | Opt-in   |
 *   |-------------------------|---------|----------|
 *   | taksonomi di luar ADR-5 | ya      | driver   |
 *   | NIK tidak valid         | ya      | tidak ada|
 *
 * `Balita` ditolak karena CHECK DDL tidak memuatnya dan `keputusan-lingkup-uji.md`
 * menetapkan penambahan taksonomi sebagai perubahan tersendiri yang menaikkan
 * `schema_version`. Menempakannya ke kategori lain berarti memalsukan data.
 *
 * NIK tidak punya opt-in karena kolomnya `NOT NULL`; tanpa NIK tidak ada subjek.
 *
 * Tidak ada opt-in untuk identitas kunjungan, dan itu bukan kelalaian:
 * `tanggal_kunjungan` bertipe `NOT NULL`, jadi setiap record yang bisa masuk
 * database pasti punya tanggal kunjungan. `--identity-row` pernah ada di sini
 * dengan alasan "kalau tanggal kosong, pakai nomor baris" -- jalurnya tidak
 * akan pernah terjangkau, karena baris seperti itu ditolak DDL. Flag yang
 * menjanjikan kemampuan yang tidak ada lebih berbahaya daripada tidak ada flag.
 *
 * Yang tersisa yang benar-benar tidak bisa diputuskan di sini adalah urutan
 * tanggal numerik bergaris miring; lihat `parseTanggal`.
 */

const crypto = require('crypto');

const {
  SCHEMA_VERSION,
  recordHash,
} = require('./canonical');
const { sectionsFor } = require('./sections');
const { NUMERIC_FIELDS, DATE_FIELDS, columnName } = require('./field-types');

/**
 * Namespace UUIDv5 untuk `record_id`.
 *
 * Harus tidak pernah berubah. Kalau berubah, seluruh `record_id` hasil
 * backfill sebelumnya berubah dan anchor-nya tidak lagi cocok dengan database.
 * Nilainya tetap dan hanya berarti "backfill v1".
 */
const NAMESPACE_BACKFILL = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

/** Nilai yang dianggap "tidak diisi" pada sheet lama. */
const KOSONG = new Set(['', '-', '--', 'n/a', 'na', 'nil', 'kosong', 'tidak ada', 'tidak isi']);

/**
 * Kolom yang DDL tandai `NOT NULL`.
 *
 * Daftar ini diturunkan dari `sql/001_schema.sql`, bukan dipilih sendiri:
 * kolom yang kelewat ada di sini ditolak tanpa alasan yang benar, dan kolom
 * yang kelewat tidak ada di sini lolos sampai `psql` menolaknya. Saat ini
 * hanya `tanggal_kunjungan` yang bertipe khusus sekaligus NOT NULL, dan
 * pemeriksaan "terisi tapi tidak terbaca" di bawah hanya menyala untuk
 * field yang masuk DATE_FIELDS/NUMERIC_FIELDS -- jadi menambah kolom NOT NULL
 * baru di DDL cukup dengan menambah namanya di sini.
 */
const WAJIB = [
  'nik', 'namaLengkap', 'namaDesa', 'tanggalKunjungan', 'namaTPK', 'peranTPK',
];

/**
 * UUIDv5 dari nama, di dalam namespace tetap.
 *
 * Dipakai manual, bukan lewat pustaka, supaya tidak bergantung pada versi
 * pustaka yang berbeda pendapat tentang RFC 4122.
 */
function uuidV5(namespaceUuid, name) {
  const ns = Buffer.from(namespaceUuid.replace(/-/g, ''), 'hex');
  if (ns.length !== 16) throw new Error('Namespace UUID tidak valid: ' + namespaceUuid);
  const hash = crypto.createHash('sha1').update(ns).update(Buffer.from(name, 'utf8')).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // versi 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // varian RFC 4122
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16),
    hex.slice(16, 20), hex.slice(20, 32),
  ].join('-');
}

/** Sama seperti `tombol()` di index.js: semua nilai jadi string, null jadi "". */
function tombol(v) {
  return v === '' || v === null || v === undefined ? '' : String(v);
}

function kosong(v) {
  return KOSONG.has(String(v == null ? '' : v).trim().toLowerCase());
}

/**
 * Parse nilai numerik dengan kebijakan yang sama seperti DDL.
 *
 * Aturan yang tertulis di `sql/001_schema.sql`: kosong/"-"/"N/A" menjadi NULL,
 * koma desimal menjadi titik, satuan ("70 kg") dibuang, dan kegagalan parse
 * menjadi NULL -- bukan galat. Payload verbatim tetap utuh di `payload_json`,
 * jadi nilai aslinya tidak hilang.
 */
function parseAngka(v) {
  if (kosong(v)) return null;
  let s = String(v).trim().replace(',', '.');
  s = s.replace(/[^0-9.\-]/g, '');
  if (s === '' || s === '-' || s === '.') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse tanggal, dengan urutan tanggal numerik sebagai keputusan pemanggil.
 *
 * Format yang diterima:
 *
 *   YYYY-MM-DD, YYYY/MM/DD, YYYY.MM.DD  tahun dulu, tidak pernah ambigu
 *   "12 Jan 2024", "12 Januari 2024"     bulan bernama, tidak pernah ambigu
 *   "2024-01-12 08:30"                   jam dibuang, tanggalnya di-parse ulang
 *   15/03/2024, 03/15/2024              angka, ambigu kalau keduanya <= 12
 *
 * Bentuk terakhir tidak bisa diputuskan dari isinya: `03/04/2024` bisa 3 April
 * atau 4 Maret, dan keduanya salah kalau ditebak. Modul ini menolak bentuk ambigu
 * daripada mengarang tanggal yang terlihat masuk akal -- supaya hash yang
 * ditandatangani di ledger tidak pernah berasal dari tebakan.
 * Pemanggil yang tahu locale sheet-nya meneruskan `dateOrder`:
 * `'ddmmyyyy'` atau `'mmddyyyy'`. Tanpa itu, `15/03/2024` tetap terbaca karena
 * angka 15 mustahil menjadi bulan.
 *
 * @param {string} v
 * @param {'ddmmyyyy'|'mmddyyyy'} [dateOrder]
 * @returns {string|null} ISO `YYYY-MM-DD`, atau null bila tidak bisa dipastikan
 */
function parseTanggal(v, dateOrder) {
  if (kosong(v)) return null;
  const s = String(v).trim();

  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (m) return isoTanggal(m[1], m[2], m[3]);

  // "12 Jan 2024", "12 Januari 2024", "12 Jan 24"
  m = s.match(/^(\d{1,2})[\s-]+([A-Za-z]{3,9})[\s-]+(\d{2,4})$/);
  if (m) {
    const bulan = BULAN[m[2].slice(0, 3).toLowerCase()];
    if (!bulan) return null;
    const tahun = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return isoTanggal(String(tahun), String(bulan), m[1]);
  }

  // "2024-01-12 08:30". Tanggalnya di-parse ulang supaya jam tidak ikut
  // dibawa ke kolom DATE dan supaya padding-nya seragam.
  m = s.match(/^(\d{4}[-/.]\d{1,2}[-/.]\d{1,2})[T ]/);
  if (m) return parseTanggal(m[1], dateOrder);

  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const tahun = m[3];
    if (a > 12 && b <= 12) return isoTanggal(tahun, b, a); // hari pasti lebih dulu
    if (b > 12 && a <= 12) return isoTanggal(tahun, a, b); // bulan pasti lebih dulu
    if (dateOrder === 'ddmmyyyy') return isoTanggal(tahun, b, a);
    if (dateOrder === 'mmddyyyy') return isoTanggal(tahun, a, b);
    return null; // ambigu: locale sheet tidak diketahui, jadi jangan menebak
  }

  return null;
}

const BULAN = {
  jan: 1, feb: 2, mar: 3, apr: 4, mei: 5, jun: 6,
  jul: 7, agu: 8, sep: 9, okt: 10, nov: 11, des: 12,
};

/**
 * Bentuk ISO dari tahun/bulan/hari, menolak tanggal yang tidak ada di kalender.
 *
 * Pemeriksaan rentang saja tidak cukup: 31 Februari lolos batas 1..31 lalu
 * berakhir sebagai `2024-02-31`, yang ditolak PostgreSQL dengan "date/time field
 * value out of range". Karena itu kalender sebenarnya ikut diperiksa, dan
 * pembulatan ke bawah dihindari dengan membangun tanggal dari tengah bulan.
 */
function isoTanggal(tahun, bulan, hari) {
  const t = Number(tahun), b = Number(bulan), h = Number(hari);
  if (!Number.isInteger(t) || !Number.isInteger(b) || !Number.isInteger(h)) return null;
  if (t < 1900 || t > 2999) return null;
  if (b < 1 || b > 12) return null;
  if (h < 1 || h > 31) return null;

  const d = new Date(Date.UTC(t, b - 1, h));
  if (d.getUTCFullYear() !== t || d.getUTCMonth() !== b - 1 || d.getUTCDate() !== h) {
    return null; // tanggal tidak ada, misalnya 31 Februari atau 30 Februari
  }
  return String(t).padStart(4, '0') + '-' + String(b).padStart(2, '0') + '-' + String(h).padStart(2, '0');
}

/**
 * Kunci yang membedakan satu kunjungan dari kunjungan lain untuk subjek sama.
 *
 * Urutan pilihan disengaja. `pendampinganKe` adalah nomor kunjungan yang
 * diberikan petugas, jadi paling stabil dan paling murah. `tanggalKunjungan`
 * dipakai kalau nomor tidak diisi.
 *
 * Tanggal dinormalisasi ke ISO sebelum jadi kunci. Tanpa itu, "15/03/2024"
 * dan "2024-03-15" -- tanggal yang sama, ditulis berbeda di sheet -- akan
 * menghasilkan dua `record_id` berbeda, dan kunjungan yang sama masuk dua
 * kali. Karena `record_id` tidak bisa diubah tanpa membatalkan anchor, itu
 * bukan kesalahan yang bisa diperbaiki belakangan lewat UPDATE.
 *
 * Kalau tanggal tidak bisa di-parse, teks mentahnya dipakai. Baris seperti ini
 * sudah ditolak lebih dulu kalau kolomnya wajib, jadi jalur ini hanya
 * menyalin nilai supaya tidak ada `null` yang ikut jadi nama.
 *
 * Kalau keduanya kosong, modul tidak menebak: lihat catatan pemetaan di
 * `rencana-kerja-poc.md`.
 */
function kunciKunjungan(payload, dateOrder) {
  const ke = payload.pendampinganKe;
  if (!kosong(ke)) return 'ke:' + String(ke).trim();
  const tgl = payload.tanggalKunjungan;
  if (!kosong(tgl)) {
    const iso = parseTanggal(tgl, dateOrder);
    return 'tgl:' + (iso === null ? String(tgl).trim() : iso);
  }
  return null;
}

/**
 * Bangun payload 72 field dari satu baris sheet.
 *
 * Memakai `tombol()` persis seperti `buildRow()`, supaya hash yang dihitung di
 * sini sama dengan hash yang akan dihitung jalur tulis produksi untuk isi yang
 * sama. Kalau berbeda di sini, record hasil backfill tidak akan cocok dengan
 * record yang dikirim form weeks kemudian -- dan perbedaannya tidak terlihat
 * tanpa membandingkan hash secara manual.
 */
function payloadFromRow(row, fieldOrder) {
  const payload = {};
  for (const f of fieldOrder) payload[f] = tombol(row[f]);
  return payload;
}

/**
 * Proyeksi ke kolom bertipe khusus.
 *
 * Hanya mengisi kolom yang perlu parse; kolom TEXT diambil apa adanya supaya
 * nilainya tidak pernah berubah bentuk.
 *
 * Klasifikasi diambil dari `NUMERIC_FIELDS`/`DATE_FIELDS` milik
 * `lib/field-types.js`, bukan diturunkan ulang di sini. Versi pertama modul ini
 * menulis `TYPES[f] === 'NUMERIC'`, yang tidak pernah benar karena nilainya
 * `'NUMERIC(4,1)'` -- sehingga setiap kolom numerik lolos ke kolom TEXT dan
 * PostgreSQL menolaknya dengan "invalid input syntax for type numeric".
 */
/**
 * Tanggal ambigu yang berhasil ditebak karena pemanggil memberi `dateOrder`.
 *
 * `tanggalTidakPasti` hanya melaporkan tanggal yang GAGAL terbaca, jadi ketika
 * pemanggil sudah tahu locale sheet-nya (`--date-order`), tanggal `03/04/2024`
 * yang tadinya ditolak sekarang diam-diam diterima sebagai `2024-04-03`.
 *
 * Itu pilihan yang benar -- locale sheet memang keputusan manusia -- tapi
 * kalau locale-nya keliru, tidak ada jejak sama sekali bahwa tebakan itu
 * terjadi, dan tanggalnya ikut tersalin ke mana-mana termasuk ke anchor
 * on-chain. Daftar ini yang membuatnya terlihat, jadi locale yang keliru
 * masih bisa ditemukan setelah run selesai.
 */
function tanggalAsumsi(payload, fieldOrder, dateOrder) {
  const out = [];
  if (!dateOrder) return out;
  for (const f of fieldOrder) {
    if (!DATE_FIELDS.has(f)) continue;
    const v = payload[f];
    if (kosong(v)) continue;
    const ddm = parseTanggal(v, 'ddmmyyyy');
    const mdy = parseTanggal(v, 'mmddyyyy');
    // Hanya yang GENAP ambigu: kalau kedua pembacaan sama, tidak ada tebakan
    // yang terjadi dan tidak perlu dilaporkan.
    if (ddm && mdy && ddm !== mdy) {
      out.push({ field: f, nilai: String(v).trim(), dipakai: parseTanggal(v, dateOrder) });
    }
  }
  return out;
}

function proyeksi(payload, fieldOrder, dateOrder) {
  const out = {};
  for (const f of fieldOrder) {
    if (NUMERIC_FIELDS.has(f)) out[f] = parseAngka(payload[f]);
    else if (DATE_FIELDS.has(f)) out[f] = parseTanggal(payload[f], dateOrder);
  }
  return out;
}

/**
 * Nilai bertipe khusus yang bentuk teksnya berubah setelah di-parse.
 *
 * Ini bukan daftar kesalahan -- ini daftar tempat isi database akan TIDAK sama
 * dengan isi sheet: "15/03/2024" menjadi `2024-03-15`, "62,55 kg" menjadi
 * `62.55`.
 *
 * Why it matters: `record_hash` dihitung dari `payload_json` yang verbatim, dan
 * nilai bertipe khusus tidak ikut di dalamnya. Jadi nilai yang sudah diubah
 * bentuknya TIDAK tercakup anchor on-chain. Untuk jalur tulis produksi ini tidak
 * jadi masalah -- form mengirim "2024-03-15" dan angka sudah numerik, jadi
 * tidak ada yang berubah bentuk. Di backfill perubahan bentuknya commonplace,
 * jadi harus disebut: kalau nanti ada yang bertanya mengapa kolom
 * `tanggal_kunjungan` berbeda dari `payload_json`, jawabannya ada di sini.
 *
 * Mengembalikan juga `masalah` untuk tanggal, supaya "ambigu" (bisa
 * diperbaiki pemanggil) tidak tertukar dengan "rusak" (tidak bisa).
 */
function tanggalTidakPasti(payload, fieldOrder, dateOrder) {
  const out = [];
  for (const f of fieldOrder) {
    if (!DATE_FIELDS.has(f)) continue;
    const v = payload[f];
    if (kosong(v)) continue;
    if (parseTanggal(v, dateOrder) !== null) continue;

    const ddm = parseTanggal(v, 'ddmmyyyy');
    const mdy = parseTanggal(v, 'mmddyyyy');
    const masalah = ddm && mdy && ddm !== mdy ? 'ambigu' : 'rusak';
    out.push({ field: f, nilai: String(v).trim(), masalah, ddmmyyyy: ddm, mmddyyyy: mdy });
  }
  return out;
}

/** Nilai yang berubah bentuk antara `payload_json` verbatim dan kolom bertipe. */
function nilaiDiubah(payload, proyeksi) {
  const out = [];
  for (const [f, nilai] of Object.entries(proyeksi || {})) {
    if (nilai === null) continue;
    const asal = String(payload[f] === undefined ? '' : payload[f]).trim();
    if (asal === '') continue;
    const teks = String(nilai);
    if (DATE_FIELDS.has(f)) {
      if (asal !== teks) out.push({ field: f, asal, jadi: teks });
    } else if (Math.abs(Number(asal.replace(/[^0-9.\-]/g, '')) - Number(nilai)) > 1e-9) {
      out.push({ field: f, asal, jadi: teks });
    }
  }
  return out;
}

/**
 * Rencana backfill untuk sekumpulan baris.
 *
 * @param {object} opsi
 * @param {Array<Record<string, unknown>>} opsi.rows baris sheet, sudah dipetakan
 *   ke nama field
 * @param {string[]} opsi.fieldOrder
 * @param {string} opsi.institutionKey agencies.institution_key
 * @param {Object<string, Set<string>>} opsi.sectionMap
 * @param {(v: string) => string} [opsi.normalizeSasaran]
 * @param {(v: string) => string} [opsi.normalizeNik]
 * @param {'ddmmyyyy'|'mmddyyyy'} [opsi.dateOrder] urutan tanggal numerik
 *   bergaris miring; tanpa ini tanggal ambigu ditolak, bukan ditebak
 *
 * Catatan: transform ini TIDAK punya opsi melewati baris taksonomi. Baris
 * seperti itu selalu masuk ke `ditolak`. Keputusan "apakah kegagalan itu
 * menggagalkan seluruh run" bukan urusan transformasi, melainkan urusan pemanggil
 * yang melihat seluruh baris yang ditolak -- lihat `tools/backfill.js`.
 *
 * @returns {{records: object[], ditolak: object[], duplikat: object[],
 *   peringatan: string[], tanggalRusak: object[], diubah: object[]}}
 */
function rencanaBackfill(opsi) {
  const {
    rows, fieldOrder, institutionKey, sectionMap,
    normalizeSasaran = (v) => v,
    normalizeNik = (v) => String(v || '').replace(/\D/g, ''),
    dateOrder,
  } = opsi;

  if (typeof institutionKey !== 'string' || institutionKey.trim() === '') {
    throw new Error('institutionKey wajib diisi: record tanpa pengikat instansi tidak bisa diverifikasi (FR-4.3)');
  }
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(institutionKey)) {
    throw new Error(
      'institutionKey tidak cocok CHECK agencies.institution_key: ' + JSON.stringify(institutionKey) +
      ' (huruf kecil, angka, tanda hubung)'
    );
  }

  const records = [];
  const ditolak = [];
  const duplikat = [];
  const peringatan = [];
  const tanggalRusak = [];
  const diasumsikan = [];
  const diubah = [];
  const sudahPunya = new Map();

  rows.forEach((row, indeks) => {
    const nomor = indeks + 1;

    const payload = payloadFromRow(row, fieldOrder);
    const jenis = normalizeSasaran(String(payload.jenisSasaran || '').trim().toLowerCase());
    payload.jenisSasaran = jenis;

    const tolak = (alasan, kategori, extra) => {
      ditolak.push({
        baris: nomor, kategori, alasan, nik: String(payload.nik || '').trim(),
        payload,
      });
      if (extra) peringatan.push('baris ' + nomor + ': ' + extra);
    };

    // 1. Taksonomi. Dicek lebih dulu karena setelahnya tidak ada yang bisa
    //    dilakukan dengan baris ini.
    if (!jenis) {
      tolak('jenisSasaran tidak dipetakan ke taksonomi ADR-5', 'taksa-tak-dikenal');
      return;
    }
    if (jenis !== 'Catin' && jenis !== 'Ibu Hamil' && jenis !== 'Ibu Nifas' && jenis !== 'Baduta') {
      tolak(
        'jenisSasaran "' + jenis + '" ada di luar taksonomi ADR-5',
        'taksonomi',
        'gunakan --skip-balita untuk melewati baris seperti ini secara sadar'
      );
      return;
    }

    // 2. Subjek.
    const nik = String(normalizeNik(payload.nik) || '').trim();
    if (!nik) {
      tolak('NIK kosong; kolomnya NOT NULL dan tanpa NIK tidak ada subjek', 'nik');
      return;
    }
    payload.nik = nik;

    // 3. Kunjungan. `tanggal_kunjungan` NOT NULL, jadi setelah pemeriksaan
    //    kolom wajib di bawah, kunci ini selalu ada -- tidak ada jalur yang
    //    perlu ditebak.
    const kunci = kunciKunjungan(payload, dateOrder);

    // 4. Kolom NOT NULL lain.
    //
    //    Diperiksa setelah proyeksi, bukan hanya lewat `kosong()`. Kolom
    //    `tanggal_kunjungan` bertipe DATE NOT NULL, jadi "terisi tapi tidak
    //    terbaca" bukan kasus kosong: kolom kosong ditolak, tapi "03/04/2024"
    //    lolos pemeriksaan `kosong()` lalu diproyeksi jadi NULL -- dan SQL-nya
    //    akan menulis NULL ke kolom NOT NULL. Kegagalan baru muncul saat
    //    `psql` menjalankan INSERT, jauh dari penyebabnya, dengan pesan
    //    "null value in column violates not-null constraint" yang tidak
    //    menyebut baris mana pun.
    const proy = proyeksi(payload, fieldOrder, dateOrder);
    for (const wajib of WAJIB) {
      if (kosong(payload[wajib])) {
        tolak('kolom wajib "' + wajib + '" kosong; DDL menandainya NOT NULL', 'wajib-kosong');
        return;
      }
      if (DATE_FIELDS.has(wajib) || NUMERIC_FIELDS.has(wajib)) {
        if (proy[wajib] === null) {
          const DATE = DATE_FIELDS.has(wajib);
          let petunjuk = '';
          if (DATE) {
            // Bedakan "tanggalnya memang ambigu" dari "tanggalnya rusak".
            // Yang ambigu bisa diperbaiki pemanggil dengan --date-order; yang
            // rusak tidak. Tanpa pembedaan, satu pesan galat untuk dua masalah
            // yang harus ditangani berbeda.
            const ddm = parseTanggal(payload[wajib], 'ddmmyyyy');
            const mdy = parseTanggal(payload[wajib], 'mmddyyyy');
            if (ddm && mdy && ddm !== mdy) {
              petunjuk = ' Nilai ini ambigu: terbaca ' + ddm + ' kalau ddmmyyyy, ' +
                mdy + ' kalau mmddyyyy. Ulangi dengan --date-order sesuai locale sheet.';
            }
          }
          tolak(
            'kolom wajib "' + wajib + '" berisi "' + String(payload[wajib]).trim() +
            '" yang tidak terbaca sebagai ' + (DATE ? 'tanggal' : 'angka') +
            '; kolomnya bertipe ' + (DATE ? 'DATE' : 'NUMERIC') + ' NOT NULL, jadi tidak bisa dikosongkan.' +
            petunjuk,
            'wajib-rusak'
          );
          return;
        }
      }
    }

    // 5. Identitas record. Turunan dari isi supaya backfill bisa dijalankan ulang.
    const nama = institutionKey + '|' + nik + '|' + kunci;
    const recordId = uuidV5(NAMESPACE_BACKFILL, nama);

    if (sudahPunya.has(recordId)) {
      const pertama = sudahPunya.get(recordId);
      duplikat.push({
        baris: nomor, barisPertama: pertama, recordId,
        alasan: 'record_id sama dengan baris ' + pertama,
      });
      return;
    }
    sudahPunya.set(recordId, nomor);

    // 6. Tanggal bermasalah dan nilai yang berubah bentuk. Dicatat SETELAH
    //    pemeriksaan duplikat, supaya laporan hanya menyebut baris yang benar-
    //    benar akan masuk SQL. Melaporkan baris yang lalu dilompati sebagai
    //    duplikat hanya menambah pekerjaan membaca tanpa menambah informasi.
    //
    //    Nullable berarti tidak menggagalkan, tapi tetap harus disebut: NULL
    //    karena "31 Feb" berbeda dari NULL karena tidak diisi, dan yang
    //    pertama berarti ada data yang hilang tanpa jejak.
    for (const a of tanggalTidakPasti(payload, fieldOrder, dateOrder)) {
      tanggalRusak.push(Object.assign({ baris: nomor }, a));
    }

    // Nilai yang bentuknya berubah setelah di-parse, jadi berbeda antara
    // payload verbatim dan kolom bertipe. Tidak tercakup record_hash.
    for (const u of nilaiDiubah(payload, proy)) {
      diubah.push({ baris: nomor, field: u.field, asal: u.asal, jadi: u.jadi });
    }

    // Tanggal ambigu yang diterjemahkan oleh locale yang diberikan pemanggil.
    for (const a of tanggalAsumsi(payload, fieldOrder, dateOrder)) {
      diasumsikan.push(Object.assign({ baris: nomor }, a));
    }

    const hash = recordHash(payload);

    records.push({
      record_id: recordId,
      version: 1,
      status: 'active',
      supersedes_id: null,
      schema_version: SCHEMA_VERSION,
      institution_id: institutionKey,
      record_hash: hash,
      // Verbatim, bukan hasil normalisasi. `record_hash` dihitung dari
      // `recordHash(payload)` yang menormalkan di dalam dirinya, jadi
      // menormalkan sekali lagi di sini hanya membuat `payload_json` berbeda
      // dari apa yang diterima form dan berbeda dari sumber aslinya.
      payload_json: payload,
      sections: sectionsFor(sectionMap, payload),
      proyeksi: proy,
      kolom: Object.fromEntries(fieldOrder.map((f) => [columnName(f), payload[f]])),
      sumber: { baris: nomor, kunci, nik },
    });
  });

  if (tanggalRusak.length > 0) {
    const contoh = tanggalRusak[0];
    peringatan.push(
      tanggalRusak.length + ' tanggal ada tapi tidak terbaca, kolomnya boleh NULL' +
      ' (contoh: baris ' + contoh.baris + ' ' + contoh.field + '="' + contoh.nilai +
      '"). Nilai aslinya tetap utuh di payload_json.'
    );
  }

  if (diubah.length > 0) {
    const contoh = diubah[0];
    peringatan.push(
      diubah.length + ' nilai bentuknya berubah saat di-parse (contoh: baris ' +
      contoh.baris + ' ' + contoh.field + ': "' + contoh.asal + '" -> "' + contoh.jadi +
      '"). record_hash dihitung dari payload verbatim, jadi nilai hasil parse ini' +
      ' TIDAK tercakup anchor on-chain.'
    );
  }

  return { records, ditolak, duplikat, peringatan, tanggalRusak, diasumsikan, diubah };
}

module.exports = {
  NAMESPACE_BACKFILL,
  WAJIB,
  uuidV5,
  tombol,
  kosong,
  parseAngka,
  parseTanggal,
  isoTanggal,
  kunciKunjungan,
  payloadFromRow,
  proyeksi,
  tanggalTidakPasti,
  tanggalAsumsi,
  nilaiDiubah,
  rencanaBackfill,
  NUMERIC_FIELDS,
  DATE_FIELDS,
};
