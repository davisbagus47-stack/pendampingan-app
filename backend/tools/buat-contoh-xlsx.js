const fs = require('fs');
const { bangunXlsx } = require('C:/Users/davis/pendampingan-app/backend/lib/xlsx-export.js');

const header = [
  'No', 'NIK', 'Nama Lengkap', 'Tanggal Kunjungan',
  'Nama Ayah', 'Catatan TPK', 'Bobot Skor'
];

const baris = [
  [1, '3201010101800001', 'Siti Aminah', '2026-01-15', 'Budi Santoso', 'Kunjungan rutin, tidak ada kendala.', 8],
  [2, '3273010202850002', 'Agus Salim', '15/01/2026', 'Rahmat Hidayat', 'ButuhLW', 6],
  [3, '3374090903900003', 'Dewi Lestari', '03/04/2024', 'Suryo WIB', '=HYPERLINK("http://contoh.example/klik","KLIK DI SINI")', 7],
  [4, '3517011104950004', 'Bambang Prasetyo', '+62 812-3456-7890', 'Wahyu Adi', 'Nomor diawali tanda plus', 5],
  [5, '3372101507880005', 'Sri Wahyuni', '@SUM(A1:A5)', 'Tegoarto', 'Isian diawali tanda at', 9]
];

(async () => {
  const buf = await bangunXlsx(header, baris, { namaSheet: 'Data Sasaran' });
  const out = 'C:/Users/davis/pendampingan-app/Uji-XLSX-sasaran.xlsx';
  fs.writeFileSync(out, Buffer.from(buf));
  console.log('file dibuat: Uji-XLSX-sasaran.xlsx (' + buf.length + ' byte)');
  console.log('kolom: ' + header.length + ', baris data: ' + baris.length);
})().catch((e) => { console.error(e); process.exit(1); });