/**
 * 长期稳定重构版 index.js（单文件）
 * - spawn 管理子进程
 * - 可重试 / 可超时 / 可观测
 */

const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');
const unzipper = require('unzipper');
const { spawn } = require('child_process');

/* ================== 基础配置 ================== */

const FILE_PATH = process.env.FILE_PATH || './tmp';
const SUB_PATH = process.env.SUB_PATH || 'sub';
const PORT = process.env.PORT || 3000;
const UUID = process.env.UUID || '';

const XRAY_VERSION = process.env.XRAY_VERSION || '25.12.8';
const CLOUDFLARED_VERSION = process.env.CLOUDFLARED_VERSION || '2025.11.1';

const ARGO_PORT = process.env.ARGO_PORT || 8001;
const ARGO_AUTH = process.env.ARGO_AUTH || 'ey';
const ARGO_DOMAIN = process.env.ARGO_DOMAIN || 'domain';

const CFIP = process.env.CFIP || 'cdns.doon.eu.org';
const CFPORT = process.env.CFPORT || 443;
const NAME = process.env.NAME || '';

/* ================== 全局状态 ================== */

const state = {
  ready: false,
  sub: '',
  domain: '',
  error: ''
};

/* ================== 工具函数 ================== */
async function downloadWithFallback(urls, dest, retries = 2) {
  let lastErr;

  for (const url of urls) {
    try {
      await retry(() => downloadFile(url, dest), retries);
      return; // 成功直接返回
    } catch (e) {
      lastErr = e;
      try { if (fs.existsSync(dest)) fs.unlinkSync(dest); } catch {}
    }
  }

  throw lastErr || new Error('All download sources failed');
}


function randomName(len = 6) {
  const chars = 'abcdefghijklmnopqrstuvwxyz';
  return Array.from({ length: len }, () =>
    chars[Math.floor(Math.random() * chars.length)]
  ).join('');
}
function delayedCleanup(files, delayMs = 60000) {
  setTimeout(() => {
    for (const f of files) {
      try {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      } catch {}
    }
  }, delayMs);
}
function randomUA() {
  const uas = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    'Mozilla/5.0 (X11; Linux x86_64)',
    'curl/7.88.1',
    'Wget/1.21.4'
  ];
  return uas[Math.floor(Math.random() * uas.length)];
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function retry(fn, times = 3, delay = 1000) {
  for (let i = 0; i < times; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i === times - 1) throw e;
      await sleep(delay);
    }
  }
}

function getArch() {
  const a = os.arch();
  if (a.includes('arm')) return 'arm';
  return 'amd';
}

function spawnDetached(cmd, args, fakeName) {
  const devNull = fs.openSync('/dev/null', 'w');
  const p = spawn(cmd, args, {
    detached: true,
    stdio: ['ignore', devNull, devNull],
    argv0: fakeName
  });
  p.unref();
  return p.pid;
}



/* ================== 下载 ================== */

async function downloadFile(url, dest) {
  const res = await axios.get(url, {
    responseType: 'stream',
    timeout: 15000,
    headers: { 'User-Agent': randomUA() },
    validateStatus: s => s === 200
  });

  await new Promise((resolve, reject) => {
    const w = fs.createWriteStream(dest);
    res.data.pipe(w);
    w.on('finish', resolve);
    w.on('error', reject);
  });
}

async function downloadXray(xrayPath) {
  if (fs.existsSync(xrayPath)) return;

  const arch = getArch();

  const fileName = arch === 'arm'
    ? `xray-linux-arm64-v8a`
    : `xray-linux-64`;
  
  const official = `https://github.com/XTLS/Xray-core/releases/download/v${XRAY_VERSION}/${fileName}.zip`;
  const mirror = `https://download.lycn.qzz.io/${fileName}`;

  const zipPath = `${xrayPath}.zip`;

  await downloadWithFallback(
    [official, mirror],
    zipPath
  );

  await new Promise((resolve, reject) => {
    fs.createReadStream(zipPath)
      .pipe(unzipper.Parse())
      .on('entry', entry => {
        if (entry.path === 'xray') {
          entry.pipe(fs.createWriteStream(xrayPath));
        } else {
          entry.autodrain();
        }
      })
      .on('close', resolve)
      .on('error', reject);
  });

  fs.chmodSync(xrayPath, 0o755);
  fs.unlinkSync(zipPath);
}



async function downloadCloudflared(binPath) {
  if (fs.existsSync(binPath)) return;

  const arch = getArch();

  const fileName = arch === 'arm'
    ? `cloudflared-linux-arm64`
    : `cloudflared-linux-amd64`;

  const official = `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/${fileName}`;
  const mirror = `https://download.lycn.qzz.io/${fileName}`;

  await downloadWithFallback(
    [official, mirror],
    binPath
  );

  fs.chmodSync(binPath, 0o755);
}


/* ================== Xray ================== */

function writeXrayConfig(configPath) {
  const config = {
    log: { loglevel: 'none' },
    inbounds: [
      {
        port: ARGO_PORT,
        protocol: 'vless',
        settings: {
          clients: [{ id: UUID }],
          decryption: 'none',
          fallbacks: [{ path: '/vmess-argo', dest: 3003 }]
        }
      },
      {
        port: 3003,
        listen: '127.0.0.1',
        protocol: 'vmess',
        settings: { clients: [{ id: UUID, alterId: 0 }] },
        streamSettings: {
          network: 'ws',
          wsSettings: { path: '/vmess-argo' }
        }
      }
    ],
    outbounds: [{ protocol: 'freedom' }]
  };

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

/* ================== cloudflared ================== */

async function waitForDomain(logFile, timeout = 20000) {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    if (fs.existsSync(logFile)) {
      const txt = fs.readFileSync(logFile, 'utf8');
      const m = txt.match(/https?:\/\/([^ ]*trycloudflare\.com)/);
      if (m) return m[1];
    }
    await sleep(500);
  }
  throw new Error('cloudflared domain timeout');
}

/* ================== 订阅 ================== */

async function buildSub(domain) {
  let meta = 'Unknown';
  try {
    const r = await axios.get('https://speed.cloudflare.com/meta', { timeout: 5000 });
    meta = `${r.data.clientCountry}-${r.data.asOrganization.replace(/\s+/g, '_')}`;
  } catch {}

  const ps = NAME ? `${NAME}-${meta}` : meta;

  const vmess = {
    v: '2',
    ps,
    add: CFIP,
    port: CFPORT,
    id: UUID,
    aid: '0',
    net: 'ws',
    type: 'none',
    host: domain,
    path: '/vmess-argo',
    tls: 'tls'
  };

  return Buffer.from(
    `vmess://${Buffer.from(JSON.stringify(vmess)).toString('base64')}`
  ).toString('base64');
}

/* ================== 主流程 ================== */

(async () => {
  const startupDelay = Math.floor(Math.random() * 12000) + 3000; // 3–15s
  await sleep(startupDelay);

  try {
    if (!UUID) throw new Error('UUID required');

    ensureDir(FILE_PATH);

    const xrayName = randomName();
    const cloudflaredName = randomName();
    
    const xrayPath = path.join(FILE_PATH, xrayName);
    const cloudflaredPath = path.join(FILE_PATH, cloudflaredName);
    
    const configPath = path.join(FILE_PATH, 'config.json');
    
    const tasks = [
      () => downloadXray(xrayPath),
      () => downloadCloudflared(cloudflaredPath)
    ];
    
    for (const task of tasks.sort(() => Math.random() - 0.5)) {
      await task();
    }
    

    writeXrayConfig(configPath);

    spawnDetached(xrayPath, ['run', '-c', configPath], '[kworker/u8:2]');

    const cfArgs = ARGO_AUTH
      ? ['tunnel', 'run', '--token', ARGO_AUTH]
      : ['tunnel', '--logfile', cfLog, '--url', `http://localhost:${ARGO_PORT}`];

    spawnDetached(cloudflaredPath, cfArgs, '[dbus-daemon]');

    /* 60s 后删除二进制文件 & config */
    delayedCleanup([
      xrayPath,
      cloudflaredPath,
      configPath
    ], 60000);

    const domain = ARGO_DOMAIN;
    const sub = await buildSub(domain);

    state.ready = true;
    state.domain = domain;
    state.sub = sub;

    console.log('Service ready:', domain);
  } catch (e) {
    state.error = e.message;
    console.error('Startup failed:', e.message);
  }
})();

/* ================== HTTP ================== */

const app = express();

app.get('/', async (req, res) => {
  try {
    // 尝试读取当前目录下的 index.html
    const html = await fs.promises.readFile(path.join(__dirname, 'index.html'), 'utf8');
    res.send(html);
  } catch (err) {
    // 如果读取失败（文件不存在等），返回基础状态
    res.send('Service is running. Visit /' + SUB_PATH);
  }
});

app.get('/health', (_, res) => {
  res.json(state);
});

app.get(`/${SUB_PATH}`, (_, res) => {
  if (!state.ready) return res.status(503).send('Not ready');
  res.type('text/plain').send(state.sub);
});

app.listen(PORT, () => {
  console.log('Listening on', PORT);
});

