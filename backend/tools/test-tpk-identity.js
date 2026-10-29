'use strict';

const { Wallet } = require('ethers');
const identity = require('../lib/tpk-identity.js');

async function main() {
  const wallet = Wallet.createRandom();
  const payload = { namaTPK: 'Kader A', nik: '3201234567890001' };
  const reorderedPayload = { nik: '3201234567890001', namaTPK: 'Kader A' };
  const submission = identity.pesanPengiriman(wallet.address, payload);
  const signature = await wallet.signMessage(submission);

  if (!identity.tandaTanganValid(wallet.address, submission, signature)) {
    throw new Error('Signature payload valid ditolak.');
  }
  if (!identity.tandaTanganValid(
    wallet.address,
    identity.pesanPengiriman(wallet.address, reorderedPayload),
    signature
  )) {
    throw new Error('Urutan properti payload mengubah signature.');
  }
  if (identity.tandaTanganValid(
    wallet.address,
    identity.pesanPengiriman(wallet.address, { ...payload, namaTPK: 'Kader B' }),
    signature
  )) {
    throw new Error('Signature diterima untuk payload yang berubah.');
  }

  const bindingMessage = identity.pesanIkatWallet('3201234567890001', wallet.address);
  const bindingSignature = await wallet.signMessage(bindingMessage);
  if (!identity.tandaTanganValid(wallet.address, bindingMessage, bindingSignature)) {
    throw new Error('Signature wallet binding valid ditolak.');
  }
  if (identity.tandaTanganValid(
    wallet.address,
    identity.pesanIkatWallet('3201234567890002', wallet.address),
    bindingSignature
  )) {
    throw new Error('Signature binding diterima untuk NIK lain.');
  }

  console.log('SEMUA UJI IDENTITAS TPK LOLOS');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
