'use strict';

/**
 * Pemeriksaan teks untuk seluruh kode dan dokumen riset.
 *
 * Hanya satu aturan, tapi aturan yang berulang kali dilanggar tanpa disadari:
 * file proyek ini ditulis dalam bahasa Indonesia dengan istilah teknis Inggris.
 * Huruf CJK, hiragana/katakana, hangul, dan Aksara Cyrillik atau Yunani tidak
 * punya tempat di sini -- tidak satu pun dokumen memakai salah satunya sebagai
 * istilah. Ketika muncul, itu hampir selalu artefak mengetik di tengah kata,
 * dan dampaknya nyata, bukan sekadar soal estetika. Komentar yang salah baca
 * berarti keputusan yang tercatat salah dibaca orang lain.
 *
 * Alat ini tidak memeriksa kebenaran kode. Ia hanya menandai tempat yang
 * membuat keputusan tercatat salah dibaca.
 *
 * Cakupan cirinya sengaja sempit. Funkasi yang bergantung pada simbol
 * non-Latin yang sah seperti penanda bagian atau derajat akan lolos, karena
 * tujuannya menangkap sisipan acak, bukan memusnahkan daftar karakter yang diizinkan.
 */

const fs = require('fs');
const path = require('path');

const SKIP_DIR = new Set(['node_modules', '.git', 'build', 'coverage', '__pycache__']);
const CODE_EXT = /\.(js|py|sql|json)$/;

// Rentang huruf di bawah tidak pernah dipakai sebagai istilah dalam bahasa
// Indonesia, maupun sebagai istilah teknis Inggris yang muncul di proyek ini.
//
//   Hiragana/Katakana  3040-30FF
//   CJK               4E00-9FFF
//   Hangul            AC00-D7AF
//   Yunani            0370-03FF
//   Cyrillik          0400-04FF
//
// Aksara Cyrillik dan Yunani ditambahkan karena keduanya sudah terbukti muncul
// sebagai artefak mengetik, dan tidak satu pun file yang sah memakainya.
// Menambahkannya tidak menimbulkan false positive.
const HURUF_ASING = /[\u0370-\u03FF\u0400-\u04FF\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF]/;

const DOKUMEN = [
  'ancaman-dan-keputusan-arsitektur.md',
  'keputusan-kanonikalisasi.md',
  'rencana-kerja-poc.md',
  'keputusan-skema-postgres.md',
  'keputusan-lingkup-uji.md',
  'keputusan-judul.md',
  'keputusan-testnet.md',
  'keputusan-zkp-spike.md',
  'kerangka-bab3-metodologi.md',
  'prd-decentralized-data-gateway-v1.1.md',
  'spesifikasi-api.md',
];

const DOKUMEN_DIR = 'C:/Users/davis/Downloads/PENELITIAN';

function kumpulkan(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIR.has(e.name)) kumpulkan(path.join(dir, e.name), out);
    } else if (CODE_EXT.test(e.name)) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

function main() {
  const files = kumpulkan(process.cwd(), []);

  const dokumenAda = [];
  for (const d of DOKUMEN) {
    const p = path.join(DOKUMEN_DIR, d);
    if (fs.existsSync(p)) dokumenAda.push(p);
  }

  const target = files.concat(dokumenAda);
  const temuan = [];

  for (const f of target) {
    let isi;
    try {
      isi = fs.readFileSync(f, 'utf8');
    } catch (e) {
      continue;
    }
    isi.split(/\r?\n/).forEach((baris, i) => {
      if (HURUF_ASING.test(baris)) {
        temuan.push({ file: f, line: i + 1, text: baris.trim() });
      }
    });
  }

  console.log('file diperiksa : ' + target.length +
    '  (' + files.length + ' kode, ' + dokumenAda.length + ' dokumen)');

  if (temuan.length === 0) {
    console.log('hasil           : bersih');
    return 0;
  }

  console.log('hasil           : ' + temuan.length + ' baris mengandung huruf non-Latin');
  for (const t of temuan) {
    console.log('');
    console.log('  ' + t.file + ':' + t.line);
    console.log('    ' + t.text);
  }
  console.log('');
  console.log('Perbaiki setiap baris di atas secara manual. Jangan ganti dengan');
  console.log('pengganti otomatis: baris itu perlu dibaca ulang, bukan ditambal.');
  return 1;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = { kumpulkan, main };
