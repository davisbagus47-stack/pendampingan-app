'use strict';

const crypto = require('crypto');

function buatKodeReset() {
  return crypto.randomBytes(32).toString('hex');
}

function buatSecretOperator() {
  return crypto.randomBytes(32).toString('hex');
}

function hashKodeReset(code) {
  const normalized = String(code || '');
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new TypeError('Kode reset harus terdiri dari 64 digit heksadesimal.');
  }
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}

module.exports = {
  buatKodeReset,
  buatSecretOperator,
  hashKodeReset,
};
