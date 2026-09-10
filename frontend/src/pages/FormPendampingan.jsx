import React, { useState } from 'react';
import axios from 'axios';
import './FormPendampingan.css';

const API_URL = (process.env.REACT_APP_API_URL || window.location.origin).replace(/\/+$/, '');

const JENIS_SASARAN_OPTIONS = [
  { value: 'Catin', label: 'Calon Pengantin / Calon PUS' },
  { value: 'Ibu Hamil', label: 'Ibu Hamil' },
  { value: 'Ibu Nifas', label: 'Ibu Nifas / Pasca Persalinan' },
  { value: 'Baduta', label: 'Baduta 0-23 Bulan' },
];

const PERAN_TPK_OPTIONS = [
  { value: 'Bidan', label: 'Bidan' },
  { value: 'Kader PKK', label: 'Kader TP PKK' },
  { value: 'Kader KB', label: 'Kader KB' },
];

const SUMBER_AIR_OPTIONS = [
  { value: 'Air kemasan/isi ulang', label: 'Air kemasan / isi ulang' },
  { value: 'Ledeng/PAM', label: 'Ledeng / PAM' },
  { value: 'Sumur Bor/Pompa Terlindungi', label: 'Sumur Bor / Pompa Terlindungi' },
  { value: 'Sumur Tak Terlindungi', label: 'Sumur Tak Terlindungi' },
  { value: 'Mata Air Terlindungi', label: 'Mata Air Terlindungi' },
  { value: 'Mata Air Tak Terlindungi', label: 'Mata Air Tak Terlindungi' },
  { value: 'Air Hujan', label: 'Air Hujan' },
  { value: 'Air Permukaan', label: 'Air Permukaan' },
  { value: 'Lainnya', label: 'Lainnya' },
];

const JAMBAN_OPTIONS = [
  { value: 'Jamban milik sendiri', label: 'Jamban milik sendiri dengan leher angsa dan Tangki Septik/IPAL' },
  { value: 'Jamban MCK kumunal', label: 'Jamban pada MCK kumunal dengan leher angsa dan Tangki Septic/IPAL' },
  { value: 'Lainnya', label: 'Lainnya' },
  { value: 'Tidak ada', label: 'Tidak ada' },
];

const JENIS_KB_OPTIONS = [
  'MOW', 'MOP', 'IUD/AKDR', 'Implan/Susuk KB', 'Suntik KB',
  'Pil KB', 'Kondom', 'MAL', 'Lainnya', 'Tidak pakai KB',
];

const FORM_AWAL = {
  namaTPK: '',
  peranTPK: '',
  noHpTPK: '',

  namaDesa: '',
  namaKecamatan: '',
  rw: '',
  rt: '',

  nik: '',
  noKK: '',
  namaLengkap: '',
  noHp: '',
  tanggalLahir: '',
  usia: '',
  alamat: '',

  jenisSasaran: '',

  sumberAir: '',
  jamban: '',
  terpaparRokok: '',

  terlaluMuda: '',
  terlaluTua: '',
  terlaluDekat: '',
  terlaluBanyak: '',

  gunakanKB: '',
  jenisKB: '',
  rencanaKB: '',
  rencanaKehamilan: '',

  bpjsAktif: '',
  jenisBPJS: '',
  dtks: '',
  bansosDiterima: '',

  hpht: '',
  usiaKehamilan: '',
  bbSebelumHamil: '',
  bbSekarang: '',
  tb: '',
  lila: '',
  hb: '',
  tfu: '',
  tbj: '',
  riwayatPenyakit: '',
  terimaTTD: '',
  aksesFaskes: '',
  hamilKembar: '',

  tanggalLahirBayi: '',
  umurBayi: '',
  bbLahir: '',
  pbLahir: '',
  cukupBulan: '',
  asiEksklusif: '',
  sudahImunisasi: '',
  kak: '',
  stimulasi: '',

  kiePenyuluhan: '',
  jenisKIE: '',
  kiePerseorangan: '',
  kieKelompok: '',

  fasilitasiRujukan: '',
  rujukanKe: '',
  rujukanProses: '',

  fasilitasiBansos: '',
  bansosDapat: '',
  bansosProgram: '',

  hadirPosyandu: '',
  teridentifikasiRisiko: '',
  catatanTPK: '',
  tanggalKunjungan: '',
  tanggalKunjunganBerikutnya: '',
};

const Field = ({ label, required, children }) => (
  <div className="field">
    <label>
      {label}
      {required && <span className="req">*</span>}
    </label>
    {children}
  </div>
);

const FormPendampingan = () => {
  const [formData, setFormData] = useState(FORM_AWAL);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState(null);

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setStatus(null);
    try {
      await axios.post(`${API_URL}/api/submit`, formData);
      setStatus({ type: 'success', message: 'Data berhasil dikirim ke Google Sheets.' });
      setFormData(FORM_AWAL);
    } catch (error) {
      console.error(error);
      const msg = error.response && error.response.data && error.response.data.message;
      setStatus({ type: 'error', message: msg || 'Gagal mengirim data. Pastikan server backend sedang berjalan.' });
    } finally {
      setLoading(false);
    }
  };

  const sasaran = formData.jenisSasaran;
  const isCatin = sasaran === 'Catin';
  const isIbuHamil = sasaran === 'Ibu Hamil';
  const isIbuNifas = sasaran === 'Ibu Nifas';
  const isBaduta = sasaran === 'Baduta';

  return (
    <div className="gov-page">
      <header className="gov-header">
        <div className="gov-header-topline"></div>
        <div className="gov-header-inner">
          <div className="gov-brand">
            <div className="gov-emblem">TPK</div>
            <div>
              <h1>Formulir Pendampingan Keluarga</h1>
              <p>Tim Pendamping Keluarga (TPK) — Percepatan Penurunan Stunting</p>
            </div>
          </div>
        </div>
      </header>

      <main className="gov-main">
        <form onSubmit={handleSubmit}>
          {status && (
            <div className={`alert alert-${status.type}`} role="status">
              {status.message}
            </div>
          )}

          {/* ====== A. DATA PETUGAS TPK ====== */}
          <section className="card">
            <h2 className="card-title">A. Data Petugas TPK</h2>
            <div className="fields-grid">
              <Field label="Nama Petugas TPK" required>
                <input name="namaTPK" value={formData.namaTPK} placeholder="Nama lengkap petugas" onChange={handleChange} />
              </Field>
              <Field label="Peran dalam TPK" required>
                <select name="peranTPK" value={formData.peranTPK} onChange={handleChange}>
                  <option value="">-- Pilih --</option>
                  {PERAN_TPK_OPTIONS.map(o => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </Field>
              <Field label="No. HP Petugas">
                <input name="noHpTPK" value={formData.noHpTPK} placeholder="08xxxxxxxxxx" inputMode="tel" onChange={handleChange} />
              </Field>
            </div>
          </section>

          {/* ====== B. LOKASI ====== */}
          <section className="card">
            <h2 className="card-title">B. Lokasi Pendampingan</h2>
            <div className="fields-grid">
              <Field label="Desa / Kelurahan" required>
                <input name="namaDesa" value={formData.namaDesa} placeholder="Nama desa/kelurahan" onChange={handleChange} />
              </Field>
              <Field label="Kecamatan">
                <input name="namaKecamatan" value={formData.namaKecamatan} placeholder="Nama kecamatan" onChange={handleChange} />
              </Field>
              <Field label="RW">
                <input name="rw" value={formData.rw} placeholder="Contoh: 01" onChange={handleChange} />
              </Field>
              <Field label="RT">
                <input name="rt" value={formData.rt} placeholder="Contoh: 02" onChange={handleChange} />
              </Field>
            </div>
          </section>

          {/* ====== C. BIODATA SASARAN ====== */}
          <section className="card">
            <h2 className="card-title">C. Biodata Sasaran Pendampingan</h2>
            <div className="fields-grid">
              <Field label="Jenis Sasaran" required>
                <select name="jenisSasaran" value={formData.jenisSasaran} onChange={handleChange}>
                  <option value="">-- Pilih --</option>
                  {JENIS_SASARAN_OPTIONS.map(o => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </Field>
              <Field label="Nama Lengkap Sasaran" required>
                <input name="namaLengkap" value={formData.namaLengkap} placeholder="Nama lengkap" onChange={handleChange} />
              </Field>
              <Field label="NIK" required>
                <input name="nik" value={formData.nik} placeholder="16 digit NIK" maxLength={16} inputMode="numeric" onChange={handleChange} />
              </Field>
              <Field label="Nomor Kartu Keluarga">
                <input name="noKK" value={formData.noKK} placeholder="16 digit No. KK" maxLength={16} inputMode="numeric" onChange={handleChange} />
              </Field>
              <Field label="Tanggal Lahir">
                <input type="date" name="tanggalLahir" value={formData.tanggalLahir} onChange={handleChange} />
              </Field>
              <Field label="Usia (tahun)">
                <input name="usia" value={formData.usia} placeholder="Contoh: 25" inputMode="numeric" onChange={handleChange} />
              </Field>
              <Field label="No. HP / WhatsApp">
                <input name="noHp" value={formData.noHp} placeholder="08xxxxxxxxxx" inputMode="tel" onChange={handleChange} />
              </Field>
              <Field label="Alamat Lengkap">
                <input name="alamat" value={formData.alamat} placeholder="Alamat rumah" onChange={handleChange} />
              </Field>
            </div>
          </section>

          {/* ====== D. KONDISI RUMAH & LINGKUNGAN ====== */}
          <section className="card">
            <h2 className="card-title">D. Kondisi Rumah &amp; Lingkungan</h2>
            <div className="fields-grid">
              <Field label="Akses Air Minum yang Layak" required>
                <select name="sumberAir" value={formData.sumberAir} onChange={handleChange}>
                  <option value="">-- Pilih --</option>
                  {SUMBER_AIR_OPTIONS.map(o => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </Field>
              <Field label="Fasilitas BAB (Jamban)" required>
                <select name="jamban" value={formData.jamban} onChange={handleChange}>
                  <option value="">-- Pilih --</option>
                  {JAMBAN_OPTIONS.map(o => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </Field>
              <Field label="Apakah terpapar asap rokok?">
                <select name="terpaparRokok" value={formData.terpaparRokok} onChange={handleChange}>
                  <option value="">-- Pilih --</option>
                  <option value="Ya">Ya (Merokok / Terpapar asap rokok)</option>
                  <option value="Tidak">Tidak</option>
                </select>
              </Field>
            </div>
          </section>

          {/* ====== E. FAKTOR RISIKO (4T) ====== */}
          <section className="card">
            <h2 className="card-title">E. Faktor Risiko 4T</h2>
            <p className="card-desc">Identifikasi kondisi 4T yang merupakan faktor risiko stunting</p>
            <div className="fields-grid">
              <Field label="Terlalu muda (usia &lt;20 tahun saat hamil)">
                <select name="terlaluMuda" value={formData.terlaluMuda} onChange={handleChange}>
                  <option value="">-- Pilih --</option>
                  <option value="Ya">Ya</option>
                  <option value="Tidak">Tidak</option>
                </select>
              </Field>
              <Field label="Terlalu tua (usia &gt;35 tahun saat hamil)">
                <select name="terlaluTua" value={formData.terlaluTua} onChange={handleChange}>
                  <option value="">-- Pilih --</option>
                  <option value="Ya">Ya</option>
                  <option value="Tidak">Tidak</option>
                </select>
              </Field>
              <Field label="Terlalu dekat jarak kehamilan (&lt;2 tahun)">
                <select name="terlaluDekat" value={formData.terlaluDekat} onChange={handleChange}>
                  <option value="">-- Pilih --</option>
                  <option value="Ya">Ya</option>
                  <option value="Tidak">Tidak</option>
                </select>
              </Field>
              <Field label="Terlalu banyak anak (&gt;4 anak)">
                <select name="terlaluBanyak" value={formData.terlaluBanyak} onChange={handleChange}>
                  <option value="">-- Pilih --</option>
                  <option value="Ya">Ya</option>
                  <option value="Tidak">Tidak</option>
                </select>
              </Field>
            </div>
          </section>

          {/* ====== F. STATUS KB & JAMINAN KESEHATAN ====== */}
          <section className="card">
            <h2 className="card-title">F. Status KB &amp; Jaminan Kesehatan</h2>
            <div className="fields-grid">
              <Field label="Sudah menggunakan KB?">
                <select name="gunakanKB" value={formData.gunakanKB} onChange={handleChange}>
                  <option value="">-- Pilih --</option>
                  <option value="Ya">Ya</option>
                  <option value="Tidak">Tidak</option>
                </select>
              </Field>
              {formData.gunakanKB === 'Ya' && (
                <Field label="Jenis / Alat KB yang digunakan">
                  <select name="jenisKB" value={formData.jenisKB} onChange={handleChange}>
                    <option value="">-- Pilih --</option>
                    {JENIS_KB_OPTIONS.map(o => (
                      <option key={o} value={o}>{o}</option>
                    ))}
                  </select>
                </Field>
              )}
              {isCatin && (
                <Field label="Rencana menggunakan KB setelah menikah?">
                  <select name="rencanaKB" value={formData.rencanaKB} onChange={handleChange}>
                    <option value="">-- Pilih --</option>
                    <option value="Ya">Ya</option>
                    <option value="Tidak">Tidak</option>
                  </select>
                </Field>
              )}
              {isCatin && (
                <Field label="Rencana menunda kehamilan?">
                  <select name="rencanaKehamilan" value={formData.rencanaKehamilan} onChange={handleChange}>
                    <option value="">-- Pilih --</option>
                    <option value="Ya, rencana menunda">Ya, rencana menunda</option>
                    <option value="Ya, rencana segera hamil">Ya, rencana segera hamil</option>
                    <option value="Belum tentukan">Belum tentukan</option>
                  </select>
                </Field>
              )}
              <Field label="BPJS Kesehatan aktif?">
                <select name="bpjsAktif" value={formData.bpjsAktif} onChange={handleChange}>
                  <option value="">-- Pilih --</option>
                  <option value="Ya">Ya (Aktif)</option>
                  <option value="Tidak">Tidak Aktif / Tidak Ada</option>
                </select>
              </Field>
              {formData.bpjsAktif === 'Ya' && (
                <Field label="Jenis Kepesertaan BPJS">
                  <select name="jenisBPJS" value={formData.jenisBPJS} onChange={handleChange}>
                    <option value="">-- Pilih --</option>
                    <option value="PBI JK">PBI JK (Penerima Bantuan Iuran)</option>
                    <option value="BP PPU">BP PPU (Pekerja Penerima Upah)</option>
                    <option value="BPPU">BP PPU (Pekerja Bukan Penerima Upah)</option>
                    <option value="Non PBI">Non PBI (Mandiri)</option>
                  </select>
                </Field>
              )}
              <Field label="Terdaftar di DTKS?">
                <select name="dtks" value={formData.dtks} onChange={handleChange}>
                  <option value="">-- Pilih --</option>
                  <option value="Ya">Ya</option>
                  <option value="Tidak">Tidak</option>
                </select>
              </Field>
              <Field label="Sudah menerima bantuan sosial?">
                <select name="bansosDiterima" value={formData.bansosDiterima} onChange={handleChange}>
                  <option value="">-- Pilih --</option>
                  <option value="Ya">Ya</option>
                  <option value="Tidak">Tidak</option>
                </select>
              </Field>
            </div>
          </section>

          {/* ====== G. PEMERIKSAAN & HASIL (CONDITIONAL) ====== */}

          {/* --- Form Ibu Hamil --- */}
          {isIbuHamil && (
            <section className="card">
              <h2 className="card-title">G. Pemeriksaan Ibu Hamil</h2>
              <div className="fields-grid">
                <Field label="HPHT (Hari Pertama Haid Terakhir)">
                  <input type="date" name="hpht" value={formData.hpht} onChange={handleChange} />
                </Field>
                <Field label="Usia Kehamilan (minggu)">
                  <input name="usiaKehamilan" value={formData.usiaKehamilan} placeholder="Contoh: 24" inputMode="numeric" onChange={handleChange} />
                </Field>
                <Field label="Berat Badan Sebelum Hamil (kg)">
                  <input name="bbSebelumHamil" value={formData.bbSebelumHamil} placeholder="0.0" type="number" step="0.1" min="0" onChange={handleChange} />
                </Field>
                <Field label="Berat Badan Sekarang (kg)">
                  <input name="bbSekarang" value={formData.bbSekarang} placeholder="0.0" type="number" step="0.1" min="0" onChange={handleChange} />
                </Field>
                <Field label="Tinggi Badan (cm)">
                  <input name="tb" value={formData.tb} placeholder="0.0" type="number" step="0.1" min="0" onChange={handleChange} />
                </Field>
                <Field label="Lingkar Lengan Atas / LILA (cm)">
                  <input name="lila" value={formData.lila} placeholder="0.0" type="number" step="0.1" min="0" onChange={handleChange} />
                </Field>
                <Field label="Kadar Hemoglobin / Hb (g/dl)">
                  <input name="hb" value={formData.hb} placeholder="Contoh: 11.5" type="number" step="0.1" min="0" onChange={handleChange} />
                </Field>
                <Field label="Tinggi Fundus Uteri / TFU (cm)">
                  <input name="tfu" value={formData.tfu} placeholder="0.0" type="number" step="0.1" min="0" onChange={handleChange} />
                </Field>
                <Field label="Taksiran Berat Janin / TBJ (gram)">
                  <input name="tbj" value={formData.tbj} placeholder="Contoh: 2500" inputMode="numeric" onChange={handleChange} />
                </Field>
                <Field label="Riwayat Penyakit">
                  <input name="riwayatPenyakit" value={formData.riwayatPenyakit} placeholder="Hipertensi, Kencing Manis, dll" onChange={handleChange} />
                </Field>
                <Field label="Apakah mendapatkan Tablet Tambah Darah (TTD)?">
                  <select name="terimaTTD" value={formData.terimaTTD} onChange={handleChange}>
                    <option value="">-- Pilih --</option>
                    <option value="Ya, sudah mendapatkan TTD">Ya, sudah mendapatkan TTD</option>
                    <option value="Ya, sedang proses">Ya, sedang proses</option>
                    <option value="Tidak">Tidak</option>
                  </select>
                </Field>
                <Field label="Kehamilan kembar?">
                  <select name="hamilKembar" value={formData.hamilKembar} onChange={handleChange}>
                    <option value="">-- Pilih --</option>
                    <option value="Ya">Ya</option>
                    <option value="Tidak">Tidak</option>
                  </select>
                </Field>
                <Field label="Akses menuju Fasilitas Kesehatan">
                  <select name="aksesFaskes" value={formData.aksesFaskes} onChange={handleChange}>
                    <option value="">-- Pilih --</option>
                    <option value="Mudah">Mudah (bisa dijangkau)</option>
                    <option value="Sulit">Sulit (jarak jauh/sulit dijangkau)</option>
                  </select>
                </Field>
              </div>
            </section>
          )}

          {/* --- Form Ibu Nifas / Pasca Persalinan --- */}
          {isIbuNifas && (
            <section className="card">
              <h2 className="card-title">G. Pemeriksaan Ibu Nifas / Pasca Persalinan</h2>
              <div className="fields-grid">
                <Field label="Tanggal Melahirkan">
                  <input type="date" name="tanggalLahirBayi" value={formData.tanggalLahirBayi} onChange={handleChange} />
                </Field>
                <Field label="Cara Persalinan">
                  <select name="caraPersalinan" value={formData.caraPersalinan || ''} onChange={handleChange}>
                    <option value="">-- Pilih --</option>
                    <option value="Normal">Normal</option>
                    <option value="Sesar">Sesar</option>
                  </select>
                </Field>
                <Field label="Komplikasi masa nifas?">
                  <select name="riwayatPenyakit" value={formData.riwayatPenyakit} onChange={handleChange}>
                    <option value="">-- Pilih --</option>
                    <option value="Tidak ada">Tidak ada</option>
                    <option value="Pendarahan">Pendarahan</option>
                    <option value="Infeksi">Infeksi</option>
                    <option value="Hipertensi">Hipertensi</option>
                    <option value="Lainnya">Lainnya</option>
                  </select>
                </Field>
                <Field label="Menggunakan KB Pasca Persalinan?">
                  <select name="gunakanKB" value={formData.gunakanKB} onChange={handleChange}>
                    <option value="">-- Pilih --</option>
                    <option value="Ya">Ya</option>
                    <option value="Tidak">Tidak</option>
                  </select>
                </Field>
                {formData.gunakanKB === 'Ya' && (
                  <Field label="Jenis KB Pasca Persalinan (utamakan MKJP)">
                    <select name="jenisKB" value={formData.jenisKB} onChange={handleChange}>
                      <option value="">-- Pilih --</option>
                      {JENIS_KB_OPTIONS.map(o => (
                        <option key={o} value={o}>{o}</option>
                      ))}
                    </select>
                  </Field>
                )}
                <Field label="Mendapatkan TTD pasca persalinan?">
                  <select name="terimaTTD" value={formData.terimaTTD} onChange={handleChange}>
                    <option value="">-- Pilih --</option>
                    <option value="Ya">Ya</option>
                    <option value="Tidak">Tidak</option>
                  </select>
                </Field>
              </div>
            </section>
          )}

          {/* --- Form Baduta 0-23 Bulan --- */}
          {isBaduta && (
            <section className="card">
              <h2 className="card-title">G. Pemeriksaan Baduta (0-23 Bulan)</h2>
              <div className="fields-grid">
                <Field label="Berat Badan Lahir (kg)">
                  <input name="bbLahir" value={formData.bbLahir} placeholder="0.0" type="number" step="0.1" min="0" onChange={handleChange} />
                </Field>
                <Field label="Panjang Badan Lahir (cm)">
                  <input name="pbLahir" value={formData.pbLahir} placeholder="0.0" type="number" step="0.1" min="0" onChange={handleChange} />
                </Field>
                <Field label="Umur Kehamilan saat lahir (minggu)">
                  <input name="umurBayi" value={formData.umurBayi} placeholder="Contoh: 38" inputMode="numeric" onChange={handleChange} />
                </Field>
                <Field label="Cukup Bulan (&ge;37 minggu)?">
                  <select name="cukupBulan" value={formData.cukupBulan} onChange={handleChange}>
                    <option value="">-- Pilih --</option>
                    <option value="Ya">Ya (&ge;37 minggu)</option>
                    <option value="Tidak">Tidak (&lt;37 minggu)</option>
                  </select>
                </Field>
                <Field label="Berat Badan Sekarang (kg)">
                  <input name="bbSekarang" value={formData.bbSekarang} placeholder="0.0" type="number" step="0.1" min="0" onChange={handleChange} />
                </Field>
                <Field label="Tinggi/Panjang Badan Sekarang (cm)">
                  <input name="tb" value={formData.tb} placeholder="0.0" type="number" step="0.1" min="0" onChange={handleChange} />
                </Field>
                <Field label="ASI Eksklusif (0-6 bulan hanya ASI kecuali vitamin & oralit)?">
                  <select name="asiEksklusif" value={formData.asiEksklusif} onChange={handleChange}>
                    <option value="">-- Pilih --</option>
                    <option value="Ya">Ya</option>
                    <option value="Tidak">Tidak</option>
                  </select>
                </Field>
                <Field label="Sudah mendapatkan imunisasi rutin?">
                  <select name="sudahImunisasi" value={formData.sudahImunisasi} onChange={handleChange}>
                    <option value="">-- Pilih --</option>
                    <option value="Ya">Ya, sudah</option>
                    <option value="Belum">Belum</option>
                  </select>
                </Field>
                <Field label="Sudah mengisi Kartu Kembang Anak (KAK)?">
                  <select name="kak" value={formData.kak} onChange={handleChange}>
                    <option value="">-- Pilih --</option>
                    <option value="Ya">Ya</option>
                    <option value="Tidak">Tidak</option>
                  </select>
                </Field>
                <Field label="Perkembangan anak sesuai usia?">
                  <select name="stimulasi" value={formData.stimulasi} onChange={handleChange}>
                    <option value="">-- Pilih --</option>
                    <option value="Sesuai">Sesuai usia</option>
                    <option value="Tidak Sesuai">Tidak sesuai usia</option>
                  </select>
                </Field>
              </div>
            </section>
          )}

          {/* --- Form Catin --- */}
          {isCatin && (
            <section className="card">
              <h2 className="card-title">G. Pemeriksaan Calon Pengantin / Calon PUS</h2>
              <div className="fields-grid">
                <Field label="Sudah registrasi di ELSIMIL?">
                  <select name="aksesFaskes" value={formData.aksesFaskes} onChange={handleChange}>
                    <option value="">-- Pilih --</option>
                    <option value="Ya, sudah registrasi">Ya, sudah registrasi</option>
                    <option value="Belum">Belum</option>
                  </select>
                </Field>
                <Field label="Sudah melakukan pemeriksaan kesehatan pra-nikah?">
                  <select name="terimaTTD" value={formData.terimaTTD} onChange={handleChange}>
                    <option value="">-- Pilih --</option>
                    <option value="Ya, sudah">Ya, sudah</option>
                    <option value="Belum">Belum</option>
                  </select>
                </Field>
                <Field label="Sudah mengikuti kelas bimbingan perkawinan?">
                  <select name="sudahImunisasi" value={formData.sudahImunisasi} onChange={handleChange}>
                    <option value="">-- Pilih --</option>
                    <option value="Ya">Ya</option>
                    <option value="Tidak">Tidak</option>
                  </select>
                </Field>
                <Field label="Terpapar asap rokok?">
                  <select name="terpaparRokok" value={formData.terpaparRokok} onChange={handleChange}>
                    <option value="">-- Pilih --</option>
                    <option value="Ya">Ya</option>
                    <option value="Tidak">Tidak</option>
                  </select>
                </Field>
              </div>
            </section>
          )}

          {/* ====== H. KEGIATAN PENDAMPINGAN TPK ====== */}
          <section className="card">
            <h2 className="card-title">H. Kegiatan Pendampingan TPK pada Kunjungan Ini</h2>

            {/* KIE / Penyuluhan */}
            <div className="sub-section">
              <h3 className="sub-title">1. Penyuluhan / KIE</h3>
              <div className="fields-grid">
                <Field label="Apakah sudah memberikan Penyuluhan/KIE?">
                  <select name="kiePenyuluhan" value={formData.kiePenyuluhan} onChange={handleChange}>
                    <option value="">-- Pilih --</option>
                    <option value="Ya">Ya</option>
                    <option value="Tidak">Tidak</option>
                  </select>
                </Field>
                {formData.kiePenyuluhan === 'Ya' && (
                  <Field label="Jenis KIE yang diberikan">
                    <select name="jenisKIE" value={formData.jenisKIE} onChange={handleChange}>
                      <option value="">-- Pilih --</option>
                      <option value="Perseorangan">Perseorangan (KIE langsung)</option>
                      <option value="Kelompok">Kelompok (Penyuluhan kelompok)</option>
                      <option value="Perseorangan dan Kelompok">Perseorangan dan Kelompok</option>
                    </select>
                  </Field>
                )}
                <Field label="Materi KIE yang disampaikan">
                  <input name="catatanTPK" value={formData.catatanTPK} placeholder="Contoh: Gizi ibu hamil, ASI eksklusif, dll" onChange={handleChange} />
                </Field>
              </div>
            </div>

            {/* Fasilitasi Rujukan */}
            <div className="sub-section">
              <h3 className="sub-title">2. Fasilitasi Pelayanan Rujukan Kesehatan</h3>
              <div className="fields-grid">
                <Field label="Apakah perlu difasilitasi rujukan?">
                  <select name="fasilitasiRujukan" value={formData.fasilitasiRujukan} onChange={handleChange}>
                    <option value="">-- Pilih --</option>
                    <option value="Ya">Ya</option>
                    <option value="Tidak">Tidak</option>
                  </select>
                </Field>
                {formData.fasilitasiRujukan === 'Ya' && (
                  <>
                    <Field label="Rujukan ke">
                      <select name="rujukanKe" value={formData.rujukanKe} onChange={handleChange}>
                        <option value="">-- Pilih --</option>
                        <option value="Puskesmas">Puskesmas</option>
                        <option value="RSUD">RSUD / RS Kabupaten</option>
                        <option value="RS Swasta">RS Swasta</option>
                        <option value="Dokter Spesialis">Dokter Spesialis</option>
                        <option value="Lainnya">Lainnya</option>
                      </select>
                    </Field>
                    <Field label="Status Rujukan">
                      <select name="rujukanProses" value={formData.rujukanProses} onChange={handleChange}>
                        <option value="">-- Pilih --</option>
                        <option value="Ya, sedang proses">Ya, sedang proses pelayanan rujukan</option>
                        <option value="Ya, sudah selesai">Ya, sudah mendapatkan pelayanan rujukan</option>
                      </select>
                    </Field>
                  </>
                )}
              </div>
            </div>

            {/* Fasilitasi Bantuan Sosial */}
            <div className="sub-section">
              <h3 className="sub-title">3. Fasilitasi Penerimaan Bantuan Sosial</h3>
              <div className="fields-grid">
                <Field label="Apakah perlu difasilitasi bantuan sosial?">
                  <select name="fasilitasiBansos" value={formData.fasilitasiBansos} onChange={handleChange}>
                    <option value="">-- Pilih --</option>
                    <option value="Ya">Ya, perlu difasilitasi</option>
                    <option value="Sudah dapat">Sudah mendapatkan bantuan sosial</option>
                    <option value="Tidak perlu">Tidak perlu / tidak memenuhi syarat</option>
                  </select>
                </Field>
                {formData.fasilitasiBansos === 'Sudah dapat' && (
                  <Field label="Program Bantuan Sosial yang diterima">
                    <select name="bansosProgram" value={formData.bansosProgram} onChange={handleChange}>
                      <option value="">-- Pilih --</option>
                      <option value="PKH">Program Keluarga Harapan (PKH)</option>
                      <option value="BPNT">Bantuan Pangan Non Tunai (BPNT)</option>
                      <option value="PIP">Program Indonesia Pintar (PIP)</option>
                      <option value="KIS">Kartu Indonesia Sehat (KIS)</option>
                      <option value="Lainnya">Lainnya</option>
                    </select>
                  </Field>
                )}
              </div>
            </div>
          </section>

          {/* ====== I. HASIL SURVEILANS ====== */}
          <section className="card">
            <h2 className="card-title">I. Hasil Surveilans &amp; Pemantauan</h2>
            <div className="fields-grid">
              <Field label="Hadir ke Posyandu/BKB bulan ini?">
                <select name="hadirPosyandu" value={formData.hadirPosyandu} onChange={handleChange}>
                  <option value="">-- Pilih --</option>
                  <option value="Ya">Ya</option>
                  <option value="Tidak">Tidak</option>
                </select>
              </Field>
              <Field label="Teridentifikasi faktor risiko stunting?">
                <select name="teridentifikasiRisiko" value={formData.teridentifikasiRisiko} onChange={handleChange}>
                  <option value="">-- Pilih --</option>
                  <option value="Ya">Ya, teridentifikasi berisiko</option>
                  <option value="Tidak">Tidak ada indikasi risiko</option>
                </select>
              </Field>
            </div>
          </section>

          {/* ====== J. DATA KUNJUNGAN ====== */}
          <section className="card">
            <h2 className="card-title">J. Data Kunjungan</h2>
            <div className="fields-grid">
              <Field label="Tanggal Kunjungan" required>
                <input type="date" name="tanggalKunjungan" value={formData.tanggalKunjungan} onChange={handleChange} />
              </Field>
              <Field label="Tanggal Kunjungan Berikutnya">
                <input type="date" name="tanggalKunjunganBerikutnya" value={formData.tanggalKunjunganBerikutnya} onChange={handleChange} />
              </Field>
              <Field label="Catatan TPK (opsional)">
                <input name="catatanTPK" value={formData.catatanTPK} placeholder="Catatan tambahan dari kunjungan ini" onChange={handleChange} />
              </Field>
            </div>
          </section>

          <div className="form-actions">
            <button type="submit" className="btn-submit" disabled={loading}>
              {loading ? 'Mengirim data...' : 'Simpan Data Pendampingan'}
            </button>
          </div>
        </form>

        <footer className="gov-footer">
          Aplikasi Pendataan Pendampingan Keluarga — Tim Pendamping Keluarga (TPK) &middot; Berdasarkan SE BKKBN No. 12 Tahun 2024
        </footer>
      </main>
    </div>
  );
};

export default FormPendampingan;
