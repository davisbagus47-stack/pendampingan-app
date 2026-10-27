import React, { useEffect, useState } from 'react';
import { JsonRpcProvider, Wallet, formatEther } from 'ethers';
import './Web3Login.css';

const DEFAULT_API_URL = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
  ? 'http://localhost:3001'
  : 'https://pendampingan-app-mvbo.vercel.app';
const API_URL = (process.env.REACT_APP_API_URL || DEFAULT_API_URL).replace(/\/+$/, '');
const STORAGE_KEY = 'pendampingan.web3.keystore.v1';
const IDENTITY_KEY = 'pendampingan.web3.identity.v1';
const RPC_URL = process.env.REACT_APP_SEPOLIA_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com';
const FAUCET_URL = 'https://www.alchemy.com/faucets/ethereum-sepolia';
const POW_FAUCET_URL = 'https://sepolia-faucet.pk910.de/';
const provider = new JsonRpcProvider(RPC_URL, 11155111, { staticNetwork: true });

function shortAddress(address) { return `${address.slice(0, 6)}...${address.slice(-4)}`; }

function keystoreAddress(value) {
  try {
    const parsed = JSON.parse(value || '');
    const normalized = String(parsed.address || '').replace(/^0x/i, '');
    return normalized ? `0x${normalized}` : '';
  } catch {
    return '';
  }
}

export default function Web3Login({ onAuthenticated, initialNotice = '' }) {
  const [keystore, setKeystore] = useState(() => localStorage.getItem(STORAGE_KEY));
  const [identity, setIdentity] = useState(() => {
    try { return JSON.parse(localStorage.getItem(IDENTITY_KEY) || 'null') || { nik: '' }; } catch { return { nik: '' }; }
  });
  const [member, setMember] = useState(null);
  const [address, setAddress] = useState('');
  const [balance, setBalance] = useState('0.0000');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (initialNotice) setNotice(initialNotice);
  }, [initialNotice]);

  useEffect(() => {
    if (!keystore) return;
    const walletAddress = keystoreAddress(keystore);
    if (walletAddress) setAddress(walletAddress);
    else { localStorage.removeItem(STORAGE_KEY); setKeystore(''); }
  }, [keystore]);

  const refreshBalance = async (walletAddress) => {
    try {
      const balanceWei = await provider.getBalance(walletAddress);
      setBalance(Number(formatEther(balanceWei)).toFixed(4));
      return balanceWei;
    } catch {
      setBalance('--');
      return null;
    }
  };

  const waitForFundedWallet = async (walletAddress, funding) => {
    const shouldWait = ['pending', 'processing', 'submitted'].includes(funding?.status);
    const deadline = Date.now() + (shouldWait ? 60000 : 0);
    let balanceWei = null;
    do {
      balanceWei = await refreshBalance(walletAddress);
      if (balanceWei !== null && balanceWei > 0n) return balanceWei;
      if (Date.now() >= deadline) break;
      setNotice(funding?.reason === 'saldo_habis' ? 'Saldo habis. Menunggu pengisian ulang Sepolia ETH...' : 'Menunggu saldo Sepolia masuk sebelum membuka form...');
      await new Promise((resolve) => window.setTimeout(resolve, 4000));
    } while (Date.now() < deadline);
    throw new Error('Saldo Sepolia belum masuk. Form belum dapat dibuka. Coba lagi setelah funding berhasil.');
  };

  const verifyIdentity = async () => {
    setError(''); setNotice(''); setBusy(true);
    try {
      const response = await fetch(`${API_URL}/api/auth/tpk/verify`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nik: identity.nik }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.message || 'Identitas tidak ditemukan.');
      setMember(data);
      if (!keystore) setAddress(data.walletAddress || '');
      if (data.walletAddress) refreshBalance(data.walletAddress);
      localStorage.setItem(IDENTITY_KEY, JSON.stringify({ nik: identity.nik }));
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
    if (member.walletAddress) {
      setError('NIK ini sudah memiliki wallet. Pulihkan backup wallet yang terdaftar di perangkat ini.');
      return;
    }
    if (password.length < 8) { setError('Password minimal 8 karakter.'); return; }
    setBusy(true);
    try {
      const wallet = Wallet.createRandom();
      const linked = await bindWallet(wallet.address);
      const encrypted = await wallet.encrypt(password);
      localStorage.setItem(STORAGE_KEY, encrypted); setKeystore(encrypted); setAddress(wallet.address); setPassword(''); setShowPassword(false);
      await waitForFundedWallet(wallet.address, linked.funding);
      setNotice('Wallet berhasil dibuat dan dikaitkan dengan data TPK.');
      onAuthenticated({ address: wallet.address, name: linked.name, nik: linked.nik, idTpk: linked.idTpk, network: 'Sepolia', funding: linked.funding });
    } catch (e) { setError(e.message || 'Wallet gagal dibuat.'); }
    finally { setBusy(false); }
  };

  const login = async (event) => {
    event.preventDefault(); setError(''); setNotice(''); setBusy(true);
    try {
      const wallet = await Wallet.fromEncryptedJson(keystore, password);
      if (member?.walletAddress && wallet.address.toLowerCase() !== member.walletAddress.toLowerCase()) {
        throw new Error('Backup wallet tidak cocok dengan wallet yang terdaftar untuk NIK ini.');
      }
      const linked = await bindWallet(wallet.address);
      await waitForFundedWallet(wallet.address, linked.funding); setAddress(wallet.address); setPassword(''); setShowPassword(false);
      onAuthenticated({ address: wallet.address, name: linked.name, nik: linked.nik, idTpk: linked.idTpk, network: 'Sepolia', funding: linked.funding });
    } catch (e) { setError(e.message || 'Password wallet salah atau wallet tidak cocok dengan identitas.'); }
    finally { setBusy(false); }
  };

  const importBackup = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setError(''); setNotice('');
    try {
      const contents = await file.text();
      const importedAddress = keystoreAddress(contents);
      if (!importedAddress) throw new Error('File backup wallet tidak valid.');
      if (member?.walletAddress && importedAddress.toLowerCase() !== member.walletAddress.toLowerCase()) {
        throw new Error('Backup wallet ini bukan milik NIK yang sedang diverifikasi.');
      }
      localStorage.setItem(STORAGE_KEY, contents);
      setKeystore(contents);
      setAddress(importedAddress);
      setNotice('Backup wallet berhasil dipulihkan. Masukkan password wallet untuk masuk.');
    } catch (e) { setError(e.message || 'Backup wallet gagal dipulihkan.'); }
  };

  const downloadBackup = () => {
    if (!keystore) return;
    const blob = new Blob([keystore], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `wallet-${identity.nik || 'tpk'}-backup.json`;
    link.click();
    URL.revokeObjectURL(url);
    setNotice('Backup wallet diunduh. Simpan file ini dengan aman dan jangan bagikan passwordnya.');
  };

  const copyAddress = async () => {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setNotice('Alamat wallet tersalin. Tempel alamat ini di faucet Sepolia.');
      window.setTimeout(() => setCopied(false), 1800);
    } catch { setError('Alamat wallet tidak dapat disalin otomatis. Salin alamat yang tampil secara manual.'); }
  };

  const walletAlreadyRegistered = Boolean(member?.walletAddress);
  const walletMatchesIdentity = Boolean(keystore) && (!walletAlreadyRegistered || member.walletAddress.toLowerCase() === address.toLowerCase());

  return (
    <main className="web3-login"><section className="web3-card">
      <div className="web3-mark" aria-label="Logo Pendampingan Web3">
        <svg viewBox="0 0 48 48" role="img" aria-hidden="true">
          <path d="M18.5 28.5 15 32a6 6 0 0 0 8.5 8.5l4-4" />
          <path d="M29.5 19.5 33 16a6 6 0 0 0-8.5-8.5l-4 4" />
          <path d="m18 24 12 0" />
        </svg>
      </div><p className="web3-eyebrow">PENDAMPINGAN WEB3</p>
      <h1>Masuk dengan wallet</h1>
      <p className="web3-subtitle">Verifikasi data TPK, lalu buat wallet Sepolia yang terikat pada identitas terdaftar.</p>
      <div className="identity-grid">
        <label htmlFor="tpk-nik">NIK terdaftar</label>
        <input id="tpk-nik" inputMode="numeric" value={identity.nik} maxLength="16" onChange={(e) => { setMember(null); setIdentity({ nik: e.target.value.replace(/\D/g, '') }); setError(''); }} placeholder="Masukkan 16 digit NIK" disabled={Boolean(member)} />
        <button className="web3-secondary" type="button" onClick={verifyIdentity} disabled={busy || Boolean(member) || identity.nik.length !== 16}>{busy ? 'Memverifikasi...' : member ? 'Identitas terverifikasi' : 'Verifikasi NIK'}</button>
        {member ? <div className="verified-name"><span>Nama terdaftar</span><strong>{member.name}</strong><small>NIK ditemukan di data TPK</small></div> : null}
      </div>
      {member ? <div className="wallet-status"><div><span>TPK</span><strong>{member.name}</strong></div><div><span>NIK</span><strong>{member.nik}</strong></div>{member.walletAddress ? <div><span>Wallet terdaftar</span><strong>{shortAddress(member.walletAddress)}</strong></div> : null}</div> : null}
      {member && (walletMatchesIdentity || !walletAlreadyRegistered) ? <form onSubmit={keystore ? login : (e) => { e.preventDefault(); createWallet(); }}>
        <label htmlFor="wallet-password">Password wallet</label>
        <div className="password-field"><input id="wallet-password" type={showPassword ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} placeholder={keystore ? 'Masukkan password wallet' : 'Minimal 8 karakter'} autoComplete="new-password" required /><button className="password-toggle" type="button" onClick={() => setShowPassword((value) => !value)} aria-label={showPassword ? 'Sembunyikan password' : 'Tampilkan password'}>{showPassword ? 'Sembunyikan' : 'Tampilkan'}</button></div>
        <button className="web3-primary" type="submit" disabled={busy}>{busy ? 'Memproses...' : keystore ? 'Buka wallet terdaftar' : 'Buat wallet sesuai identitas'}</button>
        {keystore ? <p className="web3-forgot">Lupa password? Password tidak dapat di-reset. Wallet hanya bisa dibuka dengan password yang benar.</p> : null}
      </form> : null}
      {member?.walletAddress && !walletMatchesIdentity ? <div className="web3-recovery">
        <strong>Wallet NIK ini sudah terdaftar</strong>
        <p>Di perangkat baru, pulihkan backup wallet dari perangkat sebelumnya. Wallet kedua tidak dapat dibuat untuk NIK yang sama.</p>
        <label className="web3-file-label" htmlFor="wallet-backup">Pulihkan backup wallet
          <input id="wallet-backup" type="file" accept=".json,application/json" onChange={importBackup} />
        </label>
      </div> : null}
      {error ? <p className="web3-error" role="alert">{error}</p> : null}{notice ? <p className="web3-notice">{notice}</p> : null}
      {address && member ? <div className="wallet-status"><div><span>Alamat</span><strong>{shortAddress(address)}</strong></div><div><span>Jaringan</span><strong>Sepolia testnet</strong></div><div><span>Saldo test ETH</span><strong>{balance} ETH</strong></div></div> : null}
      {address && member ? <button className="web3-secondary web3-copy" type="button" onClick={copyAddress}>{copied ? 'Alamat tersalin' : 'Salin alamat wallet'}</button> : null}
      {address && member && keystore ? <button className="web3-secondary web3-backup" type="button" onClick={downloadBackup}>Unduh backup wallet</button> : null}
      <div className="web3-faucet"><span>Saldo Sepolia kosong?</span><span className="web3-faucet-links"><a href={FAUCET_URL} target="_blank" rel="noreferrer">Faucet Alchemy</a><a href={POW_FAUCET_URL} target="_blank" rel="noreferrer">Alternatif PoW</a></span></div>
      <p className="web3-warning">Private key tidak dikirim ke server. Gunakan password dan backup wallet dengan aman.</p>
    </section></main>
  );
}
