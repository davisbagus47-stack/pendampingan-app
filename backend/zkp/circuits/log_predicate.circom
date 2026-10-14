pragma circom 2.2.3;

/*
 * F4.4 (T2) -- prototipe pernyataan turunan atas log tersembunyi.
 *
 * Yang dibuktikan, tanpa membuka isi entri mana pun:
 *
 *   "Saya mengetahui sebuah entri log tersembunyi yang
 *    (1) terikat pada commitment publik, dan
 *    (2) nilai hitungannya melampaui ambang publik."
 *
 * Ini contoh klaim FR-8.6(c) yang dipersempit supaya sirkuitnya kecil: bukan
 * seluruh 72 kolom entri yang dibuktikan, melainkan satu proposisi turunan
 * (persis rekomendasi `keputusan-zkp-spike.md`).
 *
 * Input:
 *   entryValue  privat  jumlah akses kategori K pada periode P
 *   salt        privat  pengikat, supaya commitment tidak dapat dihitung-balik
 *   commitment  publik  Poseidon(entryValue, salt) -- T2 memakai Poseidon,
 *                       berbeda dari commitment_X = SHA256(...) milik ADR-3
 *   threshold   publik  ambang T
 *
 * F4.4a WAJIB: `valid === 1`. Tanpa baris itu, Groth16 tetap menerima prover
 * yang berbohong -- ia hanya memeriksa konsistensi witness terhadap R1CS, bukan
 * nilai output. `log_predicate_unsafe.circom` menyimpan versi tanpa constraint
 * itu HANYA sebagai pembanding regresi; jangan pakai di produksi.
 */

include "poseidon.circom";
include "comparators.circom";

template LogPredicate() {
    signal input entryValue;
    signal input salt;
    signal input commitment;
    signal input threshold;

    signal bind <== Poseidon(2)([entryValue, salt]);
    signal matched <== IsEqual()([bind, commitment]);
    signal inRange <== GreaterThan(32)([entryValue, threshold]);

    signal valid <== matched * inRange;
    valid === 1;
}

component main {public [commitment, threshold]} = LogPredicate();
