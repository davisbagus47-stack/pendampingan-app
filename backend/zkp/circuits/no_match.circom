pragma circom 2.2.3;

/*
 * F4.7 -- klaim NEGATIF atas log tersembunyi (T2).
 *
 * Klaim FR-8.6(b) yang dipersempit: "tidak ada entri yang cocok dengan tuple
 * publik (kategori, instansi, tanggal) di dalam jendela log yang terikat pada
 * akar publik."
 *
 * Mengapa tidak cukup satu entry commitment: klaim "TIDAK ADA" menyangkut
 * SEBUAH HIMPUNAN, bukan satu entri. Karena itu jendela log diikat ke akar
 * Merkle Poseidon publik `logRoot`; setiap entri harus membuktikan inklusi di
 * bawah akar itu, lalu sirkuit menjumlahkan kecocokan terhadap tuple publik dan
 * memaksa jumlahnya NOL. Kalau ada satu saja entri yang cocok, penjumlahan
 * tidak nol dan witness ditolak.
 *
 * Yang membuat ini bermakna: `logRoot` berasal dari jendela `access_log`
 * sungguhan yang akarnya sudah di-anchor berkala (F4.2/F4.3). Tanpa anchor,
 * prover bisa saja mengarang jendela kosong; dengan anchor, ia terikat pada
 * himpunan yang benar-benar ada.
 *
 * Keterbatasan (jujur): ini membuktikan "tidak ada di dalam jendela N entri
 * yang di-commit", bukan "tidak ada di seluruh riwayat". Jendela harus
 * mencakup periode yang diklaim dan akarnya harus tepercaya.
 */

include "poseidon.circom";
include "comparators.circom";

// Inklusi Merkle biner dengan Poseidon. `sel[j] = 0` berarti node saat ini anak
// KIRI (sibling di kanan); `sel[j] = 1` berarti anak KANAN.
template MerklePoseidon(depth) {
    signal input leaf;
    signal input path[depth];
    signal input sel[depth];
    signal output root;

    signal cur[depth + 1];
    signal kiri[depth];
    signal kanan[depth];
    cur[0] <== leaf;

    component h[depth];
    for (var j = 0; j < depth; j++) {
        sel[j] * (1 - sel[j]) === 0; // sel harus bit
        kiri[j] <== cur[j] + sel[j] * (path[j] - cur[j]);
        kanan[j] <== path[j] + sel[j] * (cur[j] - path[j]);
        h[j] = Poseidon(2);
        h[j].inputs[0] <== kiri[j];
        h[j].inputs[1] <== kanan[j];
        cur[j + 1] <== h[j].out;
    }

    root <== cur[depth];
}

// `depth` tingkat -> n = 2^depth entri. Jendela uji PoC: depth=2 (4 entri).
template NoMatch(depth) {
    var n = 2 ** depth;

    // privat
    signal input cat[n];
    signal input inst[n];
    signal input date[n];
    signal input path[n][depth];
    signal input sel[n][depth];

    // publik
    signal input logRoot;
    signal input targetCat;
    signal input targetInst;
    signal input targetDate;

    component leafH[n];
    component inc[n];
    component eqC[n];
    component eqI[n];
    component eqD[n];

    signal leaf[n];
    signal m1[n];
    signal m2[n];
    signal acc[n + 1];

    for (var i = 0; i < n; i++) {
        leafH[i] = Poseidon(3);
        leafH[i].inputs[0] <== cat[i];
        leafH[i].inputs[1] <== inst[i];
        leafH[i].inputs[2] <== date[i];
        leaf[i] <== leafH[i].out;

        inc[i] = MerklePoseidon(depth);
        inc[i].leaf <== leaf[i];
        for (var j = 0; j < depth; j++) {
            inc[i].path[j] <== path[i][j];
            inc[i].sel[j] <== sel[i][j];
        }
        inc[i].root === logRoot;

        eqC[i] = IsEqual();
        eqC[i].in[0] <== cat[i];
        eqC[i].in[1] <== targetCat;
        eqI[i] = IsEqual();
        eqI[i].in[0] <== inst[i];
        eqI[i].in[1] <== targetInst;
        eqD[i] = IsEqual();
        eqD[i].in[0] <== date[i];
        eqD[i].in[1] <== targetDate;

        m1[i] <== eqC[i].out * eqI[i].out;
        m2[i] <== m1[i] * eqD[i].out;
    }

    acc[0] <== 0;
    for (var i = 0; i < n; i++) {
        acc[i + 1] <== acc[i] + m2[i];
    }

    // Inti klaim negatif: jumlah kecocokan WAJIB nol.
    acc[n] === 0;
}

component main {public [logRoot, targetCat, targetInst, targetDate]} = NoMatch(2);
