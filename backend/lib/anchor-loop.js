'use strict';

/**
 * Logika loop penjadwalan anchor audit (penjadwalan berkala, lanjutan F4.3).
 *
 * Dipisah dari `tools/worker-audit-anchor.js` supaya keputusan murni (parsing
 * argumen, pemilihan selang, orkestrasi pass) bisa diuji TANPA database, TANPA
 * jaringan, dan TANPA timer sungguhan. Worker-nya sendiri hanya menyuntikkan
 * `sekali()`, `tidur`, dan sumber sinyal berhenti.
 *
 * Loop ini SENGAJA sekuensial: satu pass selesai dulu, baru menunggu selang,
 * baru pass berikutnya. Tidak ada pass yang tumpang tindih, jadi tidak perlu
 * penguncian tambahan -- dan `sekali()` sendiri sudah idempoten per `to_seq`.
 */

/** Selang bawaan antar pass (ms): 1 menit. */
const SELANG_BAWAAN_MS = 60000;

/** Selang terkecil yang diterima (ms): 1 detik, mencegah menghantam DB/RPC. */
const SELANG_MIN_MS = 1000;

/** Teks bantuan CLI. */
function teksBantuan() {
  return [
    'Penggunaan: node tools/worker-audit-anchor.js [--loop] [--interval <detik>]',
    '',
    '  (tanpa argumen)    satu pass lalu keluar',
    '  --loop             ulangi pass tiap <detik> sampai dihentikan',
    '  --interval <detik> selang antar pass saat --loop (minimal 1)',
    '  --off-chain        paksa TANPA transaksi on-chain meski chain terkonfigurasi',
    '  -h, --help         tampilkan bantuan ini',
    '',
    'Selang juga bisa lewat ANCHOR_INTERVAL (detik). Hentikan loop dengan Ctrl+C.',
  ].join('\n');
}

/**
 * Baca argumen CLI.
 *
 * @param {string[]} argv biasanya `process.argv.slice(2)`
 * @returns {{loop:boolean, intervalDetik:(number|null), bantuan:boolean, offChain:boolean, galat:(string|null)}}
 */
function bacaArgv(argv) {
  const a = Array.isArray(argv) ? argv : [];
  const out = { loop: false, intervalDetik: null, bantuan: false, offChain: false, galat: null };
  for (let i = 0; i < a.length; i++) {
    const arg = a[i];
    if (arg === '--loop') { out.loop = true; continue; }
    if (arg === '--off-chain') { out.offChain = true; continue; }
    if (arg === '--help' || arg === '-h') { out.bantuan = true; continue; }
    if (arg === '--interval' || arg === '-i') {
      const v = a[i + 1];
      i++;
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) { out.galat = 'nilai --interval tidak sah: ' + v; return out; }
      out.intervalDetik = n;
      continue;
    }
    if (arg.indexOf('--interval=') === 0) {
      const v = arg.slice('--interval='.length);
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) { out.galat = 'nilai --interval tidak sah: ' + v; return out; }
      out.intervalDetik = n;
      continue;
    }
    // argumen tak dikenal diabaikan (kompatibel ke depan)
  }
  return out;
}

/**
 * Tentukan selang loop dalam ms: argumen CLI menang atas env, lalu dijepit ke
 * minimum. Nilai tak sah diabaikan dan jatuh ke bawaan.
 *
 * @param {(number|null)} intervalDetik
 * @param {object} [env] bawaan `process.env`
 * @returns {number}
 */
function selangMs(intervalDetik, env) {
  const e = env || process.env;
  let ms = SELANG_BAWAAN_MS;
  if (Number.isFinite(intervalDetik) && intervalDetik > 0) {
    ms = intervalDetik * 1000;
  } else if (e && e.ANCHOR_INTERVAL !== undefined && e.ANCHOR_INTERVAL !== '') {
    const n = Number(e.ANCHOR_INTERVAL);
    if (Number.isFinite(n) && n > 0) ms = n * 1000;
  }
  if (!Number.isFinite(ms) || ms < SELANG_MIN_MS) ms = SELANG_MIN_MS;
  return ms;
}

/** Tidur bawaan berbasis setTimeout. */
function bawaanTidur(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Jalankan loop pass. Semua efek samping disuntik agar bisa diuji.
 *
 * @param {object} o
 * @param {function} o.sekaliFn   pass tunggal; boleh melempar
 * @param {number}   [o.selangMs] jeda antar pass (bawaan SELANG_BAWAAN_MS)
 * @param {number}   [o.maksPass] batas pass (bawaan tanpa batas)
 * @param {function} [o.log]      dipanggil tiap pass dengan {pass, hasil, galat}
 * @param {function} [o.tidur]    `(ms) => Promise`
 * @param {function} [o.berhenti] `() => boolean`
 * @returns {Promise<{pass:number, lulus:number, galat:number, terakhir:(object|null)}>}
 */
async function jalankan(o) {
  const opt = o || {};
  if (typeof opt.sekaliFn !== 'function') throw new Error('sekaliFn wajib disuntikkan');
  const tidur = typeof opt.tidur === 'function' ? opt.tidur : bawaanTidur;
  const log = typeof opt.log === 'function' ? opt.log : function () {};
  const berhenti = typeof opt.berhenti === 'function' ? opt.berhenti : function () { return false; };
  const selang = Number.isFinite(opt.selangMs) && opt.selangMs > 0 ? opt.selangMs : SELANG_BAWAAN_MS;
  const maksPass = Number.isFinite(opt.maksPass) && opt.maksPass > 0 ? opt.maksPass : Infinity;

  const ringkas = { pass: 0, lulus: 0, galat: 0, terakhir: null };
  while (ringkas.pass < maksPass && !berhenti()) {
    ringkas.pass++;
    try {
      const hasil = await opt.sekaliFn();
      ringkas.lulus++;
      ringkas.terakhir = hasil;
      log({ pass: ringkas.pass, hasil: hasil, galat: null });
    } catch (e) {
      ringkas.galat++;
      log({ pass: ringkas.pass, hasil: null, galat: e && e.message ? e.message : String(e) });
    }
    if (ringkas.pass >= maksPass || berhenti()) break;
    await tidur(selang);
  }
  return ringkas;
}

module.exports = {
  SELANG_BAWAAN_MS,
  SELANG_MIN_MS,
  bacaArgv,
  selangMs,
  jalankan,
  bawaanTidur,
  teksBantuan,
};
