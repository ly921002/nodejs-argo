// 精简版 index_vm.js

const express = require("express");
const app = express();
const axios = require("axios");
const os = require('os');
const fs = require("fs");
const path = require("path");
const { promisify } = require('util');
const exec = promisify(require('child_process').exec);
const { execSync } = require('child_process');

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

// komari-agent
const ENDPOINT = process.env.ENDPOINT || '';
const TOKEN = process.env.TOKEN || '';

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
const komariAgentName = 'komari-agent';
const configName = 'config.json'; // 新增配置文件名

const webPath = path.join(FILE_PATH, webName);
const botPath = path.join(FILE_PATH, botName);
const komariAgentPath = path.join(FILE_PATH, komariAgentName);
const subPath = path.join(FILE_PATH, 'sub.txt');
const bootLogPath = path.join(FILE_PATH, 'boot.log');
const configPath = path.join(FILE_PATH, configName); // 新增配置文件路径

/**********************
 * komari-agent 下载与启动
 **********************/
async function downloadKomariAgent() {
  if (fs.existsSync(komariAgentPath)) return true;

  const arch = getSystemArchitecture();
  const url = arch === 'arm'
    ? 'https://raw.githubusercontent.com/ly921002/gcp/main/komari-agent-linux-arm64'
    : 'https://raw.githubusercontent.com/ly921002/gcp/main/komari-agent-linux-amd64';

  const res = await axios.get(url, { responseType: 'stream' });
  const writer = fs.createWriteStream(komariAgentPath);
  res.data.pipe(writer);

  return new Promise((resolve, reject) => {
    writer.on('finish', () => {
      fs.chmodSync(komariAgentPath, 0o755);
      resolve(true);
    });
    writer.on('error', reject);
  });
}

function startKomariAgent() {
  if (!ENDPOINT || !TOKEN) return;
  const cmd = `nohup ${komariAgentPath} -e ${ENDPOINT} -t ${TOKEN} > ${FILE_PATH}/komari-agent.log 2>&1 &`;
  exec(cmd).catch(() => {});
}

/**********************
 * Xray 配置（仅 VMESS fallback）
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
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2)); // 使用 configPath
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

  await exec(`nohup ${webPath} -c ${configPath} >/dev/null 2>&1 &`); // 使用 configPath

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
    const res = await axios.get('https://speed.cloudflare.com/meta', {
      timeout: 5000
    });
    if (res.data && res.data.clientCountry && res.data.asOrganization) {
      // 替换多个空格为单个下划线
      return `${res.data.clientCountry}-${res.data.asOrganization.replace(/\s+/g, '_')}`;
    }
  } catch (e) {
    // ignore
  }
  return 'Unknown';
}

async function extractDomains() {
  let domain = ARGO_DOMAIN;

  if (!domain) {
    // 确保 bootLogPath 存在，否则读取会失败
    if (!fs.existsSync(bootLogPath)) {
        console.log('boot.log not found, cannot extract temporary domain.');
        return;
    }
    const log = fs.readFileSync(bootLogPath, 'utf-8');
    // 提取 trycloudflare.com 域名
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

  const content = Buffer.from(`vmess://${Buffer.from(JSON.stringify(vmess)).toString('base64')}`).toString('base64');
  fs.writeFileSync(subPath, content);

  app.get(`/${SUB_PATH}`, (req, res) => {
    res.type('text/plain').send(content);
  });
}

/**********************
 * Telegram 推送（可选）
 **********************/
async function pushTelegram() {
  if (!BOT_TOKEN || !CHAT_ID || !fs.existsSync(subPath)) return;
  const txt = Buffer.from(fs.readFileSync(subPath, 'utf-8'), 'base64').toString();
  await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    chat_id: CHAT_ID,
    text: txt
  });
}

/**********************
 * 删除相关文件
 **********************/
function cleanFiles() {
  setTimeout(() => {
    const filesToDelete = [bootLogPath, configPath, webPath, botPath];

    // Windows系统使用不同的删除命令
    if (process.platform === 'win32') {
      exec(`del /f /q ${filesToDelete.join(' ')} > nul 2>&1`, (error) => {
        console.clear();
        console.log('App is running');
        console.log('Thank you for using this script, enjoy!');
      });
    } else {
      // 在 Unix/Linux 上使用 rm -f
      exec(`rm -f ${filesToDelete.join(' ')} >/dev/null 2>&1`, (error) => {
        console.clear();
        console.log('App is running');
        console.log('Thank you for using this script, enjoy!');
      });
    }
  }, 90000); // 90s
}

/**********************
 * HTTP 路由
 **********************/
app.get('/', async (req, res) => {
  try {
    // 假设 index.html 存在于当前执行目录，如果不存在会 fallback
    const html = await fs.promises.readFile(path.join(__dirname, 'index.html'), 'utf8');
    res.send(html);
  } catch {
    res.send('Service is running. Visit /' + SUB_PATH);
  }
});

/**********************
 * 主流程
 **********************/
(async () => {
  await downloadKomariAgent();
  await generateConfig();
  await downloadAndRun();
  startKomariAgent();
  await extractDomains();
  await pushTelegram();
  cleanFiles(); // 在主流程末尾调用
})();

app.listen(PORT, () => console.log('Server listening on', PORT));
