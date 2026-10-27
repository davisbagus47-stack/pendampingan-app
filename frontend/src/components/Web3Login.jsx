import React, { useEffect, useState } from 'react';
import { JsonRpcProvider, Wallet, formatEther } from 'ethers';
import './Web3Login.css';

const API_URL = (process.env.REACT_APP_API_URL || window.location.origin).replace(/\/+$/, '');
const STORAGE_KEY = 'pendampingan.web3.keystore.v1';
const IDENTITY_KEY = 'pendampingan.web3.identity.v1';
const RPC_URL = process.env.REACT_APP_SEPOLIA_RPC_URL || 'https://rpc.sepolia.org';
const provider = new JsonRpcProvider(RPC_URL, 11155111, { staticNetwork: true });

function shortAddress(address) { return `${address.slice(0, 6)}…${address.slice(-4)}`; }

export default function Web3Login({ onAuthenticated }) {
  const [keystore, setKeystore] = useState(() => localStorage.getItem(STORAGE_KEY));
  const [identity, setIdentity] = useState(() => {
    try { return JSON.parse(localStorage.getItem(IDENTITY_KEY) || 'null') || { nik: '' }; } catch { return { nik: '' }; }
  });
  const [member, setMember] = useState(null);
  const [address, setAddress] = useState('');
  const [balance, setBalance] = useState('0.0000');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    if (!keystore) return;
    try {
      const parsed = JSON.parse(keystore);
      if (parsed.address) setAddress(`0x${parsed.address}`);
    } catch { localStorage.removeItem(STORAGE_KEY); setKeystore(''); }
  }, [keystore]);

  useEffect(() => {
    if (identity.nik.length !== 16 || member || busy) return undefined;
    const timer = setTimeout(() => { verifyIdentity(); }, 450);
    return () => clearTimeout(timer);
    // The lookup intentionally runs only when the NIK changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity.nik]);

  const refreshBalance = async (walletAddress) => {
    try { setBalance(Number(formatEther(await provider.getBalance(walletAddress))).toFixed(4)); } catch { setBalance('—'); }
  };

  const verifyIdentity = async () => {
    setError(''); setNotice(''); setBusy(true);
    try {
      const response = await fetch(`${API_URL}/api/auth/tpk/verify`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nik: identity.nik }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.message || 'Identitas tidak ditemukan.');
      setMember(data); localStorage.setItem(IDENTITY_KEY, JSON.stringify({ nik: identity.nik }));
      setNotice(`Identitas terverifikasi: ${data.name}. Wallet akan dikaitkan dengan NIK ini.`);
    } catch (e) { setMember(null); setError(e.message || 'Verifikasi identitas gagal.'); }
    finally { setBusy(false); }
  };

  const bindWallet = async (walletAddress) => {
    const response = await fetch(`${API_URL}/api/auth/tpk/wallet`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nik: identity.nik, walletAddress }),
    });
    const data = await response.json();
    if (!response.ok || !data.success) throw new Error(data.message || 'Wallet gagal dikaitkan.');
    return data;
  };

  const createWallet = async () => {
    setError(''); setNotice('');
    if (!member) { setError('Verifikasi NIK dan nama terlebih dahulu.'); return; }
    if (password.length < 8) { setError('Password minimal 8 karakter.'); return; }
    setBusy(true);
    try {
      const wallet = Wallet.createRandom();
      await bindWallet(wallet.address);
      const encrypted = await wallet.encrypt(password);
      localStorage.setItem(STORAGE_KEY, encrypted); setKeystore(encrypted); setAddress(wallet.address); setPassword('');
      await refreshBalance(wallet.address);
      setNotice('Wallet berhasil dibuat dan dikaitkan dengan data TPK.');
    } catch (e) { setError(e.message || 'Wallet gagal dibuat.'); }
    finally { setBusy(false); }
  };

  const login = async (event) => {
    event.preventDefault(); setError(''); setNotice(''); setBusy(true);
    try {
      const wallet = await Wallet.fromEncryptedJson(keystore, password);
      const linked = await bindWallet(wallet.address);
      await refreshBalance(wallet.address); setAddress(wallet.address); setPassword('');
      onAuthenticated({ address: wallet.address, name: linked.name, nik: linked.nik, network: 'Sepolia' });
    } catch (e) { setError(e.message || 'Password wallet salah atau wallet tidak cocok dengan identitas.'); }
    finally { setBusy(false); }
  };

  return (
    <main className="web3-login"><section className="web3-card">
      <div className="web3-mark">✦</div><p className="web3-eyebrow">PENDAMPINGAN WEB3</p>
      <h1>Masuk dengan wallet</h1>
      <p className="web3-subtitle">Verifikasi data TPK, lalu buat wallet Sepolia yang terikat pada identitas terdaftar.</p>
      <div className="identity-grid">
        <label htmlFor="tpk-nik">NIK terdaftar</label>
        <input id="tpk-nik" inputMode="numeric" value={identity.nik} maxLength="16" onChange={(e) => { setMember(null); setIdentity({ nik: e.target.value.replace(/\D/g, '') }); setError(''); }} placeholder="Masukkan 16 digit NIK" disabled={Boolean(member)} />
        {member ? <div className="verified-name"><span>Nama terdaftar</span><strong>{member.name}</strong><small>✓ NIK ditemukan di data TPK</small></div> : null}
      </div>
      {member ? <div className="wallet-status"><div><span>TPK</span><strong>{member.name}</strong></div><div><span>NIK</span><strong>{member.nik}</strong></div>{member.walletAddress ? <div><span>Wallet terdaftar</span><strong>{shortAddress(member.walletAddress)}</strong></div> : null}</div> : null}
      {member ? <form onSubmit={keystore ? login : (e) => { e.preventDefault(); createWallet(); }}>
        <label htmlFor="wallet-password">Password wallet</label><input id="wallet-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={keystore ? 'Masukkan password wallet' : 'Minimal 8 karakter'} autoComplete="new-password" required />
        <button className="web3-primary" type="submit" disabled={busy}>{busy ? 'Memproses…' : keystore ? 'Buka wallet terdaftar' : 'Buat wallet sesuai identitas'}</button>
      </form> : null}
      {error ? <p className="web3-error" role="alert">{error}</p> : null}{notice ? <p className="web3-notice">{notice}</p> : null}
      {address && member ? <div className="wallet-status"><div><span>Alamat</span><strong>{shortAddress(address)}</strong></div><div><span>Jaringan</span><strong>Sepolia testnet</strong></div><div><span>Saldo test ETH</span><strong>{balance} ETH</strong></div></div> : null}
      <div className="web3-faucet"><span>Saldo Sepolia kosong?</span><a href="https://sepoliafaucet.com/" target="_blank" rel="noreferrer">Ambil test ETH dari faucet ↗</a></div>
      <p className="web3-warning">Private key tidak dikirim ke server. Gunakan password dan backup wallet dengan aman.</p>
    </section></main>
  );
}
