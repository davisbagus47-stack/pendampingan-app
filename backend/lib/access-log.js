/**
 * Log akses append-only (FR-4.4, AT-14, F1.5).
 *
 * FR-4.4: "Setiap pemanggilan, berhasil maupun gagal, dicatat dalam log akses
 * yang sama dengan log pencatatan." Kata kuncinya *setiap*. Jadi yang diuji di
 * sini bukan hanya "permintaan sukses tercatat", melainkan bahwa tidak ada
 * jalur keluar dari aplikasi yang bisa melewati pencatatan -- termasuk jalur
 * galat, jalur penolakan kolom, jalur kuota habis, dan jalur yang tidak
 * diharapkan sama sekali.
 *
 * Bentuk entri dikunci ke tabel `access_log` di `sql/001_schema.sql`:
 * `result` hanya boleh salah satu dari delapan nilai pada CHECK constraint, dan
 * kolom yang tidak ada di tabel berarti tidak bisa diisi. Karena itu nama kolom
 * di sini sama persis dengan nama kolomnya, bukan hasil terjemahan; kesamaan itu
 * wajib dijaga
 * -- kalau tidak, penulisan ke database akan gagal justru pada kode `result`
 * yang paling penting: `denied_desa`.
 *
 * Kenapa `result` dijaga ketat sekali
 * ----------------------------------
 * Kolom `result` adalah satu-satunya bagian log yang menyebut *kenapa* akses
 * ditolak, dan `denied_desa` vs `denied_category` vs `denied_column` adalah tiga
 * klaim keamanan yang berbeda. Kalau kode baru ditulis di sini dan tidak ada di
 * CHECK constraint, penulisan gagal -- atau, lebih buruk, orang menambahkan
 * nilai ke CHECK supaya errornya hilang. Fungsi `hasilDari` memetakan kode
 * galat ke delapan nilai itu dan menolak nilai lain, jadi menambah kode galat
 * baru memaksa keputusan di sini, bukan diam-diam.
 *
 * Batas ukuran entri
 * ------------------
 * `params` bisa berisi `fields` dari klien yang tidak dipercaya. Tanpa batas,
 * satu permintaan dengan 50.000 nama kolom akan menulis baris log raksasa --
 * dan itu justru cara termurah untuk membuat `access_log` tidak berguna atau
 * tidak affordable. Karena itu setiap nilai dipangkas. Memangkas lebih baik
 * daripada kehilangan baris: baris yang kepotong tetap membuktikan bahwa
 * permintaan itu terjadi, sedangkan baris yang hilang tidak membuktikan apa pun.
 *
 * Kegagalan menulis tidak boleh menggagalkan permintaan
 * ------------------------------------------------------
 * `catat` sengaja tidak melempar galat. Log akses yang bisa menjatuhkan API
 * adalah vektor penolakan layanan yang dibuat sendiri: siapa pun yang bisa membuat
 * `sink` gagal bisa membuat seluruh Query API tidak bisa dipakai. Jadi
 * kegagalan ditangkap, dihitung di `logger.gagal`, dan dicetak ke stderr.
 * Trade-off-nya dicatat di rencana kerja: pada jalur ini, entri bisa hilang
 * kalau proses mati persis saat menuliskannya. Menghilangkan baris lebih mudah
 * daripada menjatuhkan layanan, tapi kalau suatu hari ini tidak lagi dapat
 * diterima, jawabannya antrean durable -- bukan melempar galat.
 */

const HASIL = Object.freeze({
  SUKSES: 'success',
  DENIED_CATEGORY: 'denied_category',
  DENIED_DESA: 'denied_desa',
  DENIED_COLUMN: 'denied_column',
  DENIED_AUTH: 'denied_auth',
  RATE_LIMITED: 'rate_limited',
  INVALID_FORMAT: 'invalid_format',
  ERROR: 'error',
});

/** Delapan nilai yang diizinkan CHECK constraint `access_log.result`. */
const HASIL_IZIN = Object.freeze([
  HASIL.SUKSES, HASIL.DENIED_CATEGORY, HASIL.DENIED_DESA, HASIL.DENIED_COLUMN,
  HASIL.DENIED_AUTH, HASIL.RATE_LIMITED, HASIL.INVALID_FORMAT, HASIL.ERROR,
]);

/** Nilai `category` ketika permintaan tidak memfilter kategori apa pun. */
const KATEGORI_SEMUA = 'all';

/** Batas ukuran nilai di `params`. */
const MAKS_NILAI = 200;
const MAKS_DAFTAR = 40;

/**
 * Kode galat aplikasi -> nilai `result`.
 *
 * Dipetakan lewat kode, bukan lewat status HTTP, karena beberapa kode berbagi
 * status yang sama. `FIELD_NOT_GRANTED` dan `DESA_NOT_GRANTED` sama-sama 403,
 * dan membukanya jadi `error` akan menghapus satu-satunya bukti mana
 * pembatasan yang bekerja.
 */
const PETA_KODE = Object.freeze({
  CATEGORY_NOT_GRANTED: HASIL.DENIED_CATEGORY,
  DESA_NOT_GRANTED: HASIL.DENIED_DESA,
  FIELD_NOT_GRANTED: HASIL.DENIED_COLUMN,
  RATE_LIMITED: HASIL.RATE_LIMITED,
  INVALID_FORMAT: HASIL.INVALID_FORMAT,
  UNAUTHORIZED: HASIL.DENIED_AUTH,
  FORBIDDEN: HASIL.DENIED_AUTH,
  INVALID_TOKEN: HASIL.DENIED_AUTH,
  TOKEN_EXPIRED: HASIL.DENIED_AUTH,
  API_KEY_INVALID: HASIL.DENIED_AUTH,
  // F3.2 (jalur tulis). Penolakan kewenangan menulis -> denied_auth; sisanya
  // (validasi, record/versi/hash) bukan masalah identitas, jadi error.
  AGENCY_UNKNOWN: HASIL.DENIED_AUTH,
  AGENCY_INACTIVE: HASIL.DENIED_AUTH,
  RECORD_NOT_PERMITTED: HASIL.DENIED_AUTH,
  VALIDATION_FAILED: HASIL.ERROR,
  JENIS_UNKNOWN: HASIL.ERROR,
  RECORD_NOT_FOUND: HASIL.ERROR,
  VERSION_CONFLICT: HASIL.ERROR,
  DUPLICATE_HASH: HASIL.ERROR,
});

/** Batas panjang tiap nilai; nilai lebih dipangkas dan ditandai. */
function pangkas(v) {
  const s = typeof v === 'string' ? v : String(v);
  if (s.length <= MAKS_NILAI) return s;
  return s.slice(0, MAKS_NILAI) + '...(dipangkas)';
}

/**
 * Bersihkan nilai yang akan masuk `params`.
 *
 * Hanya bentuk yang aman: string dipangkas, angka dan boolean dibiarkan,
 * bentuk lain diganti keterangan. Alasannya `params` kolomnya JSONB dan
 * isinya dilihat oleh auditor, jadi tidak boleh ada objek yang anak-anaknya ikut
 * di-serialize -- termasuk `toJSON` buatan klien atau `__proto__`.
 */
function nilaiBersih(v) {
  if (v === undefined || v === null) return undefined;
  const t = typeof v;
  if (t === 'string') return pangkas(v);
  if (t === 'number') return Number.isFinite(v) ? v : undefined;
  if (t === 'boolean') return v;
  if (Array.isArray(v)) {
    const list = v.slice(0, MAKS_DAFTAR).map(nilaiBersih).filter((x) => x !== undefined);
    if (v.length > MAKS_DAFTAR) list.push('...(dipangkas)');
    return list;
  }
  return '(tipe tidak dicatat)';
}

/**
 * Bersihkan seluruh isi `params`.
 *
 * Kunci yang bernilai kosong dibuang, bukan ditulis sebagai `""`: bedanya
 * "tidak memfilter tanggal" dan "memfilter tanggal kosong" adalah informasi,
 * dan log yang tidak bisa membedakan keduanya tidak bisa dipakai untuk
 * investigating.
 */
function paramsBersih(params) {
  const out = {};
  if (!params || typeof params !== 'object') return out;
  for (const k of Object.keys(params)) {
    const bersih = nilaiBersih(params[k]);
    if (bersih === undefined) continue;
    const kunci = pangkas(k);
    // Jangan tulis kunci yang mengubah prototipe objek.
    //
    // `out` dibuat dengan `{}` biasa, jadi `out['__proto__'] = {...}` tidak
    // menambahkan properti -- ia MENGGANTI prototipe dari `out` itu sendiri.
    // `params` datang dari query string dan body JSON, yang bisa memuat kunci
    // itu, dan seluruh `params` dibuang ke log dan kadang ke respons. Kunci
    // `constructor`/`prototype` serupa dalam efeknya.
    //
    // Kehilangan kunci ini tidak mengurangi audit apa pun: `__proto__` bukan
    // parameter aplikasi, dan nilai `paramsBersih` selalu diperiksa sebagai
    // data biasa. Yang lebih berbahaya justru menuliskannya.
    if (kunci === '__proto__' || kunci === 'constructor' || kunci === 'prototype') continue;
    out[kunci] = bersih;
  }
  return out;
}

/**
 * Validasi alamat IP untuk kolom `INET`.
 *
 * Kolomnya `INET`, jadi string sembarang akan ditolak database dan menggagalkan
 * pencatatan -- termasuk pencatatan yang justru paling penting. Alamat yang
 * tidak berbentuk IPv4/IPv6 disimpan sebagai NULL. IP bukan bagian dari klaim
 * keamanan mana pun di PRD, jadi kehilangan satu alamat lebih murah daripada
 * kehilangan seluruh baris.
 */
function ipBersih(ip) {
  if (ip === undefined || ip === null) return null;
  const s = String(ip).trim();
  if (s === '') return null;
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(s)) {
    const parts = s.split('.').map((p) => Number(p));
    if (parts.every((p) => p >= 0 && p <= 255)) return s;
    return null;
  }
  // IPv6: hex dan titik dua saja, minimal satu blok dua digit.
  if (/^[0-9a-fA-F:]+$/.test(s) && s.includes(':')) {
    if (/^[0-9a-fA-F]{0,4}(:[0-9a-fA-F]{0,4}){2,7}$/.test(s)) return s;
  }
  return null;
}

/**
 * Putuskan nilai `result` untuk satu respons.
 *
 * Urutannya penting: kode eksplisit menang lebih dulu, karena kode menyebut
 * alasan penolakan secara spesifik, sedangkan status HTTP hanya menyebut
 * kelompok. Tanpa urutan ini `FIELD_NOT_GRANTED` yang berstatus 403 akan
 * tercatat sebagai `denied_auth`, dan localhost testing yang biasa dilakukan
 * akan terlihat seperti percobaan masuk.
 *
 * @param {object} opsi
 * @param {number} [opsi.status] status HTTP respons
 * @param {string} [opsi.kode] kode galat dari aplikasi
 * @returns {string} salah satu dari `HASIL_IZIN`
 */
function hasilDari(opsi) {
  const o = opsi || {};
  if (o.kode && Object.prototype.hasOwnProperty.call(PETA_KODE, o.kode)) {
    return PETA_KODE[o.kode];
  }
  const s = Number(o.status);
  if (Number.isFinite(s) && s >= 200 && s < 400) return HASIL.SUKSES;
  if (s === 401) return HASIL.DENIED_AUTH;
  if (s === 403) return HASIL.DENIED_AUTH;
  if (s === 429) return HASIL.RATE_LIMITED;
  if (s === 400 || s === 422) return HASIL.ERROR;
  return HASIL.ERROR;
}

/**
 * Susun entri `access_log` dari respons yang sudah selesai.
 *
 * Semua kolom tabel diisi. `category` dan `endpoint` tidak boleh NULL menurut
 * skema, jadi kalau route tidak menandai apa pun, isinya tetap nilai yang
 * berarti -- bukan string kosong yang tidak bisa dicari.
 *
 * @param {object} o
 * @param {object} [o.req] request Express
 * @param {object} [o.res] response Express
 * @param {object} [o.tanda] metadata yang diisi route lewat `tandai`
 * @returns {object} entri siap tulis
 */
function bangunEntri(o) {
  const opsi = o || {};
  const req = opsi.req || {};
  const res = opsi.res || {};
  const tanda = opsi.tanda || {};

  const actorType = tanda.actorType || (tanda.actorId ? 'agency' : 'agency');
  const actorId = Number.isFinite(Number(tanda.actorId)) && String(tanda.actorId).trim() !== ''
    ? Number(tanda.actorId)
    : null;

  const kategori = tanda.category === undefined || tanda.category === null || tanda.category === ''
    ? KATEGORI_SEMUA
    : pangkas(String(tanda.category));

  const rows = Number(tanda.responseRows);
  const responseRows = Number.isFinite(rows) && rows > 0 ? Math.floor(rows) : 0;

  return {
    actor_type: actorType,
    actor_id: actorId,
    category: kategori,
    params: paramsBersih(tanda.params),
    result: HASIL_IZIN.indexOf(tanda.result) >= 0 ? tanda.result : hasilDari(tanda),
    response_rows: responseRows,
    ip: ipBersih(tanda.ip !== undefined ? tanda.ip : (req.ip || req.socket && req.socket.remoteAddress)),
    endpoint: pangkas(String((req.originalUrl && req.originalUrl.split('?')[0]) || req.path || tanda.endpoint || '')),
  };
}

/**
 * Buat logger.
 *
 * `sink` menerima satu entri dan boleh mengembalikan Promise. Kegagalan
 * ditangkap, bukan dilempar -- lihat catatan panjang di kepala berkas.
 *
 * --- Mengapa gagal menulis TIDAK menjatuhkan permintaan (keputusan 2026-10-06) ---
 *
 * Penulisan terjadi pada event `finish`, yaitu setelah respons sudah
 * dikirim. Menjatuhkan respons bukan lagi mungkin pada saat itu, dan
 * mencobanya berarti menambah latensi tulis pada SETIAP permintaan serta
 * membuat PostgreSQL down berarti API down -- yang merusak M-2 ("query tetap
 * mengembalikan data saat RPC mati"). Jadi: **fail-open**.
 *
 * Tapi fail-open yang diam adalah kegagalan ganda. Yang dipilih adalah
 * fail-open yang TERUKUR, lewat tiga hal sekaligus:
 *
 *   1. antrian retry berbatas -- kegagalan sesaat tidak langsung hilang;
 *   2. penghitung `dibuang` -- entri yang benar-benar hilang tidak hilang
 *      dari perhitungan juga, jadi ada angka yang bisa dilaporkan;
 *   3. `status()` yang diekspos endpoint -- kegagalan terlihat oleh
 *      pemantauan, bukan hanya di baris stderr yang lewat begitu saja.
 *
 * Tanpa ketiganya, "permintaan sukses tapi tidak tercatat" dan "memang tidak
 * pernah ada permintaan" terlihat identik di log -- dan itulah yang harus
 * ditulis jujur di laporan sebagai sisa ketidakpastian.
 *
 * @param {object} [opsi]
 * @param {function(object): (void|Promise)} [opsi.sink] tempat entri ditulis
 * @param {function} [opsi.pelapor] pelapor kegagalan sink, default ke stderr
 * @param {number} [opsi.kapasitasAntrean] entri yang ditahan saat sink gagal
 * @returns {object} logger dengan `catat`, `jumlah`, `gagal`, `terakhir`, `status`
 */
function buatLogger(opsi) {
  const o = opsi || {};
  const pelapor = o.pelapor || ((e) => console.error('[access-log] gagal menulis:', e && e.message ? e.message : e));

  // 1000 entri kira-kira beberapa menit pada 60 req/menit. Cukup untuk
  // menutup blip koneksi, sengaja tidak lebih besar: antrean yang tumbuh
  // tanpa batas mengubah kegagalan logging menjadi kehabisan memori, yaitu
  // kegagalan yang lebih buruk dari yang ingin dicegah.
  const KAPASITAS = Number.isFinite(o.kapasitasAntrean) && o.kapasitasAntrean > 0 ? o.kapasitasAntrean : 1000;

  let jumlah = 0;
  let gagal = 0;
  let terakhir = null;
  let dibuang = 0;
  let terakhirGagal = null;

  // Percobaan maksimum sebelum sebuah entri dianggap hilang permanen.
  const MAKS_COBA = Number.isFinite(o.maksCoba) && o.maksCoba > 0 ? o.maksCoba : 3;

  /**
   * Entri yang belum berhasil dikirim.
   *
   * Setiap entri membawa `coba`, supaya retry berbatas. Tanpa batas ini,
   * sink yang rusak permanen mengubah antrean menjadi memori yang tumbuh
   * selamanya -- kegagalan logging berubah jadi kehabisan memori, yaitu
   * kegagalan yang lebih parah dari yang dicegah.
   *
   * `ekorJanji` menumpuk setiap pengiriman di atas Promise sebelumnya, jadi
   * urutan di sink sama dengan urutan kedatangan. Tanpa ini, Promise asinkron
   * menulis baris secara acak.
   */
  let antrean = [];
  let ekorJanji = Promise.resolve();
  let jadwalFlush = null;

  /**
   * Jadwalkan pendorongan antrean tanpa menunggu permintaan berikutnya.
   *
   * Tanpa ini, entri yang tertahan hanya keluar kalau ada request baru. Pada
   * malam hari atau setelah kegagalan sink, lalu lintas bisa nol selama
   * berjam-jam -- dan entri yang seharusnya hanya tertahan beberapa detik
   * jadi hilang selamanya begitu proses berhenti.
   *
   * `unref` supaya timer tidak menahan proses tetap hidup: kehilangan satu
   * flush saat proses ditutup lebih baik daripada server yang tidak pernah
   * bisa dihentikan.
   */
  function jadwal() {
    if (jadwalFlush || antrean.length === 0) return;
    jadwalFlush = setTimeout(() => {
      jadwalFlush = null;
      dorongAntrean();
      jadwal();
    }, 250);
    if (typeof jadwalFlush.unref === 'function') jadwalFlush.unref();
  }

  function catatGagal(e, entri) {
    gagal++;
    terakhirGagal = {
      pesan: (e && e.message) ? e.message : String(e),
      waktu: new Date().toISOString(),
      endpoint: (entri && entri.endpoint) || null,
      result: (entri && entri.result) || null,
    };
    try {
      pelapor(e);
    } catch (abaikan) {
      // Pelapor yang ikut gagal tidak boleh menjatuhkan permintaan: kita
      // sudah berada di dalam jalur penanganan kegagalan, dan menambah
      // kegagalan di sana hanya menyembunyikan penyebab aslinya.
    }
  }

  /** Catat kegagalan permanen: entri dianggap hilang dan berhenti dicoba. */
  function buangDenganCatatan(item, e) {
    dibuang++;
    catatGagal(
      new Error('menyerah setelah ' + item.coba + ' percobaan: ' +
        ((e && e.message) || e) + ' [' + (item.entri.endpoint || '') + ']'),
      item.entri
    );
  }

  /**
   * Kirim satu entri.
   *
   * Dua jenis kegagalan ditangani berbeda, dan perbedaannya disengaja:
   *
   * - **Sinkron (melempar).** Langsung dicatat dan hilang, tanpa retry.
   *   Sink produksi mengembalikan Promise; melempar secara sinkron berarti
   *   cacat pemrograman. Meretry-nya hanya menahan seluruh antrean di
   *   belakang untuk kemudian gagal dengan cara yang persis sama.
   * - **Asinkron (Promise ditolak).** Itulah jalur PostgreSQL: koneksi putus,
   *   timeout. Ditahan di antrean dan dicoba ulang sampai `MAKS_COBA`.
   *
   * Fungsi ini tidak pernah menyisipkan entri ke `antrean`. Alasannya urutan:
   * pada kegagalan sinkron, entri yang sedang dicoba masih berada di kepala
   * antrean sampai pemanggil menggesernya; menyisipkan di sini akan
   * menggandakan baris yang sama. Dan pada kegagalan asinkron, pemanggil
   * sudah selesai menggeser jauh sebelum Promise sempat ditolak, jadi entri
   * sudah tidak ada di antrean dan menyisipkannya aman. Pemanggilan untuk
   * entri baru (`catat`) juga aman karena entri itu memang belum pernah masuk.
   *
   * @param {object} item `{ entri, coba }`
   * @returns {boolean} false kalau sink menolak secara sinkron
   */
  function kirim(item) {
    item.coba++;
    try {
      const hasil = o.sink(item.entri);
      if (hasil && typeof hasil.then === 'function') {
        ekorJanji = ekorJanji.then(() => hasil).catch((e) => {
          if (item.coba >= MAKS_COBA) buangDenganCatatan(item, e);
          else { antrean.push(item); jadwal(); }
        });
      }
      return true;
    } catch (e) {
      buangDenganCatatan(item, e);
      return false;
    }
  }

  /**
   * Kirim ulang entri yang tertahan.
   *
   * Entri diambil dari kepala antrean SEBELUM dicoba, bukan sesudahnya.
   * Kalau dicoba lalu digeser, kegagalan sinkron akan meninggalkan entri yang
   * sama di posisi terdepan tanpa pernah bergeser -- percobaan berikutnya
   * gagal lagi, dan seterusya tanpa ujung.
   *
   * Berhenti pada kegagalan sinkron pertama: entri berikutnya tidak boleh
   * menyusul, karena itu berarti urutan di sink tertukar.
   */
  function dorongAntrean() {
    while (antrean.length > 0) {
      const item = antrean.shift();
      if (!kirim(item)) break;
    }
    // Masih ada yang tertahan berarti flush berikutnya diperlukan tanpa
    // menunggu request baru.
    jadwal();
  }

  function catat(entri) {
    if (!entri || typeof entri !== 'object') {
      gagal++;
      try { pelapor(new Error('entri bukan objek')); } catch (abaikan) {}
      return null;
    }
    jumlah++;
    terakhir = entri;
    if (typeof o.sink !== 'function') return entri;

    dorongAntrean();
    if (antrean.length >= KAPASITAS) {
      // Antrean penuh: entri baru dibuang, tapi TETAP dihitung. Membuang
      // tanpa menghitung membuat angka `gagal` terlihat sehat justru saat
      // kegagalan terburuk.
      dibuang++;
      catatGagal(
        new Error('antrean penuh (' + KAPASITAS + '), entri dibuang: ' + (entri.endpoint || '')),
        entri
      );
      return entri;
    }
    kirim({ entri, coba: 0 });
    return entri;
  }

  return {
    catat,
    /** Jumlah entri yang dicoba, termasuk yang gagal ditulis. */
    jumlah: () => jumlah,
    /** Jumlah entri yang gagal ditulis ke sink. */
    gagal: () => gagal,
    /** Entri terakhir, untuk uji tanpa harus menangkap sink. */
    terakhir: () => terakhir,
    /**
     * Ringkasan kesehatan penulisan log.
     *
     * Sengaja berupa angka, bukan `true`/`false`: "0 entri gagal" dan
     * "entri gagal tapi sudah pulih" keduanya sehat, dan membedakannya
     * berguna saat menyelidiki.
     */
    status: () => ({
      ditulis: jumlah,
      gagal,
      dibuang,
      tertahan: antrean.length,
      terakhir_gagal: terakhirGagal,
    }),
  };
}

/**
 * Pasang middleware pencatatan.
 *
 * Dipasang SEKALI di aplikasi, bukan per-route. Ini yang menjamin "setiap
 * pemanggilan" di FR-4.4: route yang lupa memanggilnya tetap tercatat, karena
 * yang dipasang adalah responsnya, bukan pilihannya. Hook `finish` dipakai
 * karena itu satu-satunya tempat yang dijamin berjalan untuk respons 2xx, 4xx,
 * dan 5xx alike.
 *
 * Route menandai metadata yang hanya dia tahu -- kategori, parameter, jumlah
 * baris, kode penolakan -- lewat `tandai(res, ...)`. Metadata yang tidak
 * ditandai tidak hilang; ia diisi nilai yang benar tapi umum.
 *
 * `ambilLogger` adalah fungsi, bukan objek logger, supaya logger bisa ditukar
 * saat proses berjalan (uji memakai ini) tanpa memasang ulang middleware.
 * Yang berarti logger dibaca saat setiap entri ditulis, bukan sekali di awal.
 *
 * Logger divalidasi SEKALI di sini, waktu pemasangan, bukan saat request
 * pertama. Kesalahan konfigurasi yang baru muncul saat respons pertama
 * selesai berarti request pertama hilang dari log audit -- persis request yang
 * tidak boleh hilang -- dangalat actionable-nya muncul jauh dari penyebabnya.
 *
 * @param {object} app aplikasi Express
 * @param {function(): object} ambilLogger mengembalikan logger dari `buatLogger`
 * @returns {object} app
 * @throws {Error} kalau `ambilLogger` tidak mengembalikan objek dengan `catat`
 */
function pasang(app, ambilLogger) {
  if (typeof ambilLogger !== 'function') {
    throw new TypeError('pasang(): ambilLogger harus fungsi, bukan ' + typeof ambilLogger);
  }
  const pertama = ambilLogger();
  if (!pertama || typeof pertama.catat !== 'function') {
    throw new TypeError('pasang(): ambilLogger() harus mengembalikan objek dengan .catat');
  }

  app.use((req, res, next) => {
    res.locals = res.locals || {};
    res.locals.accessLog = {};

    let ditulis = false;
    const tulis = () => {
      if (ditulis) return;
      ditulis = true;
      const tanda = res.locals.accessLog;
      tanda.status = res.statusCode;
      if (!tanda.result) tanda.result = hasilDari({ status: res.statusCode, kode: tanda.kode });
      const logger = ambilLogger();
      // Loggernya sudah divalidasi saat pemasangan, tapi ditukar saat proses
      // berjalan. Logger yang salah dipasang ulang harus dilaporkan, bukan
      // menjatuhkan respons yang sedang dikirim.
      if (!logger || typeof logger.catat !== 'function') {
        console.error('[access-log] ambilLogger() tidak mengembalikan logger; entri dilewati');
        return;
      }
      logger.catat(bangunEntri({ req, res, tanda }));
    };

    res.on('finish', tulis);
    // Permintaan yang diputus klien tidak selalu memicu `finish`. Untuk log
    // audit, permintaan yang gagal itu justru yang paling ingin diketahui, jadi
    // `close` juga dipakai -- dengan penanda agar tidak mencatat dua kali.
    res.on('close', tulis);
    next();
  });
  return app;
}

/**
 * Tandai metadata untuk entri log akses request ini.
 *
 * Dipanggil route di tengah pengerjaannya, begitu ia tahu apa pun yang tidak
 * bisa diketahui dari respons saja.
 *
 * @param {object} res response Express
 * @param {object} patch field yang ditambahkan
 * @returns {object} response, untuk rantai pemanggilan
 */
function tandai(res, patch) {
  if (res && res.locals) res.locals.accessLog = Object.assign({}, res.locals.accessLog, patch || {});
  return res;
}

/** Default sink: satu baris JSON ke stdout, biar terlihat di log platform. */
function sinkConsole(entri) {
  console.log('[access-log] ' + JSON.stringify(entri));
}

module.exports = {
  pasang,
  tandai,
  buatLogger,
  buildEntry: bangunEntri,
  hasilDari,
  paramsBersih,
  ipBersih,
  nilaiBersih,
  sinkConsole,
  HASIL,
  HASIL_IZIN,
  PETA_KODE,
  KATEGORI_SEMUA,
};