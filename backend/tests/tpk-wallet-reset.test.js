'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { verifyMessage, Wallet } = require('ethers');
const reset = require('../lib/tpk-wallet-reset.js');
const identity = require('../lib/tpk-identity.js');

test('kode reset acak memiliki 256 bit dan hash-nya tidak menyimpan kode asli', () => {
  const first = reset.buatKodeReset();
  const second = reset.buatKodeReset();

  assert.match(first, /^[0-9a-f]{64}$/);
  assert.notEqual(first, second);
  assert.match(reset.hashKodeReset(first), /^[0-9a-f]{64}$/);
  assert.notEqual(reset.hashKodeReset(first), first);
  assert.throws(() => reset.hashKodeReset('invalid'), TypeError);
});

test('secret operator dihasilkan acak dengan 256 bit', () => {
  const first = reset.buatSecretOperator();
  const second = reset.buatSecretOperator();

  assert.match(first, /^[0-9a-f]{64}$/);
  assert.notEqual(first, second);
});

test('tanda tangan reset mengikat NIK, wallet, dan kode satu kali', async () => {
  const wallet = Wallet.createRandom();
  const code = reset.buatKodeReset();
  const message = identity.pesanResetWallet('1234567890123456', wallet.address, code);
  const signature = await wallet.signMessage(message);

  assert.equal(verifyMessage(message, signature).toLowerCase(), wallet.address.toLowerCase());
  assert.notEqual(
    verifyMessage(identity.pesanResetWallet('1234567890123456', wallet.address, reset.buatKodeReset()), signature).toLowerCase(),
    wallet.address.toLowerCase()
  );
});
