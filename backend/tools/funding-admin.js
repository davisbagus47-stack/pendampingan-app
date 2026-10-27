'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const express = require('express');
const db = require('../lib/db.js');
const tpkFunding = require('../lib/tpk-funding.js');

const app = express();
const port = Number(process.env.FUNDING_ADMIN_PORT || 3030);
const token = crypto.randomBytes(24).toString('hex');
const backendDir = path.join(__dirname, '..');
const envPath = path.join(backendDir, '.env');
const pagePath = path.join(__dirname, 'funding-admin.html');
const vercelCommand = process.platform === 'win32' ? 'vercel.cmd' : 'vercel';

app.use(express.json({ limit: '12kb' }));

function isAuthorized(req) {
  return req.get('x-admin-token') === token || req.query.token === token;
}

function protect(req, res, next) {
  if (!isAuthorized(req)) return res.status(401).json({ success: false, message: 'Token panel lokal tidak valid.' });
  return next();
}

function maskNik(nik) {
  const value = String(nik || '');
  return value.length > 8 ? `${value.slice(0, 4)}******${value.slice(-4)}` : value;
}

function shortAddress(address) {
  const value = String(address || '');
  return value.length > 12 ? `${value.slice(0, 8)}...${value.slice(-6)}` : value;
}

function updateDotEnv(values) {
  let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  for (const [name, value] of Object.entries(values)) {
    const pattern = new RegExp(`^[ \\t]*${name.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}[ \\t]*=.*(?:\\r?\\n|$)`, 'm');
    const replacement = `${name}=${value}\n`;
    if (pattern.test(content)) content = content.replace(pattern, replacement);
    else content += `${content && !content.endsWith('\n') ? '\n' : ''}${replacement}`;
  }
  fs.writeFileSync(envPath, content, { encoding: 'utf8', mode: 0o600 });
}

function runVercel(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(vercelCommand, args, { cwd: backendDir, windowsHide: true, shell: process.platform === 'win32' });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    if (input !== undefined) {
      child.stdin.write(`${input}\n`);
      child.stdin.end();
    }
    child.on('error', (error) => reject(error));
    child.on('close', (code) => {
      if (code === 0) return resolve();
      reject(new Error(`Vercel CLI gagal pada perintah ${args.slice(0, 4).join(' ')} (${code}). ${stderr.slice(-300)}`));
    });
  });
}

function openBrowser(url) {
  if (!process.argv.includes('--open')) return;
  if (process.platform === 'win32') {
    spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } else {
    const command = process.platform === 'darwin' ? 'open' : 'xdg-open';
    spawn(command, [url], { detached: true, stdio: 'ignore' }).unref();
  }
}

function validateConfig(body) {
  const privateKey = String(body.privateKey || '').replace(/\s/g, '');
  const amountEth = String(body.amountEth || '0.1').trim();
  const rpcUrl = String(body.rpcUrl || 'https://ethereum-sepolia-rpc.publicnode.com').trim();
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error('Private key harus berupa 64 karakter hexadecimal.');
  if (!/^\d+(\.\d+)?$/.test(amountEth) || Number(amountEth) <= 0) throw new Error('Jumlah ETH tidak valid.');
  if (!/^https?:\/\//.test(rpcUrl)) throw new Error('RPC URL harus diawali http:// atau https://.');
  return { privateKey: privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`, amountEth, rpcUrl };
}

async function enrichFundingStatuses(rows) {
  const enriched = new Array(rows.length);
  const fundedNiks = [];
  let cursor = 0;
  const workerCount = Math.min(8, Math.max(1, rows.length));

  async function worker() {
    while (cursor < rows.length) {
      const index = cursor;
      cursor += 1;
      const row = rows[index];
      let fundingStatus = row.funding_status || 'belum_didanai';
      let balanceWei = null;
      if (row.wallet_address) {
        try {
          balanceWei = await tpkFunding.saldo(row.wallet_address);
          if (balanceWei > 0n) {
            fundingStatus = 'funded';
            if (row.funding_status !== 'funded') fundedNiks.push(row.nik);
          } else if (row.funding_status === 'funded') {
            fundingStatus = 'saldo_habis';
          }
        } catch (error) {
          console.error(`Gagal membaca saldo wallet TPK ${row.nik}:`, error.message);
        }
      }
      enriched[index] = {
        nik: maskNik(row.nik),
        name: row.nama_lengkap,
        idTpk: row.id_tpk,
        walletAddress: row.wallet_address || null,
        walletLabel: shortAddress(row.wallet_address),
        fundingStatus,
        fundingTxHash: row.funding_tx_hash || null,
        fundingAmountWei: row.funding_amount_wei ? String(row.funding_amount_wei) : null,
        fundingAttemptedAt: row.funding_attempted_at || null,
        balanceWei: balanceWei === null ? null : balanceWei.toString(),
      };
    }
  }

  await Promise.all(Array.from({ length: workerCount }, worker));
  return { enriched, fundedNiks };
}

app.get('/', (req, res) => {
  if (req.query.token !== token) return res.status(401).type('text').send('Buka URL panel yang tercetak di terminal.');
  const html = fs.readFileSync(pagePath, 'utf8').replace('__ADMIN_TOKEN__', token);
  return res.type('html').send(html);
});

app.get('/api/config', protect, (req, res) => res.json({
  success: true,
  enabled: String(process.env.TPK_AUTO_FUND_ENABLED || '').toLowerCase() === 'true',
  privateKeyConfigured: Boolean(process.env.TPK_FUNDING_PRIVATE_KEY),
  amountEth: process.env.TPK_FUNDING_AMOUNT_ETH || '0.1',
  rpcUrl: process.env.TPK_FUNDING_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com',
}));

app.get('/api/members', protect, async (req, res) => {
  if (!db.urlDatabase()) return res.status(503).json({ success: false, message: 'DATABASE_URL belum tersedia di backend/.env.' });
  try {
    const result = await db.transaksi({ role: 'operator' }, (client) => client.query(
      `SELECT nik, nama_lengkap, id_tpk, wallet_address, funding_status,
              funding_tx_hash, funding_amount_wei, funding_attempted_at
         FROM tpk_members
        ORDER BY nama_lengkap NULLS LAST, nik`
    ));
    const { enriched, fundedNiks } = await enrichFundingStatuses(result.rows);
    if (fundedNiks.length) {
      await db.transaksi({ role: 'operator' }, (client) => client.query(
        `UPDATE tpk_members
            SET funding_status = 'funded', funding_error = NULL
          WHERE nik = ANY($1::text[])
            AND wallet_address IS NOT NULL`,
        [fundedNiks]
      ));
    }
    return res.json({
      success: true,
      members: enriched,
    });
  } catch (error) {
    console.error('Panel funding gagal membaca daftar TPK:', error.message);
    return res.status(500).json({ success: false, message: 'Daftar TPK gagal dibaca dari Supabase.' });
  }
});

app.post('/api/configure', protect, async (req, res) => {
  try {
    const config = validateConfig(req.body || {});
    const values = {
      TPK_AUTO_FUND_ENABLED: 'true',
      TPK_FUNDING_PRIVATE_KEY: config.privateKey,
      TPK_FUNDING_AMOUNT_ETH: config.amountEth,
      TPK_FUNDING_RPC_URL: config.rpcUrl,
    };
    updateDotEnv(values);
    Object.assign(process.env, values);

    if (req.body.syncVercel !== false) {
      for (const [name, value] of Object.entries(values)) {
        const args = ['env', 'add', name, '--environment', 'production', '--force', '--sensitive'];
        await runVercel(args, value);
      }
      await runVercel(['deploy', '--cwd', '..', '--project', 'pendampingan-app-mvbo', '--prod', '--yes']);
    }

    return res.json({ success: true, message: 'Konfigurasi tersimpan dan Production berhasil di-redeploy.' });
  } catch (error) {
    console.error('Panel funding gagal mengonfigurasi:', error.message);
    return res.status(500).json({ success: false, message: error.message || 'Konfigurasi funding gagal.' });
  }
});

app.listen(port, '127.0.0.1', () => {
  const panelUrl = `http://127.0.0.1:${port}/?token=${token}`;
  console.log(`Panel funding lokal: ${panelUrl}`);
  console.log('Panel hanya mendengarkan localhost. Tekan Ctrl+C untuk menutup.');
  openBrowser(panelUrl);
});
