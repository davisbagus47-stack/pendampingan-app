# Prosedur Rotasi dan Pencadangan Kunci (F2.10)

## 1. Tujuan
Menjamin keamanan kunci writer/admin kontrak DataAnchor: rotasi terkontrol, pencadangan aman, audit trail, dan mitigasi kehilangan/kompromi kunci.

## 2. Peran
- `DEFAULT_ADMIN_ROLE` — satu atau lebih admin, boleh mengganti role
- `WRITER_ROLE` — relayer/worker yang boleh `anchor()` dan `supersede()`
- Multisig (rekomendasi) untuk admin kritikal

## 3. Pencadangan (pra-deploy & operasional)
- Simpan private key writer hanya di vault terpisah (terpisah dari repo)
- Jangan commit `.env`, mnemonic, keystore
- Buat minimal 2 salinan backup terenkripsi (offline)
- Dokumentasikan alamat: admin, writer, multisig
- Verifikasi alamat sebelum grant/revoke

## 4. Rotasi Kunci Writer
1. Tentukan writer baru `WRITER_NEW`
2. Deploy/update konfigurasi: tambahkan `WRITER_NEW` via admin tx
3. Uji: `anchor()` berhasil via WRITER_NEW (testnet/lokal)
4. Cabut `WRITER_OLD`: `revokeRole(WRITER_ROLE, WRITER_OLD)` via admin tx
5. Verifikasi: `anchor()` via WRITER_OLD gagal (AccessControl)
6. Catat tx hash + timestamp + pelaksana
7. Hapus akses ke WRITER_OLD (vault)

## 5. Rotasi Kunci Admin
1. Gunakan multisig untuk keamanan (rekomendasi)
2. Tambah `ADMIN_NEW` dengan `grantRole(DEFAULT_ADMIN_ROLE, ADMIN_NEW)`
3. Verifikasi kontrol ADMIN_NEW (grant/revoke writer)
4. Cabut `ADMIN_OLD` (hati-hati: pastikan minimal 1 admin aktif)
5. Audit log seluruh aksi
6. Simpan proof rotasi (tx, block, caller)

## 6. Penanganan Kompromi
- Segera revoke role yang dikompromi (admin/writer)
- Pause/pertimbangkan pemindahan jika perlu (sesuai kebijakan)
- Investigasi transaksi dari alamat kompromi (filter event DataAnchored/RecordSuperseded)
- Rotasi semua kunci terkait
- Laporkan & dokumentasi insiden

## 7. Pemeriksaan Sebelum Deploy (F2.6/F2.9–F2.10)
- [ ] Review kode DataAnchor (AccessControl, checks, events)
- [ ] Unit test lolos (F2.5) — `forge test` saat tersedia
- [ ] Alamat terverifikasi & sesuai environment
- [ ] Prosedur rotasi disetujui & didokumentasikan
- [ ] Verifikasi contract di block explorer (F2.9) setelah deploy
- [ ] Backup kunci terenkripsi tersimpan
- [ ] Multisig untuk admin (jika produksi)

## 8. Catatan Teknis
- Event memuat `blockNumber` untuk referensi on-chain
- Duplikasi dicegah via `anchored[key]` (FR-5.3)
- `supersede()` memverifikasi old ter-anchor & new belum ter-anchor
- Role-based access terpisah (admin vs writer)

## 9. Template Catatan Rotasi
```
Tanggal: YYYY-MM-DD
Jenis: writer/admin rotasi
Dari: 0x...
Ke:   0x...
Tx:   0x...
Pelaksana: <nama/role>
Alasan: <rotasi berkala/kompromi>
Disetujui: <tanda tangan>
```
