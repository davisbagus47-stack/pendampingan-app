import React, { useState } from 'react';
import axios from 'axios';
import './FormPendampingan.css';

const API_URL = process.env.REACT_APP_API_URL || window.location.origin;

const OPSI_PENDAMPINGAN = [
  'Pemberian Makanan Tambahan (PMT)',
  'Suplementasi Tablet Tambah Darah (TTD)',
  'Konseling Gizi',
  'Stimulasi Anak',
  'Rujukan ke Fasilitas Kesehatan',
  'Pemantauan Tumbuh Kembang',
  'Kunjungan Rumah',
];

const FORM_AWAL = {
  namaTPK: '',
  rw: '',
  rt: '',
  namaPosyandu: '',
  nik: '',
  noKK: '',
  namaKK: '',
  namaIstri: '',
  namaSasaran: '',
  jenisSasaran: '',
  tanggalLahir: '',
  jenisKelamin: '',
  pekerjaan: '',
  keteranganPekerjaan: '',
  sumberAir: '',
  jamban: '',
  terlalu: '',
  bukanPesertaKB: '',
  jenisKB: '',
  bpjsStatus: '',
  jenisBPJS: '',
  rencanaKehamilan: '',
  dtks: '',
  resikoStunting: '',
  produkUsaha: '',
  pendampingan: [],
  bulanTahun: '',
  hadirPosy: '',
  kunjunganRumah: '',
  resiko: '',
  bb: '',
  tb: '',
  mms: ''
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

  const handleCheckbox = (e) => {
    const { value, checked } = e.target;
    setFormData(prev => ({
      ...prev,
      pendampingan: checked
        ? [...prev.pendampingan, value]
        : prev.pendampingan.filter(item => item !== value)
    }));
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

  return (
    <div className="gov-page">
      <header className="gov-header">
        <div className="gov-header-topline"></div>
        <div className="gov-header-inner">
          <div className="gov-brand">
            <div className="gov-emblem">TPK</div>
            <div>
              <h1>Pendampingan Keluarga Berisiko Stunting</h1>
              <p>Tim Pendamping Keluarga (TPK) — Pencegahan Stunting</p>
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

          <section className="card">
            <h2 className="card-title">A. Data Petugas TPK</h2>
            <div className="fields-grid">
              <Field label="Nama TPK" required>
                <input name="namaTPK" value={formData.namaTPK} placeholder="Nama pendamping TPK" onChange={handleChange} />
              </Field>
              <Field label="RW">
                <input name="rw" value={formData.rw} placeholder="Contoh: 01" onChange={handleChange} />
              </Field>
              <Field label="RT">
                <input name="rt" value={formData.rt} placeholder="Contoh: 02" onChange={handleChange} />
              </Field>
              <Field label="Nama Posyandu">
                <input name="namaPosyandu" value={formData.namaPosyandu} placeholder="Nama posyandu" onChange={handleChange} />
              </Field>
            </div>
          </section>

          <section className="card">
            <h2 className="card-title">B. Data Keluarga</h2>
            <div className="fields-grid">
              <Field label="NIK" required>
                <input name="nik" value={formData.nik} placeholder="16 digit NIK" maxLength={16} inputMode="numeric" onChange={handleChange} />
              </Field>
              <Field label="Nomor Kartu Keluarga">
                <input name="noKK" value={formData.noKK} placeholder="16 digit No. KK" maxLength={16} inputMode="numeric" onChange={handleChange} />
              </Field>
              <Field label="Nama Kepala Keluarga">
                <input name="namaKK" value={formData.namaKK} placeholder="Nama kepala keluarga" onChange={handleChange} />
              </Field>
              <Field label="Nama Istri">
                <input name="namaIstri" value={formData.namaIstri} placeholder="Nama istri" onChange={handleChange} />
              </Field>
            </div>
          </section>

          <section className="card">
            <h2 className="card-title">C. Data Sasaran</h2>
            <div className="fields-grid">
              <Field label="Nama Sasaran" required>
                <input name="namaSasaran" value={formData.namaSasaran} placeholder="Nama sasaran pendampingan" onChange={handleChange} />
              </Field>
              <Field label="Jenis Sasaran" required>
                <select name="jenisSasaran" value={formData.jenisSasaran} onChange={handleChange}>
                  <option value="">-- Pilih --</option>
                  <option value="Catin">Calon Pengantin</option>
                  <option value="Ibu Hamil">Ibu Hamil</option>
                  <option value="Ibu Nifas">Ibu Nifas</option>
                  <option value="Balita">Balita</option>
                </select>
              </Field>
              <Field label="Tanggal Lahir">
                <input type="date" name="tanggalLahir" value={formData.tanggalLahir} onChange={handleChange} />
              </Field>
              <Field label="Jenis Kelamin">
                <select name="jenisKelamin" value={formData.jenisKelamin} onChange={handleChange}>
                  <option value="">-- Pilih --</option>
                  <option value="L">Laki-laki</option>
                  <option value="P">Perempuan</option>
                </select>
              </Field>
              <Field label="Pekerjaan">
                <input name="pekerjaan" value={formData.pekerjaan} placeholder="Pekerjaan sasaran" onChange={handleChange} />
              </Field>
              <Field label="Keterangan Tempat Kerja">
                <input name="keteranganPekerjaan" value={formData.keteranganPekerjaan} placeholder="Keterangan tempat kerja" onChange={handleChange} />
              </Field>
            </div>
          </section>

          <section className="card">
            <h2 className="card-title">D. Kondisi Rumah</h2>
            <div className="fields-grid">
              <Field label="Sumber Air">
                <select name="sumberAir" value={formData.sumberAir} onChange={handleChange}>
                  <option value="">-- Pilih --</option>
                  <option value="PAM / PDAM">PAM / PDAM</option>
                  <option value="Sumur">Sumur</option>
                  <option value="Air Isi Ulang">Air Isi Ulang</option>
                  <option value="Sungai">Sungai</option>
                  <option value="Lainnya">Lainnya</option>
                </select>
              </Field>
              <Field label="Jamban">
                <select name="jamban" value={formData.jamban} onChange={handleChange}>
                  <option value="">-- Pilih --</option>
                  <option value="Sehat">Sehat</option>
                  <option value="Tidak Sehat">Tidak Sehat</option>
                  <option value="Tidak Ada">Tidak Ada</option>
                </select>
              </Field>
              <Field label="Kategori 4T (Terlalu)">
                <input name="terlalu" value={formData.terlalu} placeholder="Usia / jumlah anak / jarak terlalu dekat" onChange={handleChange} />
              </Field>
            </div>
          </section>

          <section className="card">
            <h2 className="card-title">E. Status Sosial &amp; Kesehatan</h2>
            <div className="fields-grid">
              <Field label="Terdaftar di DTKS?">
                <select name="dtks" value={formData.dtks} onChange={handleChange}>
                  <option value="">-- Pilih --</option>
                  <option value="Ya">Ya</option>
                  <option value="Tidak">Tidak</option>
                </select>
              </Field>
              <Field label="Keluarga Berisiko Stunting?">
                <select name="resikoStunting" value={formData.resikoStunting} onChange={handleChange}>
                  <option value="">-- Pilih --</option>
                  <option value="Ya">Ya</option>
                  <option value="Tidak">Tidak</option>
                </select>
              </Field>
              <Field label="Status BPJS">
                <select name="bpjsStatus" value={formData.bpjsStatus} onChange={handleChange}>
                  <option value="">-- Pilih --</option>
                  <option value="Aktif">Aktif</option>
                  <option value="Tidak Aktif">Tidak Aktif</option>
                  <option value="Tidak Ada">Tidak Ada</option>
                </select>
              </Field>
              <Field label="Jenis Kepesertaan BPJS">
                <input name="jenisBPJS" value={formData.jenisBPJS} placeholder="PBI JK / BP / mandiri" onChange={handleChange} />
              </Field>
              <Field label="Bukan Peserta KB?">
                <select name="bukanPesertaKB" value={formData.bukanPesertaKB} onChange={handleChange}>
                  <option value="">-- Pilih --</option>
                  <option value="Ya">Ya</option>
                  <option value="Tidak">Tidak</option>
                </select>
              </Field>
              <Field label="Jenis KB">
                <input name="jenisKB" value={formData.jenisKB} placeholder="Jenis kontrasepsi" onChange={handleChange} />
              </Field>
              <Field label="Rencana Kehamilan">
                <select name="rencanaKehamilan" value={formData.rencanaKehamilan} onChange={handleChange}>
                  <option value="">-- Pilih --</option>
                  <option value="Ya">Ya</option>
                  <option value="Tidak">Tidak</option>
                </select>
              </Field>
              <Field label="Jenis Produk Usaha">
                <input name="produkUsaha" value={formData.produkUsaha} placeholder="Jenis usaha keluarga" onChange={handleChange} />
              </Field>
            </div>
          </section>

          <section className="card">
            <h2 className="card-title">F. Pendampingan</h2>
            <div className="fields-grid">
              <div className="field full">
                <label>Jenis Pendampingan</label>
                <div className="checkbox-list">
                  {OPSI_PENDAMPINGAN.map(opsi => (
                    <label key={opsi} className="checkbox-item">
                      <input type="checkbox" value={opsi} checked={formData.pendampingan.includes(opsi)} onChange={handleCheckbox} />
                      {opsi}
                    </label>
                  ))}
                </div>
              </div>
              <Field label="Bulan / Tahun">
                <input type="month" name="bulanTahun" value={formData.bulanTahun} onChange={handleChange} />
              </Field>
            </div>
          </section>

          <section className="card">
            <h2 className="card-title">G. Hasil Pendampingan</h2>
            <div className="fields-grid">
              <Field label="Hadir Posyandu?">
                <select name="hadirPosy" value={formData.hadirPosy} onChange={handleChange}>
                  <option value="">-- Pilih --</option>
                  <option value="Ya">Ya</option>
                  <option value="Tidak">Tidak</option>
                </select>
              </Field>
              <Field label="Kunjungan Rumah?">
                <select name="kunjunganRumah" value={formData.kunjunganRumah} onChange={handleChange}>
                  <option value="">-- Pilih --</option>
                  <option value="Ya">Ya</option>
                  <option value="Tidak">Tidak</option>
                </select>
              </Field>
              <Field label="Teridentifikasi Berisiko?">
                <select name="resiko" value={formData.resiko} onChange={handleChange}>
                  <option value="">-- Pilih --</option>
                  <option value="Ya">Ya</option>
                  <option value="Tidak">Tidak</option>
                </select>
              </Field>
              <Field label="Berat Badan (kg)">
                <input name="bb" value={formData.bb} placeholder="0.0" type="number" step="0.1" min="0" onChange={handleChange} />
              </Field>
              <Field label="Tinggi Badan (cm)">
                <input name="tb" value={formData.tb} placeholder="0.0" type="number" step="0.1" min="0" onChange={handleChange} />
              </Field>
              <Field label="LILA / MMS (cm)">
                <input name="mms" value={formData.mms} placeholder="0.0" type="number" step="0.1" min="0" onChange={handleChange} />
              </Field>
            </div>
          </section>

          <div className="form-actions">
            <button type="submit" className="btn-submit" disabled={loading}>
              {loading ? 'Mengirim data...' : 'Simpan Data'}
            </button>
          </div>
        </form>

        <footer className="gov-footer">
          Aplikasi Pendataan Pendampingan Keluarga — Tim Pendamping Keluarga (TPK)
        </footer>
      </main>
    </div>
  );
};

export default FormPendampingan;