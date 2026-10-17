'use strict';

/**
 * Anchor worker log audit (F4.3 / FR-8.1) + pencatatan akar on-chain (FR-7.4).
 *
 * Ringkas: baca SELURUH `access_log` (urut `id`), rangkai rantai hash (F4.1),
 * bangun pohon Merkle (F4.2), lalu simpan satu baris `audit_anchor`
 * `[1, n]` berisi akar + `head_hash`. Bukti inklusi (endpoint F4.3) nanti
 * dipotong ke batch ini supaya akarnya sama dengan yang tersimpan -- baik akar
 * itu hanya tersimpan off-chain maupun sudah dicatat on-chain.
 *
 * Dua tahap, dan mengapa dipisah
 * ------------------------------
 *   1. `rencanakan()` -- transaksi database: hitung akar, putuskan perlu baris
 *      baru atau tidak, dan kembalikan baris yang perlu dicatat on-chain.
 *   2. Panggilan rantai (bila `kirimAkar` tersedia) DI LUAR transaksi database,
 *      lalu `catatTx()` menulis `tx_hash` kembali. Panggilan RPC bisa lambat;
 *      menahannya di dalam transaksi terbuka mengunci tabel lebih lama dari
 *      perlu.
 *
 * Kapan `tx_hash` terisi (FR-7.4)
 * -------------------------------
 * Akar dicatat on-chain lewat `DataAnchor.anchorAuditRoot(toSeq, root, headHash)`
 * dengan kunci `kirimAkar` yang DISUNTIKKAN. Bila tidak disuntikkan (bawaan),
 * pass ini hanya off-chain dan `tx_hash` tetap NULL -- itu dilaporkan jujur,
 * bukan disembunyikan. CLI (`node tools/worker-audit-anchor.js`) yang mengisi
 * rantai secara otomatis bila `ANCHOR_RPC_URL`/`ANCHOR_CONTRACT`/
 * `ANCHOR_PRIVATE_KEY` lengkap.
 *
 * Idempoten: kalau anchor terakhir sudah menutupi seluruh log dengan akar yang
 * sama DAN `tx_hash`-nya sudah terisi, tidak ada baris baru dan tidak ada
 * transaksi baru. Bila baris itu ada tetapi `tx_hash` masih NULL (mis. dibuat
 * sebelum kontrak tersedia), pass ini hanya MENCOBA mencatatnya on-chain dan
 * mengisi `tx_hash` -- tidak menggandakan baris. Kontrak sendiri idempoten per
 * `toSeq` (akar sama boleh diulang, akar berbeda ditolak), jadi percobaan ulang
 * aman.
 *
 * Keterbatasan yang harus ditulis jujur: selama `tx_hash` NULL, akar hanya
 * tersimpan di database yang SAMA dengan log, jadi belum tahan penyusup yang
 * mengubah keduanya sekaligus. Baru setelah akar benar-benar on-chain, "tidak
 * diubah" berlaku relatif terhadap pihak ketiga, bukan hanya terhadap operator.
 *
 * Penjadwalan berkala
 * -------------------
 * CLI mendukung `--loop [--interval <detik>]` untuk menjalankan pass ini
 * berulang (bawaan 60 detik, minimal 1 detik; `ANCHOR_INTERVAL` juga dibaca).
 * Loop sekuensial: tidak ada pass yang tumpang tindih, dan karena `sekali()`
 * idempoten, pass tanpa perubahan hanya melaporkan "dilewati". Logika loop
 * murni ada di `lib/anchor-loop.js` dan diuji tanpa database/jaringan.
 *
 * `--off-chain` memaksa TANPA transaksi on-chain meski `ANCHOR_*` lengkap --
 * penanda aman untuk uji asap. Argumen ini tidak bisa ditimpa dotenv, berbeda
 * dari mengosongkan variabel lingkungan.
 */

require('dotenv').config();

const path = require('path');

const db = require(path.join(__dirname, '..', 'lib', 'db.js'));
const auditLogChain = require(path.join(__dirname, '..', 'lib', 'audit-log-chain.js'));
const anchorChain = require(path.join(__dirname, '..', 'lib', 'anchor-chain.js'));
const anchorLoop = require(path.join(__dirname, '..', 'lib', 'anchor-loop.js'));

const SQL_BACA = 'SELECT id, ts, actor_type, actor_id, category, params, result,' +
  ' response_rows, endpoint FROM access_log ORDER BY id ASC';

const SQL_TERAKHIR = 'SELECT id, from_seq, to_seq, leaf_count, root, head_hash, algorithm, tx_hash, anchored_at' +
  ' FROM audit_anchor ORDER BY to_seq DESC, id DESC LIMIT 1';

/**
 * Pilih pengirim akar: penanda chain sungguhan bila konfigurasi lengkap,
 * selain itu `null` (pas off-chain saja).
 *
 * @param {object} [env] bawaan `process.env`
 * @returns {function|null}
 */
function pilihPengirim(env) {
  const e = env || process.env;
  if (anchorChain.tersedia(e)) return anchorChain.buatPengirimAkarDariEnv(e);
  return null;
}

/**
 * Fase database: hitung akar, putuskan perlu baris baru, dan tandai apakah
 * baris hasil masih perlu dicatat on-chain (`perluRantai`).
 *
 * @returns {Promise<{dilewati:boolean, alasan:string, jumlah_entri:number, anchor:object|null, perluRantai:boolean}>}
 */
async function rencanakan() {
  return db.transaksi({ role: 'operator' }, async (client) => {
    const rows = (await client.query(SQL_BACA)).rows;

    if (rows.length === 0) {
      return { dilewati: true, alasan: 'log kosong', jumlah_entri: 0, anchor: null, perluRantai: false };
    }

    const akar = auditLogChain.akarDariBaris(rows);
    const n = rows.length;

    const terakhir = (await client.query(SQL_TERAKHIR)).rows[0] || null;

    if (terakhir && Number(terakhir.to_seq) === n && terakhir.root === akar.root) {
      return {
        dilewati: true,
        alasan: 'sudah ter-anchor dengan akar yang sama',
        jumlah_entri: n,
        anchor: terakhir,
        perluRantai: terakhir.tx_hash === null || terakhir.tx_hash === undefined,
      };
    }

    const ins = await client.query(
      'INSERT INTO audit_anchor (from_seq, to_seq, leaf_count, root, head_hash, algorithm, tx_hash, anchored_at)' +
      ' VALUES (1, $1, $2, $3, $4, $5, NULL, now())' +
      ' RETURNING id, from_seq, to_seq, leaf_count, root, head_hash, algorithm, tx_hash, anchored_at',
      [n, akar.leaf_count, akar.root, akar.head_hash, akar.algorithm]
    );

    return { dilewati: false, alasan: null, jumlah_entri: n, anchor: ins.rows[0], perluRantai: true };
  });
}

/**
 * Tulis `tx_hash` ke baris anchor, dijaga `tx_hash IS NULL` supaya dua pekerja
 * bersamaan tidak saling menimpa dan pengulangan tidak mengubah yang sudah ada.
 *
 * @param {number|string} id `audit_anchor.id`
 * @param {string} txHash
 * @returns {Promise<number>} jumlah baris yang diperbarui
 */
async function catatTx(id, txHash) {
  return db.transaksi({ role: 'operator' }, async (client) => {
    const res = await client.query(
      'UPDATE audit_anchor SET tx_hash = $1 WHERE id = $2 AND tx_hash IS NULL',
      [txHash, id]
    );
    return res.rowCount;
  });
}

/**
 * Satu pass anchoring.
 *
 * @param {object} [o]
 * @param {function} [o.kirimAkar] sunikan panggilan chain; bila TIDAK diberi,
 *   pass ini off-chain saja (aman untuk pemanggil lama/uji).
 * @param {object} [o.env] dipakai saat `o.kirimAkar` tidak diberi (bawaan
 *   `process.env`) -- hanya dipakai CLI agar tidak ada transaksi tak sengaja.
 * @returns {Promise<object>} ringkasan pass
 */
async function sekali(o) {
  const opt = o || {};
  const rencana = await rencanakan();

  const hasil = {
    dilewati: rencana.dilewati,
    alasan: rencana.alasan,
    jumlah_entri: rencana.jumlah_entri,
    anchor: rencana.anchor,
    rantai: {
      tersedia: false,
      tx_hash: rencana.anchor ? rencana.anchor.tx_hash : null,
      error: null,
    },
  };

  if (!rencana.anchor || !rencana.perluRantai) return hasil;

  // `o.kirimAkar === undefined` -> jangan mengira-ngira: tanpa sunikan eksplisit
  // kita TIDAK menyentuh jaringan (mencegah transaksi tak sengaja dari kode
  // yang mengimpor modul ini). CLI-lah yang menyuntikkan pengirim dari env.
  const kirimAkar = opt.kirimAkar;
  if (typeof kirimAkar !== 'function') {
    hasil.rantai.catatan = 'pengirim rantai tidak disuntikkan; anchor off-chain saja (tx_hash NULL)';
    return hasil;
  }

  hasil.rantai.tersedia = true;

  let jawab;
  try {
    jawab = await kirimAkar({
      to_seq: Number(rencana.anchor.to_seq),
      root: rencana.anchor.root,
      head_hash: rencana.anchor.head_hash,
    });
  } catch (e) {
    jawab = { ok: false, error: e && e.message ? e.message : String(e) };
  }

  if (jawab && jawab.ok && jawab.tx_hash) {
    await catatTx(rencana.anchor.id, jawab.tx_hash);
    hasil.anchor = Object.assign({}, rencana.anchor, { tx_hash: jawab.tx_hash });
    hasil.rantai.tx_hash = jawab.tx_hash;
  } else {
    hasil.rantai.error = (jawab && jawab.error) || 'anchor on-chain gagal tanpa pesan';
  }

  return hasil;
}

/** Cetak ringkasan satu pass (format lama, dipertahankan). */
function laporPass(ringkasan) {
  if (ringkasan.dilewati) console.log('dilewati : ' + ringkasan.alasan);
  console.log('entri    : ' + ringkasan.jumlah_entri);
  if (ringkasan.anchor) {
    console.log('akar     : ' + ringkasan.anchor.root);
    console.log('head     : ' + ringkasan.anchor.head_hash);
    console.log('anchor id: ' + ringkasan.anchor.id);
    console.log('tx_hash  : ' + (ringkasan.anchor.tx_hash || '(NULL -- off-chain)'));
  }
  if (ringkasan.rantai.error) console.log('galat    : ' + ringkasan.rantai.error);
  else if (ringkasan.rantai.catatan) console.log('rantai   : ' + ringkasan.rantai.catatan);
}

/** Ringkas satu pass jadi satu baris untuk mode loop. */
function ringkasSatuBaris(hasil) {
  if (!hasil) return ' (tanpa hasil)';
  if (hasil.dilewati) return ' dilewati (' + hasil.alasan + '), entri ' + hasil.jumlah_entri;
  const tx = hasil.anchor && hasil.anchor.tx_hash ? hasil.anchor.tx_hash : '(off-chain)';
  let s = ' entri ' + hasil.jumlah_entri + ', anchor#' + (hasil.anchor ? hasil.anchor.id : '?') + ', tx ' + tx;
  if (hasil.rantai && hasil.rantai.error) s += ', galat rantai: ' + hasil.rantai.error;
  return s;
}

/** Jalankan CLI: pass tunggal (bawaan) atau loop berkala (`--loop`). */
async function main() {
  const argv = anchorLoop.bacaArgv(process.argv.slice(2));
  if (argv.galat) {
    console.error(argv.galat);
    console.error(anchorLoop.teksBantuan());
    process.exitCode = 1;
    return;
  }
  if (argv.bantuan) { console.log(anchorLoop.teksBantuan()); return; }

  const konf = anchorChain.konfigurasi(process.env);
  if (argv.offChain) {
    console.log('chain    : dipaksa mati (--off-chain); tidak ada transaksi on-chain');
  } else {
    console.log('chain    : ' + (anchorChain.tersedia(process.env)
      ? konf.alamat + ' @ ' + konf.rpcUrl
      : 'belum dikonfigurasi (anchor off-chain saja)'));
  }

  if (!db.urlDatabase()) {
    console.error('galat    : DATABASE_URL belum diset -- worker anchor butuh database.');
    process.exitCode = 1;
    return;
  }

  // `--off-chain` mengalahkan konfigurasi env: penanda jelas supaya uji asap
  // tidak pernah menyiarkan transaksi tak sengaja (dotenv tidak bisa
  // menimpanya karena ini argumen, bukan variabel lingkungan).
  const kirimAkar = argv.offChain ? null : pilihPengirim(process.env);

  if (!argv.loop) {
    laporPass(await sekali({ kirimAkar: kirimAkar }));
    return;
  }

  const selang = anchorLoop.selangMs(argv.intervalDetik, process.env);
  let berhenti = false;
  const tandaiBerhenti = () => {
    if (berhenti) return;
    berhenti = true;
    console.log('sinyal berhenti diterima; menuntaskan pass berjalan lalu keluar...');
  };
  process.on('SIGINT', tandaiBerhenti);
  process.on('SIGTERM', tandaiBerhenti);

  console.log('loop     : tiap ' + Math.round(selang / 1000) + ' detik (Ctrl+C untuk berhenti)');
  const ringkas = await anchorLoop.jalankan({
    sekaliFn: () => sekali({ kirimAkar: kirimAkar }),
    selangMs: selang,
    berhenti: () => berhenti,
    log: ({ pass, hasil, galat }) => {
      if (galat) { console.log('pass ' + pass + ' galat: ' + galat); return; }
      console.log('pass ' + pass + ' :' + ringkasSatuBaris(hasil));
    },
  });
  console.log('loop selesai: ' + ringkas.pass + ' pass, ' + ringkas.lulus + ' lulus, ' + ringkas.galat + ' galat');
}

if (require.main === module) {
  (async () => {
    try {
      await main();
    } catch (e) {
      console.error('anchor log audit gagal: ' + (e && e.message ? e.message : e));
      process.exitCode = 1;
    } finally {
      await db.matikan();
    }
  })();
}

module.exports = { sekali, rencanakan, catatTx, pilihPengirim, SQL_BACA, SQL_TERAKHIR };
