'use strict';

/**
 * F4.7 (integrasi) -- jembatan antara `access_log` sungguhan dan sirkuit
 * `no_match.circom`.
 *
 * Sirkuit membuktikan klaim NEGATIF: "tidak ada entri pada jendela yang terikat
 * akar Merkle Poseidon `logRoot` yang cocok dengan tuple publik
 * (kategori, instansi, tanggal)". Modul ini menyiapkan witness dari baris
 * `access_log` nyata, menjalankan prove + verify, dan mengembalikan bukti yang
 * dapat diverifikasi mandiri.
 *
 * Jendela PoC adalah himpunan 4 id yang DIPILIH PEMANGGIL (depth 2 = 4 daun),
 * bukan "seluruh riwayat". Ini keterbatasan yang diakui terbuka: klaim hanya
 * berlaku di dalam jendela yang diikutsertakan.
 *
 * Pemetaan tuple -> bilangan field (deterministik, sama untuk entri dan target):
 *   - kategori       : SHA-256 teks kategori, 31 byte pertama (aman di bawah
 *                      modulus bn128 ~2^254); dikenali sebagai bilangan bila
 *                      kategorinya memang numerik.
 *   - instansi       : `actor_id` (kolom BIGINT) apa adanya; NULL -> 0.
 *   - tanggal        : jumlah hari sejak epoch dari `ts` (integer).
 *
 * PENTING: `logRoot` di sini adalah akar Merkle POSEIDON atas jendela, BUKAN
 * akar anchor SHA-256 milik F4.2/F4.3. Keduanya belum diikat; menyamakannya
 * akan menjadi klaim yang salah. Lihat catatan pada respons endpoint.
 */

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const JUMLAH_ENTRI = 4; // depth 2 pada `no_match.circom`
const MS_PER_HARI = 86400000;

const JALUR_CLI = path.join(__dirname, '..', 'zkp', 'src', 'cli.js');
const JALUR_MERKLE = path.join(__dirname, '..', 'zkp', 'src', 'merkle-poseidon.js');

let modulCli = null;
let modulMerkle = null;

/** Muat modul ZKP secara lazy (snarkjs/circomlibjs mahal untuk startup server). */
function muatZkp() {
  if (!modulCli) modulCli = require(JALUR_CLI);
  if (!modulMerkle) modulMerkle = require(JALUR_MERKLE);
  return { cli: modulCli, mp: modulMerkle };
}

/** Apakah artefak `no_match` (wasm + zkey) tersedia untuk membuktikan. */
function tersedia() {
  try {
    const { cli } = muatZkp();
    return fs.existsSync(cli.jalurWasm('no_match')) && fs.existsSync(cli.jalurZkey('no_match'));
  } catch (e) {
    return false;
  }
}

/** Kategori teks -> bilangan field (31 byte pertama SHA-256). */
function hashKategori(teks) {
  const sha = crypto.createHash('sha256').update(String(teks), 'utf8').digest();
  return BigInt('0x' + sha.subarray(0, 31).toString('hex'));
}

/** Petakan kategori: bilangan apa adanya, selain itu hash. */
function petakanKategori(teks) {
  const s = String(teks).trim();
  if (/^-?\d+$/.test(s)) return BigInt(s);
  return hashKategori(s);
}

/** Petakan tanggal: bilangan hari apa adanya, selain itu parse tanggal -> hari. */
function petakanTanggal(nilai) {
  const s = String(nilai).trim();
  if (/^-?\d+$/.test(s)) return BigInt(s);
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new Error('tanggal tidak valid: ' + s);
  return BigInt(Math.floor(t / MS_PER_HARI));
}

/** Tanggal hari-dari-epoch untuk sebuah TIMESTAMPTZ. */
function hariDariTs(ts) {
  const t = ts instanceof Date ? ts.getTime() : Date.parse(ts);
  if (Number.isNaN(t)) throw new Error('ts tidak valid: ' + ts);
  return BigInt(Math.floor(t / MS_PER_HARI));
}

/** Petakan satu baris access_log -> tuple [kategori, instansi, tanggal]. */
function tupleDariBaris(row) {
  const kategori = petakanKategori(row.category);
  const instansi = row.actor_id === null || row.actor_id === undefined ? 0n : BigInt(row.actor_id);
  return [kategori, instansi, hariDariTs(row.ts)];
}

/** Petakan tuple target dari parameter permintaan -> [BigInt, BigInt, BigInt]. */
function tupleDariTarget({ kategori, instansi, tanggal }) {
  if (kategori === undefined || kategori === null || String(kategori).trim() === '') {
    throw new Error('parameter category wajib diisi');
  }
  if (tanggal === undefined || tanggal === null || String(tanggal).trim() === '') {
    throw new Error('parameter date wajib diisi');
  }
  const inst = instansi === undefined || instansi === null || String(instansi).trim() === ''
    ? 0n : BigInt(String(instansi).trim());
  return [petakanKategori(kategori), inst, petakanTanggal(tanggal)];
}

// snarkjs memakai satu instance wasm; pembuktian paralel tidak aman. Serialkan.
let antre = Promise.resolve();
function antipan(fn) {
  const berikut = antre.then(fn, fn);
  antre = berikut.then(() => {}, () => {});
  return berikut;
}

/**
 * Buktikan klaim negatif atas jendela baris access_log.
 *
 * @param {object} opsi
 * @param {Array<object>} opsi.baris   tepat 4 baris {id, ts, category, actor_id}
 * @param {object}        opsi.target  {kategori, instansi, tanggal}
 * @returns {Promise<object>} hasil { terbukti, ... } atau { terbukti:false, alasan }
 */
async function buktiKlaimNegatif({ baris, target }) {
  if (!tersedia()) throw new Error('artefak ZKP no_match belum ada (jalankan: node zkp/src/cli.js setup)');
  if (!Array.isArray(baris) || baris.length !== JUMLAH_ENTRI) {
    throw new Error('jendela harus tepat ' + JUMLAH_ENTRI + ' baris access_log');
  }
  const { cli, mp } = muatZkp();

  const tuples = baris.map(tupleDariBaris);
  const targetTuple = tupleDariTarget(target);

  // Deteksi kecocokan di JS lebih dulu: bila ada, klaim negatif PASTI palsu dan
  // witness tidak akan pernah bisa dipenuhi (`acc[n] === 0`), jadi tidak perlu
  // membakar waktu prove untuk mengetahuinya.
  const cocok = [];
  for (let i = 0; i < tuples.length; i++) {
    if (tuples[i][0] === targetTuple[0] && tuples[i][1] === targetTuple[1] && tuples[i][2] === targetTuple[2]) {
      cocok.push(Number(baris[i].id));
    }
  }
  if (cocok.length) {
    return {
      terbukti: false,
      alasan: 'Ada entri di jendela yang cocok dengan tuple target; klaim negatif tidak dapat dibuktikan.',
      cocok,
    };
  }

  const daun = [];
  for (const t of tuples) daun.push(await mp.daunDari(t.map((x) => x.toString())));
  const pohon = await mp.pohonPoseidon(daun);
  const jalur = [];
  for (let i = 0; i < tuples.length; i++) jalur.push(await mp.buktiInklusi(pohon, i));

  const input = {
    cat: tuples.map((t) => t[0].toString()),
    inst: tuples.map((t) => t[1].toString()),
    date: tuples.map((t) => t[2].toString()),
    path: jalur.map((b) => b.path),
    sel: jalur.map((b) => b.sel),
    logRoot: pohon.root,
    targetCat: targetTuple[0].toString(),
    targetInst: targetTuple[1].toString(),
    targetDate: targetTuple[2].toString(),
  };

  return antipan(async () => {
    const p = await cli.buktikan('no_match', input);
    const v = await cli.verifikasi('no_match', p.proof, p.publicSignals);
    return {
      terbukti: true,
      log_root: pohon.root,
      target: {
        category: target.kategori,
        institution: target.instansi === undefined || target.instansi === null ? null : String(target.instansi),
        date: target.tanggal,
        cat: targetTuple[0].toString(),
        inst: targetTuple[1].toString(),
        date_int: targetTuple[2].toString(),
      },
      window: {
        count: tuples.length,
        ids: baris.map((r) => Number(r.id)),
        entries: tuples.map((t, i) => ({
          id: Number(baris[i].id),
          cat: t[0].toString(),
          inst: t[1].toString(),
          date_int: t[2].toString(),
        })),
      },
      proof: p.proof,
      public_signals: p.publicSignals,
      verified_by_server: v.ok,
      prove_ms: Math.round(p.ms),
      verify_ms: Math.round(v.ms),
      proof_bytes: Buffer.byteLength(JSON.stringify(p.proof)),
    };
  });
}

module.exports = {
  JUMLAH_ENTRI,
  tersedia,
  buktiKlaimNegatif,
  petakanKategori,
  petakanTanggal,
  tupleDariBaris,
  tupleDariTarget,
};
