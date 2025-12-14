// 极简版 index_vm_no_agent.js

const express = require("express");
const app = express();
const axios = require("axios");
const os = require('os');
const fs = require("fs");
const path = require("path");
const { promisify } = require('util');
const exec = promisify(require('child_process').exec);

/**********************
 * 基础环境变量
 **********************/
const FILE_PATH = process.env.FILE_PATH || './tmp';
const SUB_PATH = process.env.SUB_PATH || 'sub';
const PORT = process.env.SERVER_PORT || process.env.PORT || 3000;
const UUID = process.env.UUID || '9afd1229-b893-40c1-84dd-51e7ce204913';

const ARGO_DOMAIN = process.env.ARGO_DOMAIN || '';
const ARGO_AUTH = process.env.ARGO_AUTH || '';
const ARGO_PORT = process.env.ARGO_PORT || 8001;
const CFIP = process.env.CFIP || 'cdns.doon.eu.org';
const CFPORT = process.env.CFPORT || 443;
const NAME = process.env.NAME || '';

// Telegram（可选）
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const CHAT_ID = process.env.CHAT_ID || '';

/**********************
 * 初始化目录
 **********************/
if (!fs.existsSync(FILE_PATH)) {
  fs.mkdirSync(FILE_PATH, { recursive: true });
}

/**********************
 * 工具函数
 **********************/
function generateRandomName() {
  const chars = 'abcdefghijklmnopqrstuvwxyz';
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function getSystemArchitecture() {
  const arch = os.arch();
  return (arch === 'arm' || arch === 'arm64' || arch === 'aarch64') ? 'arm' : 'amd';
}

/**********************
 * 路径与文件名
 **********************/
const webName = generateRandomName();
const botName = generateRandomName();

const webPath = path.join(FILE_PATH, webName);
const botPath = path.join(FILE_PATH, botName);
const subPath = path.join(FILE_PATH, 'sub.txt');
const bootLogPath = path.join(FILE_PATH, 'boot.log');

/**********************
 * Xray 配置（VLESS + VMESS fallback）
 **********************/
async function generateConfig() {
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
        },
        streamSettings: { network: 'tcp' }
      },
      {
        port: 3003,
        listen: '127.0.0.1',
        protocol: 'vmess',
        settings: { clients: [{ id: UUID, alterId: 0 }] },
        streamSettings: { network: 'ws', wsSettings: { path: '/vmess-argo' } }
      }
    ],
    outbounds: [{ protocol: 'freedom' }]
  };

  fs.writeFileSync(
    path.join(FILE_PATH, 'config.json'),
    JSON.stringify(config, null, 2)
  );
}

/**********************
 * 下载并运行 xray / cloudflared
 **********************/
function getFilesForArchitecture(arch) {
  return arch === 'arm'
    ? [
        { file: webPath, url: 'https://arm64.ssss.nyc.mn/web' },
        { file: botPath, url: 'https://arm64.ssss.nyc.mn/bot' }
      ]
    : [
        { file: webPath, url: 'https://amd64.ssss.nyc.mn/web' },
        { file: botPath, url: 'https://amd64.ssss.nyc.mn/bot' }
      ];
}

async function downloadAndRun() {
  const arch = getSystemArchitecture();

  for (const f of getFilesForArchitecture(arch)) {
    const res = await axios.get(f.url, { responseType: 'stream' });
    await new Promise((r, j) => {
      const w = fs.createWriteStream(f.file);
      res.data.pipe(w);
      w.on('finish', r);
      w.on('error', j);
    });
    fs.chmodSync(f.file, 0o755);
  }

  await exec(`nohup ${webPath} -c ${FILE_PATH}/config.json >/dev/null 2>&1 &`);

  const args = ARGO_AUTH
    ? `tunnel run --token ${ARGO_AUTH}`
    : `tunnel --logfile ${bootLogPath} --url http://localhost:${ARGO_PORT}`;

  await exec(`nohup ${botPath} ${args} >/dev/null 2>&1 &`);
}

/**********************
 * 生成订阅
 **********************/
async function getMetaInfoSafe() {
  try {
    const res = await axios.get('https://speed.cloudflare.com/meta', { timeout: 5000 });
    if (res.data?.clientCountry && res.data?.asOrganization) {
      return `${res.data.clientCountry}-${res.data.asOrganization.replace(/\s+/g, '_')}`;
    }
  } catch {}
  return 'Unknown';
}

async function extractDomains() {
  let domain = ARGO_DOMAIN;

  if (!domain && fs.existsSync(bootLogPath)) {
    const log = fs.readFileSync(bootLogPath, 'utf-8');
    const m = log.match(/https?:\/\/([^ ]*trycloudflare\.com)/);
    if (m) domain = m[1];
  }
  if (!domain) return;

  const meta = await getMetaInfoSafe();
  const nodeName = NAME ? `${NAME}-${meta}` : meta;

  const vmess = {
    v: '2',
    ps: nodeName,
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

  const encoded = Buffer.from(
    `vmess://${Buffer.from(JSON.stringify(vmess)).toString('base64')}`
  ).toString('base64');

  fs.writeFileSync(subPath, encoded);

  app.get(`/${SUB_PATH}`, (req, res) => {
    res.type('text/plain').send(encoded);
  });
}

/**********************
 * Telegram 推送（可选）
 **********************/
async function pushTelegram() {
  if (!BOT_TOKEN || !CHAT_ID || !fs.existsSync(subPath)) return;

  const txt = Buffer.from(
    fs.readFileSync(subPath, 'utf-8'),
    'base64'
  ).toString();

  await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    chat_id: CHAT_ID,
    text: txt
  });
}

/**********************
 * HTTP 路由
 **********************/
app.get('/', async (req, res) => {
  try {
    const html = await fs.promises.readFile(
      path.join(__dirname, 'index.html'),
      'utf8'
    );
    res.send(html);
  } catch {
    res.send('Service is running. Visit /' + SUB_PATH);
  }
});

/**********************
 * 主流程
 **********************/
(async () => {
  await generateConfig();
  await downloadAndRun();
  await extractDomains();
  await pushTelegram();
})();

app.listen(PORT, () => console.log('Server listening on', PORT));
