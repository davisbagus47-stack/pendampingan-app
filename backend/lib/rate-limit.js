/**
 * Rate limit dan kuota per instansi (FR-4.5, AT-14).
 *
 * Modul ini murni: tidak ada jam sistem, tidak ada jaringan, tidak ada Express.
 * Waktu selalu masuk sebagai argumen dan state disimpan di peta yang dibuat
 * pemanggil. Itu bukan sekadar lawfully-agar mudah diuji -- limiter yang
 * bergantung pada `Date.now()` di dalam dirinya sendiri hampir selalu lolos
 * dari uji, karena waktu yang diuji bukan waktu yang dipakai saat dijalankan.
 *
 * Batasnya ada dua, dan keduanya wajib:
 *
 *   - **Kuota** (jumlah permintaan dalam satu jendela). Inilah yang diminta
 *     FR-4.5. Calculated per instansi, bukan global: satu instansi yang rakus
 *     tidak boleh menghabiskan jatah instansi lain, karena tiap instansi punya
 *     TPK dan-operator sendiri yang dilayani sistem yang sama.
 *   - **Burst** (permintaan dalam satu detik penuh). Tanpa ini, kuota 100 per
 *     menit masih menerima 100 permintaan dalam milidetik pertama dan
 *     menggagalkan semua operator pada jam sibuk. Batas burst menymoothkan
 *     lonjakan tanpa mengubah kuota total.
 *
 * Keputusannya disimpan per Agency, bukan per IP dan bukan per kunci API:
 * FR-4.5 menyebut "per instansi", dan Agency adalah identitas yang sudah
 * dipakai lapisan otorisasi. Kunci API dan IP bisa berubah atau dipakai
 * bergantian, jadi menghitungnya akan membiarkan satu instansi melewati kuota
 * hanya dengan mengganti kunci.
 */

/** Default bila agency_config tidak menyetel apa pun. */
const BAWAAN = {
  kuota: 60,
  jendelaMs: 60 * 1000,
  burst: 10,
};

/**
 * Buat limiter baru.
 *
 * @param {object} [opsi]
 * @param {number} [opsi.jendelaMs] panjang satu jendela kuota
 * @param {number} [opsi.burst] permintaan maksimum dalam satu detik penuh
 * @param {function(): number} [opsi.sekarang] sumber waktu, dalam milidetik
 * @returns {object} limiter dengan `periksa` dan `aturKonfigurasi`
 */
function buatLimiter(opsi) {
  const o = opsi || {};
  const jendelaMs = o.jendelaMs || BAWAAN.jendelaMs;
  const burst = o.burst === undefined ? BAWAAN.burst : o.burst;
  const sekarang = o.sekarang || (() => Date.now());

  // Konfigurasi per Agencies, dibaca dari agency_config saat runtime.
  const konfigurasi = new Map();

  // State per Agencies: jendela kuota yang sedang berjalan dan antrean burst.
  const state = new Map();

  return {
    /** Tetapkan kuota untuk satu instansi. */
    aturKonfigurasi(agencyId, cfg) {
      if (!agencyId) return;
      const kuota = cfg && Number.isFinite(cfg.kuota) ? cfg.kuota : BAWAAN.kuota;
      konfigurasi.set(String(agencyId), {
        kuota,
        jendelaMs: cfg && Number.isFinite(cfg.jendelaMs) ? cfg.jendelaMs : jendelaMs,
        burst: cfg && Number.isFinite(cfg.burst) ? cfg.burst : burst,
      });
      // Konfigurasi berubah, jadi state lama tidak boleh dipakai: jendela yang
      // dihitung dengan kuota sebelumnya akan menyisakan sisa yang tidak cocok
      // dengan kuota yang baru.
      state.delete(String(agencyId));
    },

    /**
     * Periksa satu permintaan untuk satu instansi.
     *
     * @param {string} agencyId identitas instansi
     * @param {number} [waktuMs] waktu sekarang; default dari sumber `sekarang`
     * @returns {{ allowed: boolean, limit: number, remaining: number,
     *             retryAfter: number, resetAt: number, scope: string }}
     */
    periksa(agencyId, waktuMs) {
      const id = String(agencyId === undefined || agencyId === null ? '' : agencyId);
      const t = waktuMs === undefined ? sekarang() : waktuMs;

      if (id === '') {
        // Tanpa identitas instansi tidak ada kuota yang bisa dihitung. Menolak
        // lebih aman daripada memberi kuota tak terbatas -- dan diam-diam
        // mengizinkan berarti limiter dilewati sepenuhnya.
        return {
          allowed: false,
          limit: 0,
          remaining: 0,
          retryAfter: Math.ceil(jendelaMs / 1000),
          resetAt: t + jendelaMs,
          scope: 'agency',
          reason: 'agency-tidak-dikenali',
        };
      }

      const cfg = konfigurasi.get(id) || {
        kuota: BAWAAN.kuota,
        jendelaMs,
        burst: BAWAAN.burst,
      };

      const s = state.get(id) || { mulai: t, dipakai: 0, antrean: [] };

      // Jendela berganti: sudah lewat dari titik awal jendela sekarang.
      if (t - s.mulai >= cfg.jendelaMs) {
        s.mulai = t - (t - s.mulai) % cfg.jendelaMs;
        s.dipakai = 0;
      }

      // Antrean burst: buang yang sudah keluar dari satu detik terakhir.
      s.antrean = s.antrean.filter((w) => t - w < 1000);

      const resetAt = s.mulai + cfg.jendelaMs;
      const remaining = Math.max(0, cfg.kuota - s.dipakai);

      if (s.dipakai >= cfg.kuota) {
        state.set(id, s);
        return {
          allowed: false,
          limit: cfg.kuota,
          remaining: 0,
          retryAfter: Math.max(1, Math.ceil((resetAt - t) / 1000)),
          resetAt,
          scope: 'kuota',
          reason: 'kuota-jendela-terpakai',
        };
      }

      if (cfg.burst > 0 && s.antrean.length >= cfg.burst) {
        state.set(id, s);
        return {
          allowed: false,
          limit: cfg.kuota,
          remaining,
          // Satu detik: burst memang diukur per detik, dan menunggu sampai
          // jendela kuota berganti akan menjatuhkan orang yang sebenarnya hanya
          // mengirim beberapa permintaan beruntun.
          retryAfter: 1,
          resetAt,
          scope: 'burst',
          reason: 'burst-per-detik-terlampaui',
        };
      }

      s.dipakai += 1;
      s.antrean.push(t);
      state.set(id, s);

      return {
        allowed: true,
        limit: cfg.kuota,
        remaining: Math.max(0, cfg.kuota - s.dipakai),
        retryAfter: 0,
        resetAt,
        scope: 'kuota',
        reason: null,
      };
    },

    /** Buang state satu instansi; dipakai setelah logout atau pencabutan kunci. */
    lupakan(agencyId) {
      state.delete(String(agencyId));
    },

    /** Buang seluruh state. Untuk uji dan untuk reset setelah kegagalan. */
    reset() {
      state.clear();
      konfigurasi.clear();
    },

    BAWAAN,
  };
}

/**
 * Header rate limit untuk respons.
 *
 * `RateLimit-Limit` dan `RateLimit-Remaining` memakai format sederhana
 * `limit`/`remaining`, bukan `Quota-remaining` warisan RFC. Yang penting bukan
 * nama headernya melainkan dua hal: batas dan sisa harus terlihat oleh klien,
 * dan `Retry-After` harus ada saat permintaan ditolak -- tanpa itu klien tidak
 * tahu kapan mencoba lagi dan hanya akan mengirim lebih cepat.
 */
function headerRateLimit(hasil) {
  const h = {
    'RateLimit-Limit': String(hasil.limit),
    'RateLimit-Remaining': String(hasil.remaining),
  };
  if (!hasil.allowed && hasil.retryAfter > 0) {
    h['Retry-After'] = String(hasil.retryAfter);
  }
  return h;
}

module.exports = {
  buatLimiter,
  headerRateLimit,
  BAWAAN,
};
