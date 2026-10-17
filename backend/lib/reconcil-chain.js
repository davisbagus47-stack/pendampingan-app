'use strict';

/**
 * Jembatan chain untuk rekonsiliasi (F3.5 separuh on-chain, FR-5.8) --
 * pembaca event `DataAnchored`/`RecordSuperseded` dari kontrak `DataAnchor`
 * (F2) dan pembandingnya dengan `chain_outbox`.
 *
 * FR-5.8 menuntut job rekonsiliasi "membandingkan state off-chain dengan event
 * on-chain. Setiap selisih dilaporkan", dan M-3 menuntut selisih nol. Setelah
 * F3.4 benar-benar menulis ke kontrak, separuh yang hilang adalah membaca
 * kembali apa yang TERTULIS di rantai dan mencocokkannya dengan apa yang PUNYA
 * kita. Modul ini melakukan itu.
 *
 * Cara membangun peta rantai (keputusan):
 *
 *   - `DataAnchored(recordId, version, commitment, ...)` menandai satu versi
 *     ter-anchor. `recordId` dan `version` ter-index; `recordId` bertipe string
 *     sehingga yang tersimpan di log hanyalah keccak256(utf8(recordId)), BUKAN
 *     teks aslinya. Karena itu kunci peta memakai HASH record_id, dan baris
 *     off-chain ikut di-hash dengan cara yang sama sebelum dicocokkan -- bukan
 *     dengan membandingkan teks yang tak bisa dipulihkan dari rantai.
 *   - `RecordSuperseded(oldRecordId, oldVersion, newRecordId, newVersion,
 *     newCommitment, ...)` juga menandai (newRecordId, newVersion) ter-anchor;
 *     versi barunya masuk peta dengan commitment barunya. Versi lama sudah
 *     masuk lewat `DataAnchored`-nya sendiri saat pertama kali ditulis.
 *
 * Perbandingan (keputusan) sengaja membedakan empat keadaan, karena "selisih"
 * tanpa jenis tidak bisa ditindaklanjuti:
 *
 *   - `hilangDiRantai`: off-chain MENGKLAIM `anchored` tetapi rantai tidak
 *     punya event-nya. Ini selisih paling serius -- ikatan on/off-chain putus.
 *   - `komitmen`: off-chain dan rantai sama-sama punya (record_id, version),
 *     tetapi commitment-nya BERBEDA. Ini berarti yang dicatat di rantai bukan
 *     yang kita pegang.
 *   - `ekstraDiRantai`: rantai punya event yang TIDAK punya baris outbox --
 *     jejak tulisan di luar jalur outbox (mis. penulisan manual dengan kunci
 *     writer).
 *   - `belumDiRantai` (hitungan, bukan selisih): off-chain belum `anchored`
 *     dan rantai juga belum punya -- keadaan normal antrean yang belum jalan.
 *
 * Modul ini memisahkan bagian MURNI (`dariEvent`, `petaRantai`, `bandingkan`)
 * yang teruji tanpa jaringan, dan bagian jembatan (`buatPembanding`,
 * `buatPembandingDariEnv`) yang berbicara RPC. Pola ini sama dengan
 * `lib/anchor-chain.js`.
 */

const NAMA_ENV = {
  RPC: 'ANCHOR_RPC_URL',
  KONTRAK: 'ANCHOR_CONTRACT',
};

/** Kunci logis rantai: hash record_id + versi, dipisah pemisah yang tak muncul di hex. */
function kunciRantai(hashRecordId, version) {
  return String(hashRecordId).toLowerCase() + '\u0000' + String(version);
}

/**
 * Hash teks menjadi bytes32 (keccak256 utf8), sama dengan yang dipakai kontrak
 * untuk parameter string yang ter-index.
 *
 * @param {string} teks
 * @param {object} [krypto] `{ keccak256, toUtf8Bytes }`; bawaan dari `ethers`
 * @returns {string} bytes32 berawalan 0x, huruf kecil
 */
function hashTeks(teks, krypto) {
  const k = krypto || require('ethers');
  return k.keccak256(k.toUtf8Bytes(String(teks == null ? '' : teks))).toLowerCase();
}

/**
 * Ambil bytes32 dari argumen event, menerima nilai langsung maupun nilai
 * ter-index yang terbungkus (`.hash`). Bentuk selain 32 byte heksadesimal
 * (termasuk string pendek yang bukan hash) dikembalikan null, supaya entri
 * rusak tidak lolos ke peta.
 *
 * @param {*} nilai
 * @returns {string|null}
 */
function bytes32Dari(nilai) {
  if (nilai == null) return null;
  let s = null;
  if (typeof nilai === 'string') s = nilai;
  else if (typeof nilai.hash === 'string') s = nilai.hash;
  if (!s) return null;
  s = s.toLowerCase();
  return /^0x[0-9a-f]{64}$/.test(s) ? s : null;
}

/**
 * Ubah satu log event ethers menjadi entri rantai yang seragam.
 *
 * Menerima bentuk `{ fragment: { name }, args }` (EventLog ethers v6). Untuk
 * argumen string yang ter-index, dipakai `.hash` (keccak), karena teks aslinya
 * memang tidak tersimpan di log.
 *
 * @param {object} log
 * @returns {{hashRecordId: string, version: number, commitment: string, jenis: string}|null}
 */
function dariEvent(log) {
  if (!log || !log.args) return null;
  const nama = (log.fragment && log.fragment.name) || log.event || null;
  const a = log.args;
  if (nama === 'DataAnchored') {
    const h = bytes32Dari(a.recordId);
    const com = bytes32Dari(a.commitment);
    if (!h || !com) return null;
    return { jenis: 'anchor', hashRecordId: h, version: Number(a.version), commitment: com };
  }
  if (nama === 'RecordSuperseded') {
    const h = bytes32Dari(a.newRecordId);
    const com = bytes32Dari(a.newCommitment);
    if (!h || !com) return null;
    return { jenis: 'supersede', hashRecordId: h, version: Number(a.newVersion), commitment: com };
  }
  return null;
}

/**
 * Susun peta rantai dari daftar entri (`dariEvent`).
 *
 * Bila satu kunci muncul lebih dari sekali (seharusnya tidak terjadi karena
 * kontrak menolak pasangan yang sudah tercatat), entri PERTAMA dipertahankan
 * dan sisanya diabaikan -- peta tetap deterministik terhadap urutan blok.
 *
 * @param {object[]} entri
 * @returns {Map<string, string>} kunciRantai -> commitment (0x..., huruf kecil)
 */
function petaRantai(entri) {
  const peta = new Map();
  for (const e of entri || []) {
    if (!e) continue;
    const k = kunciRantai(e.hashRecordId, e.version);
    if (!peta.has(k)) peta.set(k, e.commitment);
  }
  return peta;
}

/**
 * Bandingkan baris `chain_outbox` dengan peta rantai.
 *
 * Murni: tidak menyentuh jaringan maupun database. `hashFn` disuntik agar uji
 * tidak bergantung pada `ethers`.
 *
 * @param {object[]} outbox baris outbox `{record_id, version, commitment, chain_status}`
 * @param {Map<string,string>} peta hasil `petaRantai`
 * @param {function} [hashFn] teks -> bytes32 (bawaan `hashTeks`)
 * @returns {object} laporan perbandingan (lihat komentar modul)
 */
function bandingkan(outbox, peta, hashFn) {
  const hash = hashFn || ((s) => hashTeks(s));
  const baris = outbox || [];
  const dipakai = new Set();
  const hasil = {
    diRantai: peta ? peta.size : 0,
    dicocokkan: 0,
    hilangDiRantai: [],
    komitmen: [],
    ekstraDiRantai: [],
    belumDiRantai: 0,
  };

  for (const o of baris) {
    const k = kunciRantai(hash(o.record_id), o.version);
    const comRantai = peta ? peta.get(k) : undefined;
    const comLokal = normalHex32(o.commitment);
    if (comRantai === undefined) {
      if (o.chain_status === 'anchored') {
        hasil.hilangDiRantai.push({
          record_id: o.record_id, version: Number(o.version),
        });
      } else {
        hasil.belumDiRantai++;
      }
      continue;
    }
    dipakai.add(k);
    if (comRantai !== comLokal) {
      hasil.komitmen.push({
        record_id: o.record_id,
        version: Number(o.version),
        lokal: comLokal,
        rantai: comRantai,
      });
    } else {
      hasil.dicocokkan++;
    }
  }

  if (peta) {
    for (const [k, com] of peta.entries()) {
      if (dipakai.has(k)) continue;
      const pisah = k.split('\u0000');
      hasil.ekstraDiRantai.push({
        hash_record_id: pisah[0],
        version: Number(pisah[1]),
        commitment: com,
      });
    }
  }

  const jumlahSelisih = hasil.hilangDiRantai.length + hasil.komitmen.length +
    hasil.ekstraDiRantai.length;
  return Object.assign(hasil, {
    jumlahSelisih,
    // M-3 nol hanya bila ketiga jenis selisih kosong; `belumDiRantai` bukan
    // selisih, itu antrean yang wajar.
    nihil: jumlahSelisih === 0,
  });
}

/**
 * Normalkan commitment menjadi 0x + 64 digit huruf kecil; nilai tak sah
 * dikembalikan apa adanya (huruf kecil) supaya perbandingan tetap berjalan dan
 * selisihnya terlihat, bukan melempar.
 *
 * @param {string} v
 * @returns {string}
 */
function normalHex32(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (/^0x[0-9a-f]{64}$/.test(s)) return s;
  if (/^[0-9a-f]{64}$/.test(s)) return '0x' + s;
  return s;
}

/**
 * Baca konfigurasi BACA dari variabel lingkungan.
 *
 * Hanya butuh RPC + alamat kontrak; tidak butuh kunci pribadi, karena membaca
 * event adalah operasi publik.
 *
 * @param {object} [env]
 * @returns {{rpcUrl: string, alamat: string}}
 */
function konfigurasi(env) {
  const e = env || process.env;
  return {
    rpcUrl: String(e[NAMA_ENV.RPC] || '').trim(),
    alamat: String(e[NAMA_ENV.KONTRAK] || '').trim(),
  };
}

/**
 * Apakah prasarana BACA rantai cukup (RPC + alamat).
 *
 * @param {object} [env]
 * @returns {boolean}
 */
function tersedia(env) {
  const k = konfigurasi(env);
  return Boolean(k.rpcUrl && k.alamat);
}

/**
 * Rakit `bandingkanRantai(outbox)` dari kontrak ethers yang sudah jadi.
 *
 * @param {object} o
 * @param {object} o.kontrak instance `ethers.Contract` (boleh tanpa signer)
 * @param {number|string} [o.dariBlok] bawaan 0
 * @param {number|string} [o.sampaiBlok] bawaan 'latest'
 * @param {object} [o.krypto] injeksi untuk uji murni
 * @returns {function} async (outbox) => laporan
 */
function buatPembanding(o) {
  const opt = o || {};
  const kontrak = opt.kontrak;
  if (!kontrak) throw new Error('buatPembanding: `kontrak` wajib diisi');
  // Blok boleh datang sebagai string dari env; ethers menuntut angka untuk blok
  // numerik, atau tag seperti 'latest'/'earliest'. Angka-numerik dikonversi,
  // sisanya dibiarkan apa adanya.
  const blok = (nilai, bawaan) => {
    if (nilai === undefined || nilai === null || nilai === '') return bawaan;
    const n = Number(nilai);
    return Number.isFinite(n) ? n : nilai;
  };
  const dariBlok = blok(opt.dariBlok, 0);
  const sampaiBlok = blok(opt.sampaiBlok, 'latest');
  const hashFn = (s) => hashTeks(s, opt.krypto);

  return async function bandingkanRantai(outbox) {
    const [anchorLogs, supersedeLogs] = await Promise.all([
      kontrak.queryFilter(kontrak.filters.DataAnchored(), dariBlok, sampaiBlok),
      kontrak.queryFilter(kontrak.filters.RecordSuperseded(), dariBlok, sampaiBlok),
    ]);
    const entri = []
      .concat(anchorLogs || [])
      .concat(supersedeLogs || [])
      .map(dariEvent)
      .filter(Boolean);
    const peta = petaRantai(entri);
    return Object.assign(
      {
        tersedia: true,
        dariBlok: dariBlok,
        sampaiBlok: sampaiBlok,
        jumlahEvent: entri.length,
      },
      bandingkan(outbox, peta, hashFn)
    );
  };
}

/**
 * Rakit `bandingkanRantai` dari variabel lingkungan.
 *
 * @param {object} [env] bawaan `process.env`
 * @param {object} [deps] `{ provider, kontrak, dariBlok, sampaiBlok, krypto }`
 * @returns {function}
 */
function buatPembandingDariEnv(env, deps) {
  const k = konfigurasi(env);
  if (!tersedia(env)) {
    throw new Error(
      'konfigurasi rantai belum lengkap untuk rekonsiliasi: butuh ' +
      NAMA_ENV.RPC + ' dan ' + NAMA_ENV.KONTRAK
    );
  }
  const d = deps || {};
  let kontrak = d.kontrak;
  if (!kontrak) {
    const { JsonRpcProvider, Contract } = require('ethers');
    const sambungan = d.provider || new JsonRpcProvider(k.rpcUrl);
    // ABI diambil dari anchor-chain supaya daftar fungsi/event hanya ada satu.
    const { ABI } = require('./anchor-chain.js');
    kontrak = new Contract(k.alamat, ABI, sambungan);
  }
  const e = env || process.env;
  return buatPembanding({
    kontrak,
    dariBlok: d.dariBlok !== undefined ? d.dariBlok
      : (e.ANCHOR_FROM_BLOCK !== undefined && e.ANCHOR_FROM_BLOCK !== ''
        ? e.ANCHOR_FROM_BLOCK : 0),
    sampaiBlok: d.sampaiBlok,
    krypto: d.krypto,
  });
}

module.exports = {
  NAMA_ENV,
  kunciRantai,
  hashTeks,
  bytes32Dari,
  dariEvent,
  petaRantai,
  bandingkan,
  normalHex32,
  konfigurasi,
  tersedia,
  buatPembanding,
  buatPembandingDariEnv,
};
