'use strict';

/**
 * Bekukan test vector F1.10 menjadi `tests/vectors.json`.
 *
 * Jalankan HANYA ketika Algoritma kanonikalisasi sengaja berubah, dan pada saat
 * itu `SCHEMA_VERSION` di `lib/canonical.js` harus dinaikkan lebih dulu.
 *
 *   node tools/lock-vectors.js            -> tulis ulang
 *   node tools/lock-vectors.js --check    -> gagal bila berbeda (default)
 *
 * Perintah `--check` adalah yang dipakai CI, sehingga vektor beku tidak bisa
 * ikut berubah ketika implementasi dirapikan.
 */

const fs = require('fs');
const path = require('path');
const { recordHash, SCHEMA_VERSION } = require(path.join(__dirname, '..', 'lib', 'canonical'));
const CASES = require(path.join(__dirname, '..', 'tests', 'vectors.cases'));

const OUT = path.join(__dirname, '..', 'tests', 'vectors.json');

function build() {
  return {
    _catatan: [
      'record_hash = SHA-256(UTF8(JCS(normalize(payload)))).',
      'Normalisasi: semua nilai jadi string, string di-trim, field numerik jadi satu',
      'representasi, null tetap null, kunci undefined dibuang, NIK/RW/RT tidak pernah',
      'jadi angka.',
      'Jangan edit angka di sini. Naikkan schema_version dulu bila algoritma berubah.',
    ].join('\n'),
    schema_version: SCHEMA_VERSION,
    vectors: CASES.map((c) => ({
      name: c.name,
      payload: c.payload,
      record_hash: recordHash(c.payload),
    })),
  };
}

const next = JSON.stringify(build(), null, 2) + '\n';
const check = process.argv.includes('--check');

let current = null;
try {
  current = fs.readFileSync(OUT, 'utf8');
} catch (e) {
  if (!check) {
    fs.writeFileSync(OUT, next, 'utf8');
    console.log('Dibuat: ' + OUT + ' (' + CASES.length + ' vektor)');
    process.exit(0);
  }
}

if (check) {
  if (current === null) {
    console.error('GAGAL  tests/vectors.json belum ada. Jalankan: node tools/lock-vectors.js');
    process.exit(1);
  }
  if (current !== next) {
    console.error('GAGAL  tests/vectors.json berbeda dari hasil normalizer.');
    console.error('       Algoritma kanonikalisasi berubah tanpa menaikkan schema_version,');
    console.error('       atau vektor beku tidak diperbarui. Keduanya breaking change.');
    process.exit(1);
  }
  console.log('Vektor beku cocok dengan normalizer (' + CASES.length + ' vektor, schema_version ' + SCHEMA_VERSION + ').');
  process.exit(0);
}

fs.writeFileSync(OUT, next, 'utf8');
console.log('Ditulis: ' + OUT + ' (' + CASES.length + ' vektor, schema_version ' + SCHEMA_VERSION + ')');
