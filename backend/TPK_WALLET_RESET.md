# Reset wallet kader TPK

Reset password tidak dapat membuka private key yang terkunci di backup lama. Fitur ini mengganti wallet kader dengan wallet baru; alamat lama dan alamat baru dicatat di `tpk_wallet_history`, sedangkan catatan pendampingan yang sudah ada tetap menyimpan wallet penulis semula.

## Persiapan deployment

1. Jalankan migrasi `sql/003_tpk_wallet_reset.sql` pada database.
2. Jalankan panel lokal dengan `npm --prefix backend run funding:admin` atau VS Code task **Funding Admin TPK**.
3. Klik **Buat secret reset**. Panel membuat secret acak 256-bit, menyimpannya di `backend/.env`, menambahkannya sebagai secret Vercel Production, lalu men-deploy ulang backend.
4. Salin secret yang ditampilkan satu kali dan simpan di pengelola kata sandi operator. Tombol ini merotasi secret sebelumnya, sehingga nilai lama tidak berlaku. Jangan kirim secret kepada kader, simpan di frontend, atau commit.

Jika sinkronisasi/deploy Vercel gagal, panel tetap menampilkan secret hasil pembuatan untuk disimpan. Ikuti pesan status panel sebelum menerbitkan kode: backend Production belum tentu sudah memakai secret baru.

## Menerbitkan kode

Verifikasi identitas kader secara langsung sebelum menerbitkan kode. Kode hanya berlaku 15 menit, hanya berlaku untuk NIK tersebut, dan kode baru membatalkan kode sebelumnya yang belum dipakai.

Pada panel lokal **Funding Admin TPK**, masukkan NIK yang sudah diverifikasi lalu pilih **Terbitkan kode kader**. Panel menggunakan secret operator di server lokal untuk meminta kode dari backend Production; secret operator tidak dikirim ke browser. Salin kode satu kali yang ditampilkan ke kolom **Kode reset operator** di halaman login kader.

Berikan `resetCode` dari respons hanya kepada kader yang identitasnya sudah diverifikasi. Kode tidak dapat dilihat kembali dari database karena yang disimpan hanya hash-nya.

## Reset oleh kader

Kader memverifikasi NIK di halaman login, membuka **Lupa password? Reset wallet dengan kode operator**, memasukkan kode tersebut, lalu memilih password baru. Browser membuat dan mengenkripsi wallet baru; private key tidak dikirim ke server. Kader perlu menyimpan file backup yang otomatis diunduh. Kode yang kedaluwarsa atau sudah dipakai harus diterbitkan ulang oleh operator.
