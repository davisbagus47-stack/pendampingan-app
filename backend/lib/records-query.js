'use strict';

/**
 * Query API `GET /api/v1/records` (FR-4.1..FR-4.8) -- deliverable utama.
 *
 * Modul ini memisahkan dua hal yang sengaja tidak dicampur:
 *
 *   1. **Bentuk permintaan** -- parsing parameter, kodekursor, dan validasi
 *      nilai. Murni, tanpa database. Semuanya bisa diuji tanpa koneksi.
 *   2. **Keputusan otorisasi yang TIDAK bisa ditegakkan RLS** -- FR-4.6
 *      mensyaratkan penolakan EKSPLISIT (`CATEGORY_NOT_GRANTED`,
 *      `DESA_NOT_GRANTED`), sedangkan RLS hanya bisa memfilter baris sehingga
 *      permintaan yang tidak berhak menghasilkan hasil kosong. Dua hal itu
 *      berbeda: data yang hilang diam-diam tidak bisa dibedakan dari data yang
 *      memang tidak ada. Karena itu permintaan diperiksa terhadap daftar
 *      kategori dan wilayah instansi SEBELUM query dijalankan, di samping RLS
 *      yang tetap menjadi penegak sebenarnya (FR-4.2: penapisan di lapisan
 *      database, bukan aplikasi).
 *
 * Yang TIDAK ada di sini: akses database. Route di index.js yang membaca
 * `agency_categories`, `agency_desa_scope`, dan `denied_columns()`, lalu
 * menyerahkan hasilnya ke `validasiHibah()` di modul ini.
 *
 * Taksonomi dua tingkat datang dari ADR-5, bukan desain baru:
 *   kategori_1 in { Catin, Ibu Hamil, Ibu Nifas, Baduta }  (tipe sasaran)
 *   kategori_2 in { A..I }                                  (section form)
 */

const { selectList } = require('./column-grants');
const canonical = require('./canonical');

/** Kategori_1 yang sah (ADR-5). Sama dengan CHECK `records.jenis_sasaran`. */
const KATEGORI_1 = Object.freeze(['Catin', 'Ibu Hamil', 'Ibu Nifas', 'Baduta']);

/** Kategori_2 yang sah: section A..I (ADR-5). */
const KATEGORI_2 = Object.freeze(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I']);

/** Batas halaman. Default 100; 1000 jauh di atas kebutuhan PoC. */
const LIMIT_DEFAULT = 100;
const LIMIT_MAKS = 1000;

/** Label kolom metadata yang selalu mendampingi setiap baris (FR-4.3). */
const META_HEADER = Object.freeze(['record_id', 'version', 'commitment']);

/**
 * Galat dengan kode mesin-baca. Bentuknya sama dengan galat `lib/column-grants.js`
 * (`code` + `status`) supaya `kirimGalat` di index.js bisa memperlakukannya sama.
 */
function galatQuery(code, message, status) {
  const e = new Error(message);
  e.code = code;
  e.status = status || 400;
  return e;
}

/** Ambil satu nilai string dari query string; array dan kosong jadi null. */
function satu(v) {
  if (v === undefined || v === null) return null;
  const s = String(Array.isArray(v) ? v[0] : v).trim();
  return s === '' ? null : s;
}

const TANGGAL_ISO = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse dan validasi seluruh parameter FR-4.1.
 *
 * Kesalahan nilai DITOLAK, bukan diabaikan. Mengabaikan `limit=abc` berarti
 * permintaan yang salah bentuk diam-diam dijawab dengan halaman bawaan --
 * klien akan mengira batasnya dipatuhi.
 *
 * @param {object} query `req.query`
 * @returns {{kategori_1:string|null, kategori_2:string|null, desa:string|null,
 *   tanggal_mulai:string|null, tanggal_selesai:string|null, limit:number,
 *   cursor:object|null, cursorMentah:string|null}}
 * @throws {Error} `code` INVALID_PARAM / INVALID_CURSOR
 */
function parseQuery(query) {
  const q = query || {};

  const kategori_1 = satu(q.kategori_1);
  const kategori_2Raw = satu(q.kategori_2);
  const desa = satu(q.desa);
  const tanggal_mulai = satu(q.tanggal_mulai);
  const tanggal_selesai = satu(q.tanggal_selesai);
  const limitMentah = satu(q.limit);
  const cursorMentah = satu(q.cursor);

  if (kategori_1 !== null && !KATEGORI_1.includes(kategori_1)) {
    // Nilai di luar taksonomi ADR-5. Bukan CATEGORY_NOT_GRANTED: itu untuk
    // kategori yang SAH tapi tidak dihibahkan. Ini nilai yang tidak pernah ada.
    throw galatQuery(
      'INVALID_PARAM',
      'kategori_1 tidak dikenal: ' + kategori_1 + '. Pilihan: ' + KATEGORI_1.join(', ')
    );
  }

  let kategori_2 = null;
  if (kategori_2Raw !== null) {
    const huruf = kategori_2Raw.toUpperCase();
    if (!KATEGORI_2.includes(huruf)) {
      throw galatQuery(
        'INVALID_PARAM',
        'kategori_2 tidak dikenal: ' + kategori_2Raw + '. Pilihan: ' + KATEGORI_2.join(', ')
      );
    }
    kategori_2 = huruf;
  }

  for (const [nama, nilai] of [['tanggal_mulai', tanggal_mulai], ['tanggal_selesai', tanggal_selesai]]) {
    if (nilai !== null && !TANGGAL_ISO.test(nilai)) {
      throw galatQuery('INVALID_PARAM', nama + ' harus format YYYY-MM-DD, bukan ' + nilai);
    }
  }
  if (tanggal_mulai !== null && tanggal_selesai !== null && tanggal_mulai > tanggal_selesai) {
    throw galatQuery('INVALID_PARAM', 'tanggal_mulai tidak boleh setelah tanggal_selesai');
  }

  let limit = LIMIT_DEFAULT;
  if (limitMentah !== null) {
    if (!/^\d+$/.test(limitMentah)) {
      throw galatQuery('INVALID_PARAM', 'limit harus bilangan bulat positif, bukan ' + limitMentah);
    }
    limit = Number(limitMentah);
    if (limit < 1) {
      throw galatQuery('INVALID_PARAM', 'limit minimal 1');
    }
    // Dipotong, bukan ditolak: permintaan yang meminta lebih dari batas tetap
    // mendapat data, hanya lebih sedikit. Menolaknya berarti klien tidak bisa
    // menarik apa pun hanya karena angkanya terlalu besar.
    if (limit > LIMIT_MAKS) limit = LIMIT_MAKS;
  }

  const cursor = cursorMentah === null ? null : decodeCursor(cursorMentah);

  return {
    kategori_1,
    kategori_2,
    desa,
    tanggal_mulai,
    tanggal_selesai,
    limit,
    cursor,
    cursorMentah,
  };
}

/**
 * Kodekursor (FR-4.7).
 *
 * Kursor adalah kunci keyset `(created_at, id)` yang di-encode opaque. Klien
 * tidak boleh menafsirkan isinya: mengunci bentuknya membuat perubahan urutan
 * atau indeks di masa depan tidak memutus kursor yang masih beredar.
 *
 * `id` (BIGSERIAL) dipakai sebagai pemecah seri karena `created_at` bisa sama
 * dalam satu transaksi. Tanpa pemecah, dua baris dengan waktu identik bisa
 * terlewat atau terulang di batas halaman.
 */
function encodeCursor(row) {
  const isi = JSON.stringify({ c: new Date(row.created_at).toISOString(), i: String(row.id) });
  return Buffer.from(isi, 'utf8').toString('base64url');
}

/**
 * Baca kursor. Bentuk yang tidak dikenali DITOLAK, bukan diabaikan: kursor
 * yang rusak kalau diabaikan akan diam-diam mengembalikan halaman pertama,
 * dan klien yang memaginasi akan mengulang data tanpa sadar.
 *
 * @returns {{created_at:Date, id:string}}
 * @throws {Error} `code` INVALID_CURSOR
 */
function decodeCursor(teks) {
  let obj;
  try {
    obj = JSON.parse(Buffer.from(String(teks), 'base64url').toString('utf8'));
  } catch (e) {
    throw galatQuery('INVALID_CURSOR', 'cursor bukan kodek yang sah');
  }
  if (!obj || typeof obj !== 'object' || typeof obj.c !== 'string' || typeof obj.i !== 'string') {
    throw galatQuery('INVALID_CURSOR', 'cursor tidak memuat kunci halaman');
  }
  const t = new Date(obj.c);
  if (Number.isNaN(t.getTime())) {
    throw galatQuery('INVALID_CURSOR', 'cursor memuat waktu yang tidak sah');
  }
  if (!/^\d+$/.test(obj.i)) {
    throw galatQuery('INVALID_CURSOR', 'cursor memuat id yang tidak sah');
  }
  return { created_at: t, id: obj.i };
}

/**
 * Penolakan eksplisit FR-4.6 yang tidak bisa dilakukan RLS.
 *
 * RLS memfilter BARIS; ia tidak bisa membedakan "instansi tidak berhak atas
 * kategori ini" dari "memang tidak ada data". FR-4.18 memilih penolakan
 * eksplisit, dan itulah yang dikerjakan di sini.
 *
 * @param {object} q hasil `parseQuery`
 * @param {object} hibah `{ categories: string[], scope: {nama_desa:string}[] }`
 *   `categories` = `agency_categories` instansi pemanggil.
 *   `scope` = `agency_desa_scope`; KOSONG berarti seluruh wilayah (FR-4.17).
 * @throws {Error} CATEGORY_NOT_GRANTED / DESA_NOT_GRANTED (status 403)
 */
function validasiHibah(q, hibah) {
  const h = hibah || {};
  const categories = Array.isArray(h.categories) ? h.categories : [];
  const scope = Array.isArray(h.scope) ? h.scope : [];

  if (q.kategori_1 !== null && !categories.includes(q.kategori_1)) {
    throw galatQuery(
      'CATEGORY_NOT_GRANTED',
      'Kategori "' + q.kategori_1 + '" tidak dihibahkan ke instansi ini (FR-4.2).',
      403
    );
  }

  if (q.desa !== null && scope.length > 0) {
    const boleh = scope.some((s) => s && s.nama_desa === q.desa);
    if (!boleh) {
      throw galatQuery(
        'DESA_NOT_GRANTED',
        'Desa "' + q.desa + '" di luar wilayah instansi ini (FR-4.18).',
        403
      );
    }
  }
}

/**
 * Rencana SQL untuk satu halaman (FR-4.20c: proyeksi kolom eksplisit).
 *
 * `id` dan `created_at` DITAMBAHKAN di luar `selectList()` karena keduanya
 * bukan kolom payload maupun metadata OUTPUT -- ia diperlukan untuk kursor.
 * Nilainya tidak pernah keluar: `metaFor()` dan `filterRow()` hanya memilih
 * kunci yang memang milik respons.
 *
 * Kunci urutan `created_at DESC, id DESC`: data BARU punya `created_at` lebih
 * besar, jadi ia muncul di halaman pertama dan tidak menggeser halaman kedua
 * dan seterusnya. Itulah "stabil terhadap penambahan data baru" FR-4.7 --
 * kebalikan urutan (ASC) akan menyisipkan baris baru ke halaman terakhir yang
 * belum tentu sudah dibaca.
 *
 * @param {object} o `{ q, fieldOrder, denied, fields }`
 * @returns {{sql:string, params:any[]}}
 */
function rencanaKueri(o) {
  const q = o.q;
  const params = [];
  const where = [];

  const dorong = (nilai) => {
    params.push(nilai);
    return '$' + params.length;
  };

  if (q.kategori_1 !== null) where.push('jenis_sasaran = ' + dorong(q.kategori_1));
  if (q.kategori_2 !== null) where.push('sections && ' + dorong([q.kategori_2]) + '::text[]');
  if (q.desa !== null) where.push('nama_desa = ' + dorong(q.desa));
  if (q.tanggal_mulai !== null) where.push('tanggal_kunjungan >= ' + dorong(q.tanggal_mulai) + '::date');
  if (q.tanggal_selesai !== null) where.push('tanggal_kunjungan <= ' + dorong(q.tanggal_selesai) + '::date');

  if (q.cursor) {
    const t = dorong(q.cursor.created_at.toISOString());
    const i = dorong(q.cursor.id);
    // Perbandingan baris PostgreSQL: `(a, b) < (c, d)` adalah urutan leksikografis.
    where.push('(created_at, id) < (' + t + '::timestamptz, ' + i + '::bigint)');
  }

  const kolom = selectList(o.fieldOrder, o.denied, o.fields) + ', id, created_at';
  // `limit + 1` supaya keberadaan halaman berikutnya diketahui tanpa query
  // hitung terpisah. Kelebihannya dibuang setelah dibaca.
  const limit = dorong(q.limit + 1);

  const sql =
    'SELECT ' + kolom + ' FROM records' +
    (where.length > 0 ? ' WHERE ' + where.join(' AND ') : '') +
    ' ORDER BY created_at DESC, id DESC' +
    ' LIMIT ' + limit;

  return { sql, params };
}

/**
 * Metadata yang selalu mendampingi satu baris (FR-4.3).
 *
 * `commitment` dihitung untuk INSTANSI PEMILIK record (koreksi 1.2), bukan
 * pemanggil. `institution_id` dan `record_hash` ikut dikembalikan karena
 * commitment tidak dapat diverifikasi tanpa keduanya -- penerima perlu
 * menghitung ulang `SHA256(record_hash || institution_id)` dan membandingkannya
 * dengan yang tercatat. Itu sebabnya `META_COLUMNS` di column-grants sengaja
 * memuat kedua kolom tersebut.
 */
function metaFor(row) {
  return {
    record_id: row.record_id,
    version: Number(row.version),
    record_hash: row.record_hash,
    institution_id: row.institution_id,
    sections: row.sections || [],
    commitment: canonical.commitment(row.record_hash, row.institution_id),
  };
}

/** Nilai kolom metadata untuk CSV/XLSX, urut sesuai `META_HEADER`. */
function metaRow(row) {
  const m = metaFor(row);
  return META_HEADER.map((k) => (m[k] === undefined || m[k] === null ? '' : String(m[k])));
}

module.exports = {
  KATEGORI_1,
  KATEGORI_2,
  LIMIT_DEFAULT,
  LIMIT_MAKS,
  META_HEADER,
  galatQuery,
  parseQuery,
  encodeCursor,
  decodeCursor,
  validasiHibah,
  rencanaKueri,
  metaFor,
  metaRow,
};
