#!/usr/bin/env python3
"""
Referensi independen untuk pohon Merkle F4.2/F4.3.

Sengaja TIDAK mengimpor apa pun dari `backend/lib/`. Ditulis ulang dari
spesifikasi yang sama (SHA-256, pasangan terurut, pemisahan domain 0x00/0x01)
supaya bisa dipakai sebagai pembanding. Kalau JavaScript dan Python ini
menghasilkan akar yang sama pada pohon yang sama, itu bukti bahwa
spesifikasinya benar -- bukan bukti bahwa satu bug-nya sama.

    python tools/merkle_reference.py leaves.txt            # akar dari daftar hex64
    python tools/merkle_reference.py --proof leaves.txt 2  # bukti inklusi daun ke-2
    python tools/merkle_reference.py --verify ROOT LEAF P...  # verifikasi bukti
"""

import hashlib
import sys

LEAF_PREFIX = b"\x00"
NODE_PREFIX = b"\x01"


def _sha(*parts):
    h = hashlib.sha256()
    for p in parts:
        h.update(p)
    return h.digest()


def hash_leaf(data):
    if isinstance(data, str):
        data = data.encode("utf-8")
    return _sha(LEAF_PREFIX, data)


def hash_node(left_hex, right_hex):
    a = bytes.fromhex(left_hex)
    b = bytes.fromhex(right_hex)
    lo, hi = (a, b) if a <= b else (b, a)
    return _sha(NODE_PREFIX, lo, hi).hex()


def build_levels(leaves):
    if not leaves:
        raise ValueError("pohon tanpa daun tidak punya akar")
    for h in leaves:
        if len(h) != 64:
            raise ValueError("daun harus hex64: " + h)
    levels = [[h.lower() for h in leaves]]
    while len(levels[-1]) > 1:
        row = levels[-1]
        up = []
        for i in range(0, len(row), 2):
            left = row[i]
            right = row[i + 1] if i + 1 < len(row) else left
            up.append(hash_node(left, right))
        levels.append(up)
    return levels


def root_of(leaves):
    return build_levels(leaves)[-1][0]


def proof_for(leaves, index):
    levels = build_levels(leaves)
    if not 0 <= index < len(leaves):
        raise IndexError("indeks di luar jangkauan: %d" % index)
    proof = []
    i = index
    for level in range(len(levels) - 1):
        row = levels[level]
        if i % 2 == 0:
            # Level ganjil: node terakhir diulang, jadi saudaranya dirinya sendiri.
            sibling = row[i + 1] if i + 1 < len(row) else row[i]
        else:
            sibling = row[i - 1]
        proof.append(sibling)
        i //= 2
    return proof


def verify(root, leaf, proof):
    acc = leaf
    for sibling in proof:
        acc = hash_node(acc, sibling)
    return acc == root


def main(argv):
    args = argv[1:]
    mode = "root"
    if args and args[0] in ("--proof", "--verify"):
        mode = args[0][2:]
        args = args[1:]

    if mode == "verify":
        root, leaf = args[0], args[1]
        print("true" if verify(root, leaf, args[2:]) else "false")
        return 0

    with open(args[0], "r", encoding="utf-8") as fh:
        leaves = [ln.strip() for ln in fh if ln.strip()]

    if mode == "proof":
        idx = int(args[1])
        proof = proof_for(leaves, idx)
        print(root_of(leaves))
        for p in proof:
            print(p)
    else:
        print(root_of(leaves))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
