"""JCS_reference.py -- implementasi JCS rujukan di Python, untuk cross-validation.

Tujuan alat ini BUKAN menggantikan RFC 8785 Appendix B. Tujuannya adalah
memberiimplementasi kedua yang menulis kodenya sendiri, sehingga bug yang
sama tidak mungkin terjadi di kedua tempat.

Yang benar-benar independen di sini:
  - pengurutan kunci (Python `sorted` vs perbandingan manual di Node)
  - pemisah dan tanpa whitespace
  - escaping string dan karakter non-ASCII yang dibiarkan apa adanya
  - penanganan nesting

Yang TIDAK independen: format angka. `json.dumps` Python tidak sama dengan
`Number::toString` ECMAScript yang diminta RFC 8785, jadi `es_number()` di bawah
adalah implementasi ulang Number::toString -- dikode ulang dari spesifikasi,
bukan disalin dari lib/jcs.js. Vektor angka resmi RFC 8785 yang diuji di
test-canonical.js tetap satu-satunya bukti otoritatif untuk bagian ini.
"""

import json
import re
import sys


def es_number(v):
    """Number::toString, versi ECMAScript, untuk float dan int Python."""
    if isinstance(v, bool):
        raise TypeError("bool bukan angka")
    if isinstance(v, int):
        return str(v)
    if v != v or v in (float("inf"), float("-inf")):
        raise ValueError("angka harus finite")
    if v == 0:
        return "0"          # mencakup -0.0
    r = repr(v)
    if r.endswith(".0"):
        return r[:-2]
    # Python mengisi eksponen dengan nol di depan ("1e-07"); ECMAScript tidak
    # ("1e-7"). Samakan.
    r = re.sub(r"e([+-])0(\d)$", r"e\g<1>\2", r)
    # Python memakai ".0" pada eksponen ("1.0e+21"); ECMAScript tidak.
    r = re.sub(r"\.0e", "e", r)
    return r


def jcs_string(s):
    # ensure_ascii=False: karakter non-ASCII dibiarkan apa adanya, seperti JCS.
    return json.dumps(s, ensure_ascii=False)


def jcs(v):
    if v is None:
        return "null"
    if v is True:
        return "true"
    if v is False:
        return "false"
    if isinstance(v, str):
        return jcs_string(v)
    if isinstance(v, (int, float)):
        return es_number(v)
    if isinstance(v, list):
        return "[" + ",".join("null" if x is None else jcs(x) for x in v) + "]"
    if isinstance(v, dict):
        keys = sorted(v.keys())
        return "{" + ",".join(jcs_string(k) + ":" + jcs(v[k]) for k in keys) + "}"
    raise TypeError("tipe tidak didukung: " + type(v).__name__)


if __name__ == "__main__":
    # stdout Windows default-nya cp1252 dan tidak bisa menulis U+0080 atau
    # karakter non-Latin. Paksa UTF-8 supaya perbandingan byte fair.
    sys.stdout.reconfigure(encoding="utf-8", newline="")
    data = json.loads(sys.stdin.read())
    sys.stdout.write(jcs(data))
