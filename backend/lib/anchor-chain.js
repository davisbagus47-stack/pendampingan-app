'use strict';

/**
 * Jembatan chain (F3.4 lanjutan) -- titik suntik `tandai(baris)` yang
 * sesungguhnya menyentuh smart contract `DataAnchor` (F2).
 *
 * Modul ini memisahkan:
 *   - pengkodean/penormaan argumen (murni, teruji tanpa jaringan), dan
 *   - pemanggilan RPC (di-suntik lewat `kontrak` yang sudah jadi, atau
 *     dirakit dari variabel lingkungan oleh `buatPenandaDariEnv`).
 *
 * Kontrak `tandai` yang dihasilkan:
 *   { ok: true, tx_hash }                    anchor diterima (receipt sudah tergali)
 *   { ok: true, tx_hash, belum_konfirmasi }  transaksi disiarkan, receipt belum ada
 *   { ok: false, error }                     anchor ditolak/gagal (pesan sudah diringkas)
 *
 * Pemetaan on-chain:
 *   - `commitment` outbox adalah SHA-256 heksadesimal 32 byte (64 digit,
 *     TANPA awalan 0x) dari `canonical.commitment` -- dinormalkan ke bytes32.
 *   - `categoryHash` = keccak256(utf8(jenis_sasaran)). Itu kategori yang
 *     diikat on-chain (F2.3). Bila kategori tak diketahui, diikat sebagai
 *     keccak256("") supaya pemanggilan tetap deterministik.
 *   - Baris koreksi (`supersedes_id` terisi) memakai `supersede(...)`: leluhur
 *     (record_id + version baris lama) diresolusi lewat callback `leluhur`.
 *     Bila callback tidak ada, jatuh ke `anchor(...)` biasa.
 *
 * Modul ini juga menjadi jembatan anchoring AKAR LOG AUDIT (FR-7.4):
 * `buatPengirimAkar`/`buatPengirimAkarDariEnv` memanggil
 * `DataAnchor.anchorAuditRoot(toSeq, root, headHash)` untuk mencatat akar pohon
 * Merkle log akses on-chain, supaya `audit_anchor.tx_hash` akhirnya terisi.
 *
 * Modul ini TIDAK memakai `dotenv` dan TIDAK membuka koneksi database; itu
 * urusan `tools/worker-anchor.js` yang menyuntikkan resolver kategori/leluhur.
 */

const ABI = [
  'function anchor(string recordId, uint256 version, bytes32 commitment, bytes32 categoryHash)',
  'function supersede(string oldRecordId, uint256 oldVersion, string newRecordId, uint256 newVersion, bytes32 newCommitment, bytes32 newCategoryHash)',
  'function isAnchored(string recordId, uint256 version) view returns (bool)',
  'function WRITER_ROLE() view returns (bytes32)',
  'event DataAnchored(string indexed recordId, uint256 indexed version, bytes32 indexed commitment, bytes32 categoryHash, address writer, uint256 blockNumber)',
  'event RecordSuperseded(string indexed oldRecordId, uint256 indexed oldVersion, string indexed newRecordId, uint256 newVersion, bytes32 newCommitment, bytes32 newCategoryHash, address writer, uint256 blockNumber)',
  // Akar log audit (FR-7.4).
  'function anchorAuditRoot(uint256 toSeq, bytes32 root, bytes32 headHash)',
  'function isAuditRootAnchored(uint256 toSeq, bytes32 root) view returns (bool)',
  'event AuditRootAnchored(uint256 indexed toSeq, bytes32 indexed root, bytes32 headHash, address writer, uint256 blockNumber)',
  // Custom error OZ v5 (diwarisi DataAnchor lewat AccessControl). Tanpa entri
  // ini, ethers hanya bisa melaporkan "execution reverted" generik saat peran
  // ditolak.
  'error AccessControlUnauthorizedAccount(address account, bytes32 neededRole)',
];

const NAMA_ENV = {
  RPC: 'ANCHOR_RPC_URL',
  KONTRAK: 'ANCHOR_CONTRACT',
  KUNCI: 'ANCHOR_PRIVATE_KEY',
};

/**
 * Normalkan commitment menjadi bytes32 berawalan 0x (huruf kecil).
 *
 * Menerima 64 digit heksadesimal dengan atau tanpa awalan 0x. Bentuk lain
 * ditolak: meng-anchor commitment yang salah panjang berarti ikatan on/off-
 * chain tidak bisa diverifikasi (FR-4.3), jadi lebih baik gagal terang-terangan.
 *
 * @param {string} v
 * @returns {string} 0x + 64 digit huruf kecil
 */
function normHex32(v) {
  const s = String(v == null ? '' : v).trim();
  if (/^0x[0-9a-fA-F]{64}$/.test(s)) return s.toLowerCase();
  if (/^[0-9a-fA-F]{64}$/.test(s)) return '0x' + s.toLowerCase();
  throw new Error('commitment bukan 32 byte heksadesimal: ' + s.slice(0, 24));
}

/**
 * Hitung categoryHash dari teks jenis sasaran.
 *
 * @param {string} jenis
 * @param {object} [krypto] `{ keccak256, toUtf8Bytes }`; bawaan dari `ethers`
 * @returns {string} bytes32 berawalan 0x
 */
function hashKategori(jenis, krypto) {
  const k = krypto || require('ethers');
  return k.keccak256(k.toUtf8Bytes(String(jenis == null ? '' : jenis)));
}

/**
 * Ringkas galat ethers/js menjadi pesan pendek yang berguna di `last_error`.
 *
 * @param {*} e
 * @returns {string}
 */
function pesanGalat(e) {
  if (!e) return 'anchor gagal tanpa pesan';
  if (typeof e === 'string') return e;
  // Custom error yang berhasil di-decode ethers (mis. AccessControlUnauthorizedAccount).
  if (e.revert && e.revert.name) {
    const args = Array.isArray(e.revert.args) && e.revert.args.length
      ? '(' + e.revert.args.join(', ') + ')' : '';
    return 'execution reverted: ' + e.revert.name + args;
  }
  if (e.shortMessage) return String(e.shortMessage);
  if (e.reason) return String(e.reason);
  if (e.info && e.info.error && e.info.error.message) return String(e.info.error.message);
  if (e.message) return String(e.message);
  return String(e);
}

/**
 * Rakit `tandai(baris)` dari kontrak ethers yang sudah jadi.
 *
 * @param {object} o
 * @param {object} o.kontrak instance `ethers.Contract` bertanda tangan (signer)
 * @param {function} [o.kategori] async (baris) => string jenis sasaran
 * @param {function} [o.leluhur] async (baris) => {record_id, version} | null
 * @param {object} [o.krypto] injeksi `{ keccak256, toUtf8Bytes }` untuk uji murni
 * @returns {function} async (baris) => {ok, tx_hash|error}
 */
function buatPenanda(o) {
  const opt = o || {};
  const kontrak = opt.kontrak;
  if (!kontrak) throw new Error('buatPenanda: `kontrak` wajib diisi');
  const kategori = typeof opt.kategori === 'function' ? opt.kategori : (() => null);
  const leluhur = typeof opt.leluhur === 'function' ? opt.leluhur : null;
  // Pra-simulasi (staticCall) sebelum kirim: (a) men-decode custom error OZ
  // yang tidak terbaca lewat estimasi gas, (b) gagal-cepat tanpa membakar gas,
  // (c) tidak menyisakan jarak nonce saat tx yang pasti revert. Bisa dimatikan
  // untuk runner yang tak menyediakan `staticCall`.
  const praSimulasi = opt.praSimulasi !== false;
  // Mode KILAT (hybrid): siarkan transaksi lalu balikkan `tx_hash` TANPA
  // menunggu receipt. Finalisasi (menandai `anchored`) diserahkan ke worker/cron
  // yang memeriksa receipt lewat jalur `tx_hash` di `tandai` bawah ini.
  const kilat = opt.kilat === true;

  async function kirim(nama, args) {
    const fn = kontrak[nama];
    if (typeof fn !== 'function') throw new Error('kontrak tidak punya fungsi ' + nama);
    if (praSimulasi && typeof fn.staticCall === 'function') {
      await fn.staticCall(...args);
    }
    const tx = await fn(...args);
    if (kilat) return { hash: tx.hash, belum: true };
    const receipt = await tx.wait();
    return { hash: (receipt && receipt.hash) || tx.hash, belum: false };
  }

  // Ambil provider dari kontrak (runner bisa berupa Signer BERTA provider, atau
  // Provider langsung) untuk memeriksa receipt transaksi yang sudah disiarkan.
  function providerDari() {
    const runner = kontrak.runner;
    if (runner && typeof runner.getTransactionReceipt === 'function') return runner;
    if (runner && runner.provider) return runner.provider;
    return kontrak.provider || null;
  }

  async function cekReceipt(hash) {
    const provider = providerDari();
    if (!provider) return { ketemu: false };
    const rc = await provider.getTransactionReceipt(hash);
    if (!rc) return { ketemu: false };
    return { ketemu: true, sukses: Number(rc.status) === 1 };
  }

  return async function tandai(baris) {
    const b = baris || {};
    try {
      // Jalur finalisasi hybrid: baris yang SUDAH disiarkan (tx_hash terisi)
      // tidak dikirim ulang -- cukup periksa receipt-nya.
      if (b.tx_hash) {
        const hash = String(b.tx_hash);
        const ck = await cekReceipt(hash);
        if (!ck.ketemu) return { ok: true, tx_hash: hash, belum_konfirmasi: true };
        if (ck.sukses) return { ok: true, tx_hash: hash };
        return { ok: false, error: 'transaksi on-chain revert: ' + hash };
      }

      const com = normHex32(b.commitment);
      const jenis = await kategori(b);
      const catHash = hashKategori(jenis, opt.krypto);
      const version = Number(b.version);

      let hasil;
      if (b.supersedes_id && leluhur) {
        const tua = await leluhur(b);
        if (!tua || tua.record_id == null || tua.version == null) {
          throw new Error('leluhur tidak ditemukan untuk supersedes_id=' + b.supersedes_id);
        }
        hasil = await kirim('supersede', [
          String(tua.record_id), Number(tua.version),
          String(b.record_id), version, com, catHash,
        ]);
      } else {
        hasil = await kirim('anchor', [String(b.record_id), version, com, catHash]);
      }

      if (!hasil || !hasil.hash) return { ok: false, error: 'transaksi tanpa hash' };
      const out = { ok: true, tx_hash: hasil.hash };
      if (hasil.belum) out.belum_konfirmasi = true;
      return out;
    } catch (e) {
      return { ok: false, error: pesanGalat(e) };
    }
  };
}

/**
 * Baca konfigurasi chain dari variabel lingkungan.
 *
 * @param {object} [env] bawaan `process.env`
 * @returns {{rpcUrl: string, alamat: string, kunci: string}}
 */
function konfigurasi(env) {
  const e = env || process.env;
  return {
    rpcUrl: String(e[NAMA_ENV.RPC] || '').trim(),
    alamat: String(e[NAMA_ENV.KONTRAK] || '').trim(),
    kunci: String(e[NAMA_ENV.KUNCI] || '').trim(),
  };
}

/**
 * Apakah prasarana chain cukup lengkap untuk membuat penanda sungguhan.
 *
 * @param {object} [env]
 * @returns {boolean}
 */
function tersedia(env) {
  const k = konfigurasi(env);
  return Boolean(k.rpcUrl && k.alamat && k.kunci);
}

/**
 * Rakit `tandai` sungguhan dari variabel lingkungan.
 *
 * @param {object} [env]
 * @param {object} [deps] `{ provider, kontrak, kategori, leluhur, krypto }`
 * @returns {function}
 */
function buatPenandaDariEnv(env, deps) {
  const k = konfigurasi(env);
  if (!tersedia(env)) {
    throw new Error(
      'konfigurasi chain belum lengkap: butuh ' +
      NAMA_ENV.RPC + ', ' + NAMA_ENV.KONTRAK + ', ' + NAMA_ENV.KUNCI
    );
  }
  const d = deps || {};
  let kontrak = d.kontrak;
  if (!kontrak) {
    const { JsonRpcProvider, Wallet, Contract } = require('ethers');
    const provider = d.provider || new JsonRpcProvider(k.rpcUrl);
    const wallet = new Wallet(k.kunci, provider);
    kontrak = new Contract(k.alamat, ABI, wallet);
  }
  return buatPenanda({
    kontrak,
    kategori: d.kategori,
    leluhur: d.leluhur,
    krypto: d.krypto,
    praSimulasi: d.praSimulasi,
    kilat: d.kilat,
  });
}

/**
 * Rakit `kirimAkar` sungguhan dari variabel lingkungan (FR-7.4).
 *
 * @param {object} [env]
 * @param {object} [deps] `{ provider, kontrak, praSimulasi }`
 * @returns {function}
 */
function buatPengirimAkarDariEnv(env, deps) {
  if (!tersedia(env)) {
    throw new Error(
      'konfigurasi chain belum lengkap: butuh ' +
      NAMA_ENV.RPC + ', ' + NAMA_ENV.KONTRAK + ', ' + NAMA_ENV.KUNCI
    );
  }
  const k = konfigurasi(env);
  const d = deps || {};
  let kontrak = d.kontrak;
  if (!kontrak) {
    const { JsonRpcProvider, Wallet, Contract } = require('ethers');
    const provider = d.provider || new JsonRpcProvider(k.rpcUrl);
    const wallet = new Wallet(k.kunci, provider);
    kontrak = new Contract(k.alamat, ABI, wallet);
  }
  return buatPengirimAkar({ kontrak, praSimulasi: d.praSimulasi });
}

/**
 * Rakit `kirimAkar(anchor)` dari kontrak ethers yang sudah jadi -- titik suntik
 * untuk mencatat akar log audit on-chain (FR-7.4).
 *
 * Berbeda dari `tandai` (record: record_id + version + commitment + kategori),
 * akar audit punya bentuk sendiri: posisi batch (`to_seq`), akar pohon Merkle
 * (`root`), dan `head_hash` entri terakhir (penjaga pemotongan ekor). Kontrak
 * `DataAnchor.anchorAuditRoot` menolak toSeq 0, akar nol, dan akar BERBEDA
 * untuk toSeq yang sama (akar berbeda = log berubah).
 *
 * `anchor` yang diterima adalah baris `audit_anchor` (snake_case) atau bentuk
 * ringkas `{ to_seq, root, head_hash }`. Kontrak jawaban SAMA dengan `tandai`:
 * `{ ok: true, tx_hash }` atau `{ ok: false, error }` (galat sudah diringkas).
 *
 * @param {object} o
 * @param {object} o.kontrak instance `ethers.Contract` bertanda tangan (signer)
 * @param {boolean} [o.praSimulasi] simulasi sebelum kirim (bawaan true)
 * @returns {function} async (anchor) => {ok, tx_hash|error}
 */
function buatPengirimAkar(o) {
  const opt = o || {};
  const kontrak = opt.kontrak;
  if (!kontrak) throw new Error('buatPengirimAkar: `kontrak` wajib diisi');
  const praSimulasi = opt.praSimulasi !== false;

  return async function kirimAkar(anchor) {
    const a = anchor || {};
    try {
      const toSeq = Number(a.to_seq);
      if (!Number.isInteger(toSeq) || toSeq <= 0) {
        throw new Error('to_seq tidak valid: ' + a.to_seq);
      }
      const root = normHex32(a.root);
      const head = normHex32(a.head_hash);

      const fn = kontrak.anchorAuditRoot;
      if (typeof fn !== 'function') throw new Error('kontrak tidak punya fungsi anchorAuditRoot');
      if (praSimulasi && typeof fn.staticCall === 'function') {
        await fn.staticCall(toSeq, root, head);
      }
      const tx = await fn(toSeq, root, head);
      const receipt = await tx.wait();
      const hash = (receipt && receipt.hash) || tx.hash;
      if (!hash) return { ok: false, error: 'transaksi tanpa hash' };
      return { ok: true, tx_hash: hash };
    } catch (e) {
      return { ok: false, error: pesanGalat(e) };
    }
  };
}

module.exports = {
  ABI,
  NAMA_ENV,
  normHex32,
  hashKategori,
  pesanGalat,
  buatPenanda,
  konfigurasi,
  tersedia,
  buatPenandaDariEnv,
  buatPengirimAkar,
  buatPengirimAkarDariEnv,
};
