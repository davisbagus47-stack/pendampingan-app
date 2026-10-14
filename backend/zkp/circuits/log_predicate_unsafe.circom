pragma circom 2.2.3;

/*
 * F4.4a -- PEMBANDING REGRESI, BUKAN PRODUKSI.
 *
 * Versi ini sengaja TIDAK memaksa `valid === 1`. Tujuannya hanya membuktikan
 * temuan F0P.5 dapat direproduksi: sebuah bukti atas pernyataan yang salah
 * tetap LOLOS verifikasi, karena Groth16 hanya memeriksa konsistensi witness
 * terhadap R1CS dan tidak memeriksa nilai sebuah sinyal.
 *
 * `tools/test-zkp.js` membuktikannya: untuk input yang commitment-nya salah,
 * `fullProve` berhasil, `verify` mengembalikan true, dan sinyal publik `valid`
 * bernilai 0 -- jadi "bukti sah" untuk klaim yang justru tidak benar.
 */

include "poseidon.circom";
include "comparators.circom";

template LogPredicateUnsafe() {
    signal input entryValue;
    signal input salt;
    signal input commitment;
    signal input threshold;

    signal bind <== Poseidon(2)([entryValue, salt]);
    signal matched <== IsEqual()([bind, commitment]);
    signal inRange <== GreaterThan(32)([entryValue, threshold]);

    signal output valid <== matched * inRange;
}

component main {public [commitment, threshold]} = LogPredicateUnsafe();
