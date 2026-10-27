import React, { useEffect, useState } from 'react';
import { JsonRpcProvider, Wallet, formatEther } from 'ethers';
import './Web3Login.css';

const STORAGE_KEY = 'pendampingan.web3.keystore.v1';
const RPC_URL = process.env.REACT_APP_SEPOLIA_RPC_URL || 'https://rpc.sepolia.org';
const provider = new JsonRpcProvider(RPC_URL, 11155111, { staticNetwork: true });

function shortAddress(address) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export default function Web3Login({ onAuthenticated }) {
  const [keystore, setKeystore] = useState(() => localStorage.getItem(STORAGE_KEY));
  const [address, setAddress] = useState('');
  const [balance, setBalance] = useState('0.0000');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    if (!keystore) return;
    try {
      setAddress(JSON.parse(keystore).address
        ? `0x${JSON.parse(keystore).address}`
        : '');
    } catch {
      localStorage.removeItem(STORAGE_KEY);
      setKeystore('');
    }
  }, [keystore]);

  const refreshBalance = async (walletAddress) => {
    try {
      const value = await provider.getBalance(walletAddress);
      setBalance(Number(formatEther(value)).toFixed(4));
    } catch {
      setBalance('—');
    }
  };

  const createWallet = async () => {
    setError('');
    setNotice('');
    if (password.length < 8) {
      setError('Buat password minimal 8 karakter untuk mengenkripsi wallet.');
      return;
    }
    setBusy(true);
    try {
      const wallet = Wallet.createRandom();
      const encrypted = await wallet.encrypt(password);
      localStorage.setItem(STORAGE_KEY, encrypted);
      setKeystore(encrypted);
      setAddress(wallet.address);
      setPassword('');
      await refreshBalance(wallet.address);
      setNotice('Wallet berhasil dibuat. Simpan backup wallet sebelum melanjutkan.');
    } catch (e) {
      setError(e.message || 'Wallet gagal dibuat.');
    } finally {
      setBusy(false);
    }
  };

  const login = async (event) => {
    event.preventDefault();
    setError('');
    setNotice('');
    if (!keystore) return;
    setBusy(true);
    try {
      const wallet = await Wallet.fromEncryptedJson(keystore, password);
      await refreshBalance(wallet.address);
      setAddress(wallet.address);
      setPassword('');
      onAuthenticated({ address: wallet.address, network: 'Sepolia' });
    } catch {
      setError('Password wallet salah atau keystore rusak.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="web3-login">
      <section className="web3-card">
        <div className="web3-mark">✦</div>
        <p className="web3-eyebrow">PENDAMPINGAN WEB3</p>
        <h1>Masuk dengan wallet</h1>
        <p className="web3-subtitle">Identitas terdesentralisasi untuk mencatat pendampingan secara transparan.</p>

        {address ? (
          <div className="wallet-status">
            <div><span>Wallet</span><strong>{shortAddress(address)}</strong></div>
            <div><span>Jaringan</span><strong>Sepolia testnet</strong></div>
            <div><span>Saldo test ETH</span><strong>{balance} ETH</strong></div>
          </div>
        ) : null}

        <form onSubmit={keystore ? login : (e) => { e.preventDefault(); createWallet(); }}>
          <label htmlFor="wallet-password">Password wallet</label>
          <input
            id="wallet-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={keystore ? 'Masukkan password wallet' : 'Minimal 8 karakter'}
            autoComplete="new-password"
            required
          />
          <button className="web3-primary" type="submit" disabled={busy}>
            {busy ? 'Memproses…' : keystore ? 'Buka wallet' : 'Buat wallet otomatis'}
          </button>
        </form>

        {error ? <p className="web3-error" role="alert">{error}</p> : null}
        {notice ? <p className="web3-notice">{notice}</p> : null}

        <div className="web3-faucet">
          <span>Saldo Sepolia kosong?</span>
          <a href="https://sepoliafaucet.com/" target="_blank" rel="noreferrer">Ambil test ETH dari faucet ↗</a>
        </div>
        <p className="web3-warning">Wallet terenkripsi disimpan di browser ini. Jangan gunakan wallet ini untuk aset sungguhan.</p>
      </section>
    </main>
  );
}
