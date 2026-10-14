/**
 * Ekspor XLSX (F3.10b, FR-4.8).
 *
 * Menghasilkan satu worksheet berisi tabel data. Baris pertama adalah header,
 * baris berikutnya data, urutan kolom mengikuti `header`.
 *
 * Mengachatatan penting soal keamanan: exceljs memperlakukan sel yang diawali
 * `=`, `+`, `-`, atau `@` sebagai FORMULA. Data yang berasal dari isian operator
 * di spreadsheet TPK sepenuhnya dikendalikan pemohon, jadi tanpa penanganan
 * khusus sebuah isian `=HYPERLINK("http://evil","klik")` akan dieksekusi
 * spreadsheet ketika operator membukanya. Ini adalah CSV injection yang tetap
 * hidup meski sudah pakai XLSX, dan lebih berbahaya karena formula
 * dieksekusi spreadsheet tanpa disadari.
 * Karena itu SEMUA sel ditulis sebagai teks. Konsekuensinya angka tidak lagi
 * dihitung ulang oleh Excel -- dan itu pilihan yang benar di sini: kolom ini
 * berisi NIK, tanggal kunjungan, dan kode desa, bukan angka untuk dijumlahkan.
 * Memromise integritas data lebih penting daripada tampilan.
 */

const ExcelJS = require('exceljs');

/**
 * Nilai sel yang aman untuk ditulis tanpa menjadi formula.
 *
 * Awalan formula adalah karakter yang membuat Excel menafsirkan isi sel
 * sebagai ekspresi. Menempelkan tanda kutip tunggal adalah cara yang
 * dipahami semua versi Excel, termasuk yang membaca berkas ini.
 *
 * @param {*} v nilai sel mentah
 * @returns {string} teks yang aman ditulis
 */
function selAman(v) {
  if (v === undefined || v === null) return '';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return s;
}

/**
 * Bangun berkas XLSX dari header dan baris data.
 *
 * @param {string[]} header label kolom, urutan sudah final
 * @param {Array<Array<*>>} baris data, setiap baris sepanjang `header`
 * @param {object} [opsi]
 * @param {string} [opsi.namaSheet] nama worksheet, maksimal 31 karakter
 * @returns {Promise<Buffer>} isi berkas .xlsx
 */
async function bangunXlsx(header, baris, opsi) {
  const o = opsi || {};
  const wb = new ExcelJS.Workbook();

  // Nama sheet dipotong ke 31 karakter karena Excel lebih pendek daripada yang
  // dibiarkan sebagian pembaca file, dan nama yang terpotong diam-diam lebih
  // sulit didiagnosis daripada yang ditolak.
  const nama = String(o.namaSheet || 'Data').slice(0, 31).replace(/[\\/*?:[\]]/g, '_');
  const ws = wb.addWorksheet(nama || 'Data');

  if (header && header.length > 0) {
    const barisHeader = ws.addRow(header.map(selAman));
    barisHeader.font = { bold: true };
    // Beku baris header: data bisa panjang sekali, dan tanpa beku operator
    // harus menggulir ke atas untuk tahu kolom apa yang sedang dibaca.
    ws.views = [{ state: 'frozen', ySplit: 1 }];
  }

  // Lebar baris dipaksa sama dengan lebar header. Baris yang lebih lebar akan
  // menulis sel di kolom tanpa label: operator tetap bisa mengetuk kolom itu
  // dan membaca isinya, hanya tidak tahu apa arti kolomnya. Ini jalur kebocoran
  // yang lolos karena tidak terlihat di header.
  // Tanpa header tidak ada lebar yang bisa dijadikan acuan, jadi baris dibiarkan
  // apa adanya.
  const adaHeader = Boolean(header && header.length);
  const lebar = adaHeader ? header.length : 0;
  for (const b of baris || []) {
    const sel = (b || []).map(selAman);
    if (adaHeader) {
      sel.length = lebar;
      while (sel.length < lebar) sel.push('');
    }
    ws.addRow(sel);
  }

  // Lebar kolom berdasarkan isi. Tanpa ini Excel memakai lebar baku dan kolom
  // tanggal/NIK terpotong jadi `#####`, yang terlihat seperti data hilang.
  const semua = (header || []).map(selAman).concat(
    (baris || []).slice(0, 200).map((b) => (b || []).map(selAman))
  );
  for (let c = 0; c < (header || []).length; c++) {
    let lebar = 8;
    for (const b of semua) {
      const v = b[c] === undefined ? '' : String(b[c]);
      if (v.length > lebar) lebar = v.length;
    }
    ws.getColumn(c + 1).width = Math.min(lebar + 2, 60);
  }

  return wb.xlsx.writeBuffer();
}

module.exports = {
  bangunXlsx,
  selAman,
};
