'use strict';

const { verifyMessage, keccak256, toUtf8Bytes } = require('ethers');

function stableJson(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((key) =>
      JSON.stringify(key) + ':' + stableJson(value[key])
    ).join(',') + '}';
  }
  return JSON.stringify(value);
}

function pesanIkatWallet(nik, walletAddress) {
  return [
    'Pendampingan TPK wallet binding v1',
    'Chain: Sepolia (11155111)',
    'NIK: ' + String(nik),
    'Wallet: ' + String(walletAddress).toLowerCase(),
  ].join('\n');
}

function pesanPengiriman(walletAddress, payload) {
  const hashPayload = keccak256(toUtf8Bytes(stableJson(payload)));
  return [
    'Pendampingan TPK submission v1',
    'Chain: Sepolia (11155111)',
    'Wallet: ' + String(walletAddress).toLowerCase(),
    'Payload: ' + hashPayload,
  ].join('\n');
}

function tandaTanganValid(walletAddress, message, signature) {
  if (!walletAddress || !message || !signature) return false;
  try {
    return verifyMessage(message, signature).toLowerCase() === String(walletAddress).toLowerCase();
  } catch {
    return false;
  }
}

module.exports = {
  stableJson,
  pesanIkatWallet,
  pesanPengiriman,
  tandaTanganValid,
};
