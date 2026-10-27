'use strict';

const {
  JsonRpcProvider,
  Wallet,
  getAddress,
  isAddress,
  parseEther,
} = require('ethers');

const DEFAULT_RPC_URL = 'https://ethereum-sepolia-rpc.publicnode.com';
let antrean = Promise.resolve();

function konfigurasi(env) {
  const e = env || process.env;
  const aktif = String(e.TPK_AUTO_FUND_ENABLED || '').trim().toLowerCase() === 'true';
  const rpcUrl = String(e.TPK_FUNDING_RPC_URL || e.ANCHOR_RPC_URL || DEFAULT_RPC_URL).trim();
  const privateKey = String(e.TPK_FUNDING_PRIVATE_KEY || '').trim();
  const amountEth = String(e.TPK_FUNDING_AMOUNT_ETH || '0.1').trim();

  let amountWei = null;
  let configError = null;
  try {
    amountWei = parseEther(amountEth);
    if (amountWei <= 0n) configError = 'TPK_FUNDING_AMOUNT_ETH harus lebih besar dari 0.';
  } catch (error) {
    configError = 'TPK_FUNDING_AMOUNT_ETH bukan angka ETH yang valid.';
  }

  return { aktif, rpcUrl, privateKey, amountEth, amountWei, configError };
}

function pesan(error) {
  const value = error && error.message ? error.message : String(error || 'Galat tidak diketahui.');
  return value.replace(/0x[0-9a-fA-F]{64}/g, '[redacted]').slice(0, 500);
}

async function kirim(walletAddress, env, deps) {
  const k = konfigurasi(env);
  if (!k.aktif) {
    return { status: 'disabled', message: 'Pendanaan otomatis belum diaktifkan.' };
  }
  if (!k.privateKey) {
    return { status: 'not_configured', message: 'TPK_FUNDING_PRIVATE_KEY belum diset di server.' };
  }
  if (k.configError) return { status: 'failed', message: k.configError };
  if (!isAddress(walletAddress)) return { status: 'failed', message: 'Alamat wallet penerima tidak valid.' };

  try {
    const d = deps || {};
    const provider = d.provider || new JsonRpcProvider(k.rpcUrl, 11155111, { staticNetwork: true });
    const treasury = d.wallet || new Wallet(k.privateKey, provider);
    const tx = await treasury.sendTransaction({
      to: getAddress(walletAddress),
      value: k.amountWei,
    });
    return {
      status: 'submitted',
      txHash: tx.hash,
      amountEth: k.amountEth,
    };
  } catch (error) {
    return { status: 'failed', message: pesan(error) };
  }
}

/**
 * Serialisasi pengiriman dalam satu instance server agar nonce treasury tidak
 * bertabrakan ketika beberapa TPK membuat wallet hampir bersamaan.
 */
function antreKirim(walletAddress, env, deps) {
  const pekerjaan = antrean.then(
    () => kirim(walletAddress, env, deps),
    () => kirim(walletAddress, env, deps)
  );
  antrean = pekerjaan.catch(() => {});
  return pekerjaan;
}

module.exports = { konfigurasi, kirim, antreKirim };
