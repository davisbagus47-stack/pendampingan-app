#!/usr/bin/env python3
"""
Contoh integrasi Python (FR-4.15) + verifikasi commitment (FR-4.14).

Setara dengan `contoh-integrasi-javascript.js`, memakai pustaka standar saja.
Rumus `record_hash`/`commitment` diambil dari `verify_commitment.py` (verifier
mandiri yang sudah dipakai untuk membuktikan kanonikalisasi lintas bahasa),
supaya tidak ada implementasi kedua yang bisa menyimpang.

Alur:
  1. Tarik satu halaman GET /api/v1/records memakai kunci API instansi.
  2. Tangani penolakan lewat `code` mesinnya.
  3. Verifikasi tiap baris: SHA-256( hex(record_hash) + institution_id ) == commitment.
  4. Bila PA_PAYLOAD diisi, hitung ulang record_hash dari payload lokal dan
     bandingkan -- bukti isi data identik dengan yang tercatat resmi.

Pemakaian (dari direktori `backend/`):

    PA_BASE_URL=http://127.0.0.1:8080 PA_API_KEY=pa_sk_live_xxx PA_KATEGORI=Catin \
      python tools/contoh-integrasi-python.py

Keluar 0 bila berhasil, non-nol bila gagal.
"""

import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import verify_commitment as vc  # noqa: E402

HEX64 = re.compile(r"[0-9a-fA-F]{64}")

PENANGANAN = {
    "AUTH_REQUIRED": "Kunci API tidak valid atau tidak terverifikasi.",
    "MISSING_KEY": "Kirim header Authorization: Bearer <token>.",
    "MALFORMED_KEY": "Format token salah; harus pa_sk_live_<43 karakter>.",
    "UNKNOWN_KEY": "Token tidak dikenal; minta kunci baru ke operator.",
    "KEY_REVOKED": "Kunci sudah dicabut; minta kunci baru.",
    "KEY_STANDBY": "Kunci cadangan belum diaktifkan.",
    "KEY_SCOPE_DENIED": "Kunci ini dibatasi ke kategori/tabel lain.",
    "RATE_LIMITED": "Tunggu Retry-After detik lalu coba lagi (backoff).",
    "CATEGORY_NOT_GRANTED": "Instansi tidak dihibahkan kategori ini.",
    "DESA_NOT_GRANTED": "Desa di luar wilayah instansi.",
    "FIELD_NOT_GRANTED": "Permintaan memuat kolom yang diblokir keras.",
    "FIELD_UNKNOWN": "Ada nama kolom yang tidak ada.",
    "INVALID_PARAM": "Perbaiki nilai parameter yang salah bentuk.",
    "INVALID_FORMAT": "Format harus json, csv, atau xlsx.",
    "DB_UNAVAILABLE": "Database sedang tidak tersedia; coba lagi nanti.",
}


def gagal_keluar(pesan, kode=1):
    sys.stderr.write("GAGAL: " + pesan + "\n")
    sys.exit(kode)


def main():
    base_url = os.environ.get("PA_BASE_URL", "").rstrip("/")
    api_key = os.environ.get("PA_API_KEY", "")
    kategori = os.environ.get("PA_KATEGORI", "")
    payload_raw = os.environ.get("PA_PAYLOAD", "")

    if not base_url:
        gagal_keluar("PA_BASE_URL belum diisi.", 2)
    if not api_key:
        gagal_keluar("PA_API_KEY belum diisi.", 2)

    payload = None
    if payload_raw:
        try:
            payload = json.loads(payload_raw)
        except ValueError as exc:
            gagal_keluar("PA_PAYLOAD bukan JSON yang sah: " + str(exc), 2)

    jalur = "/api/v1/records"
    if kategori:
        jalur += "?kategori_1=" + urllib.parse.quote(kategori)
    url = base_url + jalur
    print("Menarik: " + url)

    req = urllib.request.Request(url, headers={"Authorization": "Bearer " + api_key})
    try:
        with urllib.request.urlopen(req) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = None
        try:
            body = json.loads(exc.read().decode("utf-8"))
        except (ValueError, OSError):
            pass
        kode = (body or {}).get("code") or ("HTTP_%s" % exc.code)
        sys.stderr.write("Permintaan ditolak: %s %s" % (exc.code, kode))
        if body and body.get("message"):
            sys.stderr.write(" -- " + body["message"])
        sys.stderr.write("\n")
        if kode in PENANGANAN:
            sys.stderr.write("Penanganan: " + PENANGANAN[kode] + "\n")
        sys.exit(1)

    baris = body.get("data") if isinstance(body, dict) else None
    if not isinstance(baris, list):
        gagal_keluar("Respons tidak memuat daftar `data`.")
    if len(baris) == 0:
        print("Tidak ada baris untuk diverifikasi (instansi/hibah kosong).")
        return

    ok = 0
    gagal = 0
    for r in baris:
        rid = str(r.get("record_id") or "(tanpa id)")

        if not HEX64.fullmatch(str(r.get("record_hash", ""))):
            sys.stderr.write("  GAGAL %s: record_hash bukan 64 hex.\n" % rid)
            gagal += 1
            continue
        institusi = r.get("institution_id")
        if not isinstance(institusi, str) or institusi.strip() == "":
            sys.stderr.write("  GAGAL %s: institution_id kosong.\n" % rid)
            gagal += 1
            continue

        ulang = vc.commitment(r["record_hash"], institusi)
        if ulang != r.get("commitment"):
            sys.stderr.write("  GAGAL %s: commitment tidak cocok.\n" % rid)
            sys.stderr.write("        tercatat : %s\n" % r.get("commitment"))
            sys.stderr.write("        dihitung : %s\n" % ulang)
            gagal += 1
            continue

        if payload and (
            not payload.get("record_id")
            or str(payload.get("record_id")) == str(r.get("record_id"))
        ):
            hash_lokal = vc.record_hash(payload)
            if hash_lokal != r["record_hash"]:
                sys.stderr.write(
                    "  GAGAL %s: record_hash payload tidak cocok dengan yang tercatat.\n" % rid
                )
                sys.stderr.write("        tercatat : %s\n" % r["record_hash"])
                sys.stderr.write("        dihitung : %s\n" % hash_lokal)
                gagal += 1
                continue

        ok += 1

    print(
        "Diverifikasi %d baris, gagal %d baris.%s"
        % (ok, gagal, " (termasuk record_hash dari payload lokal)" if payload else "")
    )
    if gagal > 0:
        sys.exit(1)
    print("OK: commitment setiap baris konsisten.")


if __name__ == "__main__":
    main()
