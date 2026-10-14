/**
 * Validasi 001_schema.sql memakai parser PostgreSQL asli (libpg-query),
 * bukan pemeriksaan dengan regex. Regex tidak bisa menangkap sebagian besar
 * kesalahan sintaks SQL.
 *
 * Ada dua tingkat pemeriksaan, dan yang kedua lahir dari kesalahan nyata.
 *
 *   1. Sintaks. Parser PostgreSQL harus menerima setiap pernyataan.
 *
 *   2. Urutan ketergantungan. Sintaks yang benar BELUM tentu bisa dijalankan.
 *      PostgreSQL mensyaratkan tabel yang dirujuk foreign key sudah ada saat
 *      CREATE TABLE dieksekusi. imaginable skenario: records.institution_id
 *      (ADR-3) merujuk agencies(institution_key), sementara blok agencies
 *      diletakkan sesudah records. Parser menerima 100 persen -- semua
 *      pernyataan syntactically valid -- lalu CREATE TABLE records gagal saat
 *      dijalankan dengan "relation agencies does not exist".
 *
 *      Itu persis yang terjadi, dan validasi versi lama melaporkannya sebagai
 *      SINTAKS VALID. Hijau palsu lebih berbahaya dari merah, karena ia
 *      menghentikan pemeriksaan.
 */
const fs = require('fs');
const parse = require('libpg-query');

const file = process.argv[2] || 'C:/Users/davis/pendampingan-app/backend/sql/001_schema.sql';
const sql = fs.readFileSync(file, 'utf8');

/**
 * Kumpulkan semua foreign key pada satu CREATE TABLE.
 *
 * REFERENCES bisa ditulis di dua tempat dan keduanya harus diperiksa:
 * level kolom (`agency_id BIGINT REFERENCES agencies(id)`) muncul di
 * ColumnDef.constraints, sedangkan level tabel (`FOREIGN KEY (...) REFERENCES`)
 * muncul di tableElts[].Constraint. Hanya memeriksa yang level tabel akan
 * melewatkan seluruh FK yang dipakai skema ini.
 */
function foreignKeyCreateStmt(createStmt) {
  const kolom = createStmt.colname || null;
  const out = [];

  for (const el of createStmt.tableElts || []) {
    if (el.Constraint && el.Constraint.contype === 'CONSTR_FOREIGN') {
      const ref = el.Constraint.pktable;
      if (ref && ref.relname) out.push({ kolom, ref: ref.relname });
    }
    if (!el.ColumnDef) continue;
    for (const c of el.ColumnDef.constraints || []) {
      const cons = c.Constraint;
      if (!cons || cons.contype !== 'CONSTR_FOREIGN') continue;
      const ref = cons.pktable;
      if (ref && ref.relname) out.push({ kolom: el.ColumnDef.colname, ref: ref.relname });
    }
  }
  return out;
}

function cekUrutan(stmts) {
  const buat = []; // tabel, sesuai urutan kemunculan
  const semua = new Set();
  for (const s of stmts) {
    const cs = s.stmt.CreateStmt;
    if (cs && cs.relation.relname) semua.add(cs.relation.relname);
  }

  const sudahAda = new Set();
  const galat = [];
  const catatan = [];

  stmts.forEach((s, i) => {
    const cs = s.stmt.CreateStmt;
    if (!cs) return;
    const nama = cs.relation.relname;

    for (const fk of foreignKeyCreateStmt(cs)) {
      if (fk.ref === nama) continue; // merujuk diri sendiri, sah
      if (sudahAda.has(fk.ref)) continue; // sudah dibuat sebelumnya, sah
      if (semua.has(fk.ref)) {
        // Dibuat di berkas ini tapi belakangan. Pasti gagal.
        const posisi = buat.indexOf(fk.ref);
        galat.push({
          tabel: nama,
          kolom: fk.kolom,
          ref: fk.ref,
          stmt: i + 1,
          posisiRef: posisi + 1,
        });
      } else {
        // Tidak dibuat di berkas ini: kemungkinan tabel dari extension.
        // Tidak bisa dipastikan tanpa katalog, jadi hanya dicatat.
        catatan.push(nama + '.' + fk.kolom + ' -> ' + fk.ref + ' (di luar berkas ini)');
      }
    }

    sudahAda.add(nama);
    buat.push(nama);
  });

  return { galat, catatan, buat };
}

console.log('berkas : ' + file);
console.log('baris  : ' + sql.split('\n').length);

parse
  .parse(sql)
  .then((result) => {
    const stmts = result.stmts || [];
    console.log('pernyataan SQL diurai : ' + stmts.length);

    const kinds = {};
    stmts.forEach((s) => {
      const k = Object.keys(s.stmt)[0];
      kinds[k] = (kinds[k] || 0) + 1;
    });
    console.log('\nrincian jenis pernyataan:');
    Object.keys(kinds).sort().forEach((k) => console.log('  ' + k.padEnd(22) + kinds[k]));

    const tables = stmts
      .filter((s) => s.stmt.CreateStmt)
      .map((s) => s.stmt.CreateStmt.relation.relname);
    const policies = stmts
      .filter((s) => s.stmt.CreatePolicyStmt)
      .map((s) => s.stmt.CreatePolicyStmt.policy_name);
    const funcs = stmts
      .filter((s) => s.stmt.CreateFunctionStmt)
      .map((s) => s.stmt.CreateFunctionStmt.funcname.map((n) => n.String.sval).join('.'));

    console.log('\ntabel dibuat (' + tables.length + '):');
    tables.forEach((t) => console.log('  - ' + t));
    console.log('\npolicy dibuat (' + policies.length + '):');
    policies.forEach((p) => console.log('  - ' + p));
    console.log('\nfungsi dibuat (' + funcs.length + '):');
    funcs.forEach((f) => console.log('  - ' + f));

    console.log('\n--- tingkat 2: urutan ketergantungan ---');
    const { galat, catatan } = cekUrutan(stmts);

    if (catatan.length) {
      console.log('catatan (tidak memblokir):');
      catatan.forEach((c) => console.log('  ~ ' + c));
    }

    if (galat.length) {
      console.log('\nURUTAN SALAH -- skema ini akan gagal saat dijalankan:');
      for (const g of galat) {
        console.log(
          '  x CREATE TABLE ' + g.tabel + '.' + g.kolom +
          ' -> REFERENCES ' + g.ref +
          '\n      ' + g.ref + ' baru dibuat pada pernyataan #' + g.posisiRef +
          ', setelah pernyataan #' + g.stmt);
      }
      console.log('\nSINTAKS VALID, TAPI URUTAN CREATE TABLE SALAH');
      process.exit(1);
    }

    console.log('semua foreign key mengarah ke tabel yang sudah ada: OK');
    console.log('\nSINTAKS VALID');
  })
  .catch((e) => {
    console.error('\nSINTAKS TIDAK VALID');
    const pos = e.cursorPosition;
    if (typeof pos === 'number') {
      const upto = sql.slice(0, pos);
      const line = upto.split('\n').length;
      const col = pos - upto.lastIndexOf('\n');
      console.error('posisi kursor: ' + pos + '  (baris ' + line + ', kolom ' + col + ')');
      const lines = sql.split('\n');
      for (let i = Math.max(0, line - 4); i < Math.min(lines.length, line + 2); i++) {
        console.error('  ' + (i + 1 === line ? '>' : ' ') + ' ' + (i + 1) + ' | ' + lines[i]);
      }
    }
    console.error(e.message);
    process.exit(1);
  });
