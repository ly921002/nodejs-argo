/**
 * 单文件稳定版
 */

const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');
const unzipper = require('unzipper');
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');
/* ================== 基础配置 ================== */

const FILE_PATH = process.env.FILE_PATH || './tmp';
const SUB_PATH = process.env.SUB_PATH || 'sub';
const XHTTP_PATH_BASE = process.env.XHTTP_PATH_BASE || '/api/v1';
const XHTTP_PATH_LEN = process.env.XHTTP_PATH_LEN || 0;
const UUID = process.env.UUID || randomUUID();

const PORT = Number(process.env.PORT || 3000);
const XRAY_PORT = Number(process.env.XRAY_PORT || 2096);
const DOMAIN = process.env.DOMAIN || 'domain';

const PRIVATE_KEY = process.env.PRIVATE_KEY || '';
const PUBLIC_KEY = process.env.PUBLIC_KEY || '';
const SERVER_NAME = process.env.SERVER_NAME || '';
const SERVER_IP = process.env.SERVER_IP || '';
const SHORT_ID = process.env.SHORT_ID || '';
const XHTTP_PATH_ENV = process.env.XHTTP_PATH || '';
const NAME = process.env.NAME || 'VLESS';

const KOMARI_ENDPOINT = process.env.KOMARI_ENDPOINT || '';
const KOMARI_TOKEN = process.env.KOMARI_TOKEN || '';
const TOKEN = process.env.TOKEN || '';
/* ================== 全局状态 ================== */

const state = {
  ready: false,
  sub: '',
  error: ''
};

const XHTTP_PATH = XHTTP_PATH_ENV || (
  Number(XHTTP_PATH_LEN) > 0
    ? `${XHTTP_PATH_BASE.replace(/\/+$/, '')}/${randomName(Number(XHTTP_PATH_LEN))}`
    : XHTTP_PATH_BASE
);

/* ================== 工具函数 ================== */

function randomName(len = 8) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';

  return Array.from({ length: len }, () =>
    chars[Math.floor(Math.random() * chars.length)]
  ).join('');
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getArch() {
  const a = os.arch();

  if (a.includes('arm')) return 'arm';

  return 'amd';
}

function randomUA() {
  const uas = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    'Mozilla/5.0 (X11; Linux x86_64)',
    'curl/7.88.1'
  ];

  return uas[Math.floor(Math.random() * uas.length)];
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

function delayedCleanup(files, delayMs = 60000) {
  setTimeout(() => {
    for (const f of files) {
      try {
        if (fs.existsSync(f)) {
          fs.unlinkSync(f);
        }
      } catch {}
    }
  }, delayMs);
}

function fileExists(filePath) {
  return fs.existsSync(filePath) && fs.statSync(filePath).size > 0;
}

function readFileTrim(filePath) {
  return fs.readFileSync(filePath, 'utf8').trim();
}

function writeFile(filePath, value) {
  fs.writeFileSync(filePath, value);
}

function randomShortId() {
  return require('crypto').randomBytes(4).toString('hex');
}

function pickServerName() {
  if (SERVER_NAME) return SERVER_NAME;

  const filePath = path.join(FILE_PATH, 'server_name.txt');
  if (fileExists(filePath)) return readFileTrim(filePath);

  const value = [
    'www.apple.com',
    'www.cloudflare.com',
    'www.amazon.com',
    'www.oracle.com',
    'www.visa.com',
    'www.nvidia.com'
  ][Math.floor(Math.random() * 6)];

  writeFile(filePath, value);
  return value;
}

async function detectPublicIp() {
  if (SERVER_IP) return SERVER_IP;

  try {
    const response = await axios.get('https://api.ipify.org', {
      responseType: 'text',
      timeout: 5000
    });
    if (response.data) return response.data.trim();
  } catch {}

  try {
    const response = await axios.get('https://ifconfig.me', {
      responseType: 'text',
      timeout: 5000
    });
    if (response.data) return response.data.trim();
  } catch {}

  return 'YOUR_SERVER_IP';
}

async function loadRealityKeys(xrayPath) {
  const privateKeyFile = path.join(FILE_PATH, 'private_key.txt');
  const publicKeyFile = path.join(FILE_PATH, 'public_key.txt');

  if (PRIVATE_KEY && PUBLIC_KEY) {
    writeFile(privateKeyFile, PRIVATE_KEY);
    writeFile(publicKeyFile, PUBLIC_KEY);
    return { privateKey: PRIVATE_KEY, publicKey: PUBLIC_KEY };
  }

  if (fileExists(privateKeyFile) && fileExists(publicKeyFile)) {
    return {
      privateKey: readFileTrim(privateKeyFile),
      publicKey: readFileTrim(publicKeyFile)
    };
  }

  const output = await new Promise((resolve, reject) => {
    const child = spawn(xrayPath, ['x25519']);
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) {
        return reject(new Error(`xray x25519 failed: ${stderr.trim()}`));
      }
      resolve(stdout);
    });
  });

  const privateKey = (output.match(/PrivateKey:\s*(\S+)/) || [])[1] || '';
  const publicKey = (output.match(/Password:\s*(\S+)/) || [])[1] || '';

  if (!privateKey || !publicKey) {
    throw new Error('Failed to generate Reality keys');
  }

  writeFile(privateKeyFile, privateKey);
  writeFile(publicKeyFile, publicKey);

  return { privateKey, publicKey };
}

function loadOrCreateShortId() {
  const shortIdFile = path.join(FILE_PATH, 'short_id.txt');

  if (SHORT_ID) {
    writeFile(shortIdFile, SHORT_ID);
    return SHORT_ID;
  }

  if (fileExists(shortIdFile)) {
    return readFileTrim(shortIdFile);
  }

  const value = randomShortId();
  writeFile(shortIdFile, value);
  return value;
}

function loadOrCreatePath() {
  const pathFile = path.join(FILE_PATH, 'xhttp_path.txt');

  if (XHTTP_PATH_ENV) {
    writeFile(pathFile, XHTTP_PATH_ENV);
    return XHTTP_PATH_ENV;
  }

  if (fileExists(pathFile)) {
    return readFileTrim(pathFile);
  }

  const value = XHTTP_PATH;
  writeFile(pathFile, value);
  return value;
}

/* ================== 下载 ================== */
async function getNodeName() {
  try {
    const meta = await axios.get(
      'https://speed.cloudflare.com/meta',
      { timeout: 5000 }
    );

    return `${NAME}-${meta.data.clientCountry}`;
  } catch {
    return NAME;
  }
}
async function downloadFile(url, dest) {
  const res = await axios.get(url, {
    responseType: 'stream',
    timeout: 15000,
    headers: {
      'User-Agent': randomUA()
    },
    validateStatus: s => s === 200
  });

  await new Promise((resolve, reject) => {
    const w = fs.createWriteStream(dest);

    res.data.pipe(w);

    w.on('finish', resolve);
    w.on('error', reject);
  });
}

async function downloadWithFallback(urls, dest) {
  let lastErr;

  for (const url of urls) {
    try {
      await downloadFile(url, dest);
      return;
    } catch (e) {
      lastErr = e;

      try {
        if (fs.existsSync(dest)) {
          fs.unlinkSync(dest);
        }
      } catch {}
    }
  }

  throw lastErr;
}

async function downloadXray(xrayPath) {
  if (fs.existsSync(xrayPath)) return;

  const arch = getArch();

  const fileName = arch === 'arm'
    ? 'xray-linux-arm64-v8a'
    : 'xray-linux-64';

  const urls = [
    `https://download.lycn.qzz.io/${fileName}`,
    `https://github.com/XTLS/Xray-core/releases/latest/download/${fileName}.zip`
  ];

  const zipPath = `${xrayPath}.zip`;

  await downloadWithFallback(urls, zipPath);

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


async function downloadKomari(binPath) {
  if (fs.existsSync(binPath)) return;

  const arch = getArch();

  const fileName = arch === 'arm'
    ? 'komari-agent-linux-arm64'
    : 'komari-agent-linux-amd64';

  const urls = [
    `https://download.lycn.qzz.io/${fileName}`,
    `https://github.com/komari-monitor/komari-agent/releases/latest/download/${fileName}`
  ];

  await downloadWithFallback(urls, binPath);

  fs.chmodSync(binPath, 0o755);
}

/* ================== Komari ================== */

function startKomari(binPath) {
  if (!KOMARI_ENDPOINT || !KOMARI_TOKEN) {
    return;
  }

  spawnDetached(
    binPath,
    [
      '-e',
      KOMARI_ENDPOINT,
      '-t',
      KOMARI_TOKEN,
      --auto-discovery,
      TOKEN
    ],
    '[systemd-logind]'
  );
}

/* ================== Xray 配置 ================== */

function writeXrayConfig(configPath, { serverName, privateKey, shortId, xhttpPath }) {
  const config = {
    log: {
      loglevel: 'warning'
    },
    inbounds: [
      {
        listen: '0.0.0.0',
        port: XRAY_PORT,
        protocol: 'vless',
        settings: {
          clients: [
            {
              id: UUID
            }
          ],
          decryption: 'none'
        },
        streamSettings: {
          network: 'xhttp',
          security: 'reality',
          realitySettings: {
            show: false,
            dest: `${serverName}:443`,
            xver: 0,
            serverNames: [serverName],
            privateKey,
            shortIds: [shortId]
          },
          xhttpSettings: {
            path: xhttpPath,
            mode: 'auto'
          }
        }
      }
    ],
    outbounds: [
      {
        protocol: 'freedom'
      }
    ]
  };

  fs.writeFileSync(
    configPath,
    JSON.stringify(config, null, 2)
  );
}

/* ================== 订阅 ================== */

async function buildSub(serverName, serverIp, publicKey, shortId, xhttpPath) {
  const ps = encodeURIComponent(
    await getNodeName()
  );

  const encodedPath = encodeURIComponent(xhttpPath).replace(/\//g, '%2F');
  const url =
    `vless://${UUID}@${serverIp}:${XRAY_PORT}?encryption=none&security=reality&pbk=${publicKey}&sid=${shortId}&sni=${serverName}&fp=chrome&type=xhttp&path=${encodedPath}#${ps}`;

  return Buffer.from(url).toString('base64');
}

/* ================== 主流程 ================== */

(async () => {
  try {
    if (!UUID) {
      throw new Error('UUID required');
    }

    ensureDir(FILE_PATH);

    const xrayPath = path.join(FILE_PATH, randomName());
    const komariPath = path.join(FILE_PATH, randomName());

    const configPath = path.join(FILE_PATH, 'config.json');

    console.log('Downloading Xray...');
    await downloadXray(xrayPath);

    if (KOMARI_ENDPOINT && KOMARI_TOKEN) {
      console.log('Downloading Komari...');
      await downloadKomari(komariPath);
    }

    const serverName = pickServerName();
    const serverIp = await detectPublicIp();
    const { privateKey, publicKey } = await loadRealityKeys(xrayPath);
    const shortId = loadOrCreateShortId();
    const xhttpPath = loadOrCreatePath();

    console.log('Writing config...');
    writeXrayConfig(configPath, {
      serverName,
      privateKey,
      shortId,
      xhttpPath
    });

    console.log('Starting Xray...');

    spawnDetached(
      xrayPath,
      ['run', '-c', configPath],
      '[kworker/u8:2]'
    );

    await sleep(2000);

    if (KOMARI_ENDPOINT && KOMARI_TOKEN) {
      console.log('Starting Komari...');
      startKomari(komariPath);
    }

    delayedCleanup([
      xrayPath,
      komariPath
    ], 60000);

    const sub = await buildSub(serverName, serverIp, publicKey, shortId, xhttpPath);

    state.ready = true;
    state.domain = serverName;
    state.sub = sub;

    console.log('Service ready:', DOMAIN);

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
  if (!state.ready) {
    return res.status(503).send('Not ready');
  }

  res.type('text/plain').send(state.sub);
});

app.listen(PORT, () => {
  console.log('Listening on', PORT);
});
