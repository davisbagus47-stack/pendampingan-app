#!/usr/bin/env python3
"""
verify_commitment.py -- verifier `record_hash` mandiri, tanpa pustaka proyek.

Ini adalah bukti operasional dari keputusan F0.4: instance mana pun, dengan
bahasa apa pun, harus dapat menghitung ulang `record_hash` dari payload dan
mendapat nilai yang sama. Skrip ini sengaja TIDAK mengimpor apa pun dari
`backend/lib/`. Yang dipakainya hanya pustaka standar Python.

    python tools/verify_commitment.py payload.json
    echo '{"nik":"3273011234560001"}' | python tools/verify_commitment.py

Yang dihitung:

    record_hash = SHA-256( UTF8( JCS( normalize(payload) ) ) )

Normalisasi (lihat keputusan-kanonikalisasi.md §3.2):
  - semua nilai jadi string, string di-trim
  - field bertipe numerik dibulatkan ke skala kolom -> satu representasi
  - `null` tetap `null`, `""` tetap `""` (keduanya tidak disamakan)
  - NIK/No. KK/RW/RT tidak pernah jadi angka

Daftar field di bawah harus sama dengan `NUMERIC_FIELDS` dan `FORCED_TEXT` di
`backend/lib/field-types.js`. `tools/test-roundtrip.js` membandingkannya, jadi
menambah kolom numerik tanpa memperbarui skrip ini akan menggagalkan uji.
"""

import hashlib
import json
import re
import sys

# NUMERIC(4,1), NUMERIC(5,1), NUMERIC(8,1) -> skala 1; INTEGER -> skala 0.
SCALE_BY_FIELD = {
    "pendampinganKe": 0,
}
DEFAULT_SCALE = 1

NUMERIC_FIELDS = {
    "usia", "usiaKehamilan", "bbSebelumHamil", "bbSekarang", "tb", "lila",
    "hb", "tfu", "tbj", "umurBayi", "bbLahir", "pbLahir", "pendampinganKe",
}

# Wajib teks meski tampak angka: nol di depan dan huruf adalah bagian identitas.
FORCED_TEXT_FIELDS = {"nik", "noKK", "nikAyah", "nikIbu", "rw", "rt"}

# Angka opsional, satuan diizinkan ("160 cm", "62,5 kg").
_NUMBER_RE = re.compile(r"^([+-]?[0-9]*[.,]?[0-9]+)\s*[a-zA-Z%]*$")


def normalize_scalar(field, value):
    if value is None:
        return None
    if isinstance(value, bool):
        # `tombol()` di index.js memakai String(v), jadi bool jadi teks.
        return "true" if value else "false"
    if field in FORCED_TEXT_FIELDS:
        return str(value).strip()
    if field in NUMERIC_FIELDS:
        text = str(value).strip()
        if text == "":
            return text
        m = _NUMBER_RE.match(text)
        if not m:
            return text
        n = float(m.group(1).replace(",", "."))
        scale = SCALE_BY_FIELD.get(field, DEFAULT_SCALE)
        factor = 10 ** scale
        r = round(n * factor) / factor
        if r == int(r):
            return str(int(r))
        return str(r)
    return str(value).strip()


def normalize_record(payload):
    out = {}
    for k, v in payload.items():
        out[k] = normalize_scalar(k, v)
    return out


def record_hash(payload):
    from JCS_reference import jcs  # noqa: E402  (selalu lokal, tanpa dependensi luar)
    canonical = jcs(normalize_record(payload))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def commitment(record_hash_hex, institution_key):
    """ADR-3: commitment_X = SHA256(record_hash || institution_X).

    institution_key adalah agencies.institution_key, yaitu X pada commitment_X.
    Penolakan nilai kosong dan non-string sengaja ditiru persis dari
    lib/canonical.js: String(None) adalah "None" dan String(None) yang lolos
    uji "tidak kosong" akan menghasilkan commitment yang terikat ke literal itu.
    """
    if not isinstance(institution_key, str) or institution_key.strip() == "":
        raise ValueError(
            "institution_key wajib berupa string yang tidak kosong (AT-09)"
        )
    # record_hash_hex harus hex 64 karakter. Tanpa ini,obejek apa pun yang bisa
    # diubah jadi string akan menghasilkan commitment berbentuk 64 hex yang
    # terlihat sah -- termasuk kesalahan `commitment(payload, key)`.
    if not isinstance(record_hash_hex, str) or not re.fullmatch(
        r"[0-9a-fA-F]{64}", record_hash_hex.strip()
    ):
        raise ValueError(
            "record_hash_hex harus string hex 64 karakter; kalau Anda punya "
            "payload, pakai record_hash(payload) lebih dulu"
        )
    # Huruf besar-hex adalah hash yang sama, hanya beda presentasi.
    material = record_hash_hex.strip().lower() + institution_key
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


def main(argv):
    args = argv[1:]
    institution = None
    if args and args[0] == "--institution":
        if len(args) < 2:
            print("--institution butuh nilai.", file=sys.stderr)
            return 2
        institution = args[1]
        args = args[2:]

    if args:
        with open(args[0], "r", encoding="utf-8") as fh:
            raw = fh.read()
    else:
        raw = sys.stdin.read()

    if not raw.strip():
        print("Payload kosong; baca dari file argumen atau stdin.", file=sys.stderr)
        return 2

    payload = json.loads(raw)
    if not isinstance(payload, dict):
        print("Payload harus object JSON.", file=sys.stderr)
        return 2

    rh = record_hash(payload)
    if institution is None:
        print(rh)
        return 0

    try:
        print(commitment(rh, institution))
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.path.insert(0, __file__.rsplit("\\", 1)[0].rsplit("/", 1)[0])
    sys.exit(main(sys.argv))
