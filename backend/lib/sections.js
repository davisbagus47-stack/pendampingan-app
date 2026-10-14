'use strict';

/**
 * Penurunan section A..I dari file form.
 *
 * Ada di sini, bukan di dalam generator, karena backfill juga butuh aturan yang
 * sama persis. Kalau duplikasinya, `records.sections` yang ditulis backfill bisa
 * berbeda dari `field_catalog.sections` yang dihasilkan generator -- dan
 * perbedaannya tidak akan muncul sebagai galat, hanya sebagai filter yang
 * jadi salah hasil (FR-4.2).
 *
 * Aturan asalnya FR-2.4: daftar kolom "berasal dari form yang ada", bukan
 * ditulis tangan. Kalau form berubah, daftar ini ikut berubah secara otomatis.
 */

const fs = require('fs');
const path = require('path');

const FORM_PATH = path.join(
  __dirname, '..', '..', 'frontend', 'src', 'pages', 'FormPendampingan.jsx'
);

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

/**
 * @returns {{map: Object<string, Set<string>>, titles: Object<string, string>, markCount: number}}
 */
function deriveSections(formPath = FORM_PATH) {
  if (!fs.existsSync(formPath)) {
    throw new Error('Form tidak ditemukan: ' + formPath);
  }
  const src = fs.readFileSync(formPath, 'utf8');

  // Semua judul kartu harus berupa section A..I. Kalau ada yang tidak cocok,
  // batasnya hilang dan field di dalamnya masuk ke section sebelumnya -- skema
  // menjadi salah tanpa pelaporan error. Karena itu setiap judul diperiksa,
  // bukan hanya yang cocok pola.
  const semuaJudul = [...src.matchAll(/<h2 className="card-title">([^<]*)<\/h2>/g)]
    .map((h) => h[1].trim());
  const salah = semuaJudul.filter((t) => !/^[A-I]\.\s*\S/.test(t));
  if ( salah.length > 0) {
    throw new Error(
      'Judul section di form tidak dikenal sebagai A..I: ' + JSON.stringify(salah) +
      ' -- perbaiki penanda section agar generator tidak salah memetakan kolom.'
    );
  }

  const re = /<h2 className="card-title">\s*([A-I])\.\s*([^<]*)<\/h2>/g;
  const marks = [];
  let m;
  while ((m = re.exec(src)) !== null) {
    marks.push({ section: m[1], title: decodeEntities(m[2]).trim(), index: m.index });
  }
  if (marks.length === 0) {
    throw new Error('Tidak ada penanda section A..I di form. Form berubah bentuk?');
  }

  const titles = {};
  const map = {};
  for (let i = 0; i < marks.length; i++) {
    const from = marks[i].index;
    const to = i + 1 < marks.length ? marks[i + 1].index : src.length;
    const key = marks[i].section;
    if (!titles[key]) titles[key] = marks[i].title;
    const slice = src.slice(from, to);
    for (const n of slice.matchAll(/\bname="([A-Za-z][A-Za-z0-9]*)"/g)) {
      if (!map[n[1]]) map[n[1]] = new Set();
      map[n[1]].add(key);
    }
  }

  return { map, titles, markCount: marks.length };
}

/**
 * Section yang terisi pada satu payload.
 *
 * Dipakai untuk mengisi `records.sections`. Field dengan nilai kosong tidak
 * dihitung: section dianggap terisi kalau ada isinya, bukan cuma ada kolomnya.
 * Kalau tidak, satu record Baduta akan selalu punya section F dan G karena
 * formulirnya punya kolom itu, padahal isinya kosong.
 *
 * @param {Object<string, Set<string>>} map
 * @param {Object<string, unknown>} payload
 * @returns {string[]} huruf section, urut, tanpa duplikat
 */
function sectionsFor(map, payload) {
  const hasil = new Set();
  for (const [field, nilai] of Object.entries(payload || {})) {
    if (nilai === null || nilai === undefined) continue;
    if (typeof nilai === 'string' && nilai.trim() === '') continue;
    const sections = map[field];
    if (!sections) continue;
    for (const s of sections) hasil.add(s);
  }
  return [...hasil].sort();
}

module.exports = { deriveSections, sectionsFor, decodeEntities, FORM_PATH };
