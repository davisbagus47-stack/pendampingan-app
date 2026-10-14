'use strict';

/**
 * Sumber test vector untuk F1.10.
 *
 * Daftar kasus di sini; `tools/lock-vectors.js` mengubahnya menjadi
 * `tests/vectors.json`, dan `tools/test-canonical.js` memeriksa hasil beku itu.
 *
 * Vektor sengaja memuat kasus yang mudah disalahartikan:
 *   - field numerik dengan ejaan berbeda tapi nilai sama (harus hash sama)
 *   - NIK dengan nol di depan (harus tetap berbeda, tidak boleh jadi angka)
 *   - null vs string kosong (harus berbeda)
 *   - field absen vs field kosong (harus berbeda)
 *
 * Vektor yang "hashnya sama" sengaja dikelompokkan supaya regresi pada
 * normalisasi terlihat sebagai kegagalan, bukan sebagai test yang bisa
 * dilewati begitu saja.
 */

module.exports = [
  { name: 'payload kosong', payload: {} },

  {
    name: 'Catin lengkap',
    payload: {
      jenisSasaran: 'Catin',
      nik: '3273011234560001',
      namaLengkap: 'Siti Aminah',
      namaDesa: 'Sukamaju',
      tanggalKunjungan: '2026-09-29',
    },
  },

  {
    name: 'Ibu Hamil;kolom pengukuran',
    payload: {
      jenisSasaran: 'Ibu Hamil',
      nik: '3273011234560002',
      namaLengkap: 'Dewi Lestari',
      usia: '28',
      usiaKehamilan: '24',
      hpht: '2025-11-02',
      bbSebelumHamil: '55',
      bbSekarang: '62,5',
      tfu: '24',
    },
  },

  { name: 'numerik ejaan koma;70,00', payload: { bbSekarang: '70,00' } },
  { name: 'numerik ejaan titik;70.0', payload: { bbSekarang: '70.0' } },
  { name: 'numerik ejaan ringkas;70', payload: { bbSekarang: '70' } },

  { name: 'NIK nol di depan;...890', payload: { nik: '0071234567890' } },
  { name: 'NIK nol di depan;...891', payload: { nik: '0071234567891' } },

  { name: 'null pada field', payload: { namaAyah: null } },
  { name: 'string kosong pada field', payload: { namaAyah: '' } },

  { name: 'string dengan spasi luar', payload: { namaLengkap: '  Jakarta  ' } },
  { name: 'string tanpa spasi luar', payload: { namaLengkap: 'Jakarta' } },

  {
    name: 'dua field lintas section',
    payload: {
      terpaparRokok: 'Ya',
      catatanTPK: 'Perlu kunjungan ulang',
    },
  },

  { name: 'nilai unicode', payload: { namaLengkap: 'Siti Aminah' } },
  { name: 'nilai bertanda baca', payload: { alamat: 'Jl. Merdeka No. 3 RT 04/05' } },
  { name: 'RW alphanumeric', payload: { rw: '0A', rt: '005' } },
];
