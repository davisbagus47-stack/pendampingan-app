# Penilaian Check-Per-Item DataAnchor (Pendampingan App)

Dokumen ini menjawab checklist yang diminta untuk keperluan penilaian/prototipe. Berdasarkan kode dan arsitektur saat ini, berikut status, bukti di repo, serta langkah verifikasi yang perlu dilakukan.

## Daftar Poin

| No | Aspek yang diuji | Hasil penilaian | Bukti di kodebase | Dokumentasi/bukti yang perlu diambil saat pengujian |
|---|---|---|---|---|
| 1 | Hubungan DataAnchor dengan aplikasi administrasi | Sudah terintegrasi | backend/index.js: POST /api/submit memanggil catatRecordForm() yang menulis records + chain_outbox lalu anchorkanRecord(kilat). POST /api/v1/records menulis transaksi lalu anchorkanRecord() setelah commit. backend/lib/anchor-record.js + anchor-chain.js. | Foto 6: Log route -> outbox -> anchor call, respons berisi tx_hash/status. Samarkan kredensial/token. |
| 2 | Pengambilan data dari database | Sudah (bergantung alur UI) | catatRecordForm membangun dari body form via recordsWrite.bangunRecord. POST /api/submit menerima payload dari frontend. Ada sheets_pending + cron sheets-flush untuk mirror async ke Google Sheets. | Foto 7: Tunjukkan payload dikirim dari aplikasi (dari sumber terpilih) tanpa copy-paste manual. Bandingkan dengan data terproses di records. |
| 3 | Pembentukan hash dari data aplikasi | Sudah | backend/lib/canonical.js: recordHash = SHA-256(canonicalize(normalizeRecord(payload))). Normalisasi numerik + FORCED_TEXT, JCS, SCHEMA_VERSION 2. | Foto 8: Payload mentah, hasil normalisasi/JCS, dan record_hash. |
| 4 | Integrasi pencatatan bukti ke blockchain | Sudah (mode hybrid) | POST /api/v1/records: sinkron setelah commit. POST /api/submit: mode kilat (tx_hash langsung) lalu difinalisasi oleh GET /api/cron/anchor via tools/worker-anchor.js. Kontrak DataAnchor.sol. | Foto 9: Alur aplikasi yang memicu, log outbox, tx_hash, bukti Sepolia Explorer. Bedakan dari uji manual. |
| 5 | Verifikasi integritas data | Sudah | GET /api/v1/audit/proof, GET /api/v1/audit/reconcile, GET /api/v1/audit/zkp-proof. record_hash deterministik. | Foto 10: Data utuh vs data diubah 1 nilai; bandingkan hash (cocok/tidak cocok). |
| 6 | Keterhubungan dengan proses pembaruan bulanan | Sudah | POST /api/v1/records mode correct: baca versi lama, version++, supersedes_id, outbox baru. metaRantai kirim old_record_id/old_version sebagai leluhur ke kontrak. | Foto 11: v1 vs v2, supersedes_id, leluhur, tx_hash, hasil verifikasi. |
| 7 | Integritas dan keamanan integrasi | Sudah (desain) | Hanya commitment = SHA-256(record_hash || institution_key) + kategori + leluhur yang dikirim ke chain. PII di DB/Sheets. RLS, API key, rate limit, CRON_SECRET, JALUR_PUBLIK terbatas, access log. | Foto 12: Diagram alur (DB/Sheets vs Sepolia) menunjukkan hanya bukti digital yang dikirim, bukan PII mentah. |

## Catatan
- Untuk poin 2: pastikan frontend mengirim payload baris terpilih (bukan copy-paste manual).
- Untuk poin 4: bedakan pemicu dari aplikasi vs manual.
- Butuh env: DATABASE_URL, agencies ter-seed, ANCHOR_RPC_URL/ANCHOR_CONTRACT/ANCHOR_PRIVATE_KEY, CRON_SECRET.

**Kesimpulan:** Sistem sudah bisa untuk mengisi checklist ini; yang dibutuhkan adalah bukti alur/log saat pengujian.
