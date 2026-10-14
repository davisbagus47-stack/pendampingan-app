'use strict';

/**
 * JCS -- JSON Canonicalization Scheme, RFC 8785.
 *
 * Implementasi mandiri, tanpa pustaka luar. Alasan:
 *
 *  1. Pustaka rujukan (`canonicalize`, `jcs`) seluruhnya ESM-only, sedangkan
 *     backend ini CommonJS. Memakai dynamic import() akan membuat
 *     `recordHash()` asynchronous, padahal dipanggil di jalur tulis yang sinkron.
 *  2. `record_hash` ada di jalur integritas. Eachatan yang dapat dieksekusi
 *     dari satu dependensi adalah risiko. JCS hanya ~60 baris.
 *  3. Klaim proyecto adalah "verifikasi bisa dilakukan instansi mana pun, bahasa
 *     apa pun, tanpa pustaka kami". Menuliskan JCS sendiri justru odour yang
 *     konsisten dengan klaim itu.
 *
 * Yang dijamin: `tools/test-canonical.js` menjalankanvektor resmi RFC 8785
 * Appendix B. Bila implementasi ini menyimpang, vektor itu gagal.
 */

/** Bandingkan dua kunci menurut urutan code unit UTF-16, seperti disyaratkan RFC 8785. */
function compareCodeUnits(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Serialisasi string sesuai RFC 8785.
 *
 * `JSON.stringify` sudah persis sesuai: ia hanya meng-escape `"` `\` dan
 * karakter kontrol (< 0x20) memakai `\b \f \n \r \t` atau `\u00xx`, serta
 * meninggalkan karakter lain apa adanya sebagai UTF-8. Tidak ada escaping
 * non-ASCII, tidak ada escaping `/`.
 *
 * Yang perlu dijaga adalah surrogate tunggal. RFC 8785 menyatakan input tidak
 * valid bila mengandung unpaired surrogate, jadi implementation harus menolak,
 * bukan diam-diam meng-escape-nya.
 */
function serializeString(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) {
        throw new TypeError('JCS: unpaired high surrogate pada indeks ' + i);
      }
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      throw new TypeError('JCS: unpaired low surrogate pada indeks ' + i);
    }
  }
  return JSON.stringify(s);
}

/**
 * Serialisasi angka.
 *
 * RFC 8785 menunjuk `Number::toString` dari ECMAScript, yang persis sama dengan
 * `JSON.stringify` untuk angka: bentuk terpendek yang bisa dibalik. Tidak ada
 *representasi "cantik" -- `1.0` menjadi `1`, `1e2` menjadi `100`.
 */
function serializeNumber(n) {
  if (!Number.isFinite(n)) {
    throw new TypeError('JCS: angka harus finite, diterima ' + String(n));
  }
  // -0 diserialisasi "0" oleh JSON.stringify, sesuai Number::toString.
  return JSON.stringify(n);
}

/** Serialisasi nilai apa pun menjadi teks kanonik RFC 8785. */
function canonicalize(value) {
  if (value === null) return 'null';

  const t = typeof value;
  if (t === 'boolean') return value ? 'true' : 'false';
  if (t === 'number') return serializeNumber(value);
  if (t === 'string') return serializeString(value);

  if (Array.isArray(value)) {
    // RFC 8785: elemen undefined pada array menjadi null, dan kunci undefined
    // pada object dihapus. Beda perlakuan ini sering|source kesalahan.
    return '[' + value.map((v) => (v === undefined ? 'null' : canonicalize(v))).join(',') + ']';
  }

  if (t === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined);
    keys.sort(compareCodeUnits);
    return '{' + keys.map((k) => serializeString(k) + ':' + canonicalize(value[k])).join(',') + '}';
  }

  throw new TypeError('JCS: tipe tidak didukung: ' + t);
}

/** Byte UTF-8 dari teks kanonik. */
function canonicalBytes(value) {
  return Buffer.from(canonicalize(value), 'utf8');
}

module.exports = { canonicalize, canonicalBytes, compareCodeUnits };
