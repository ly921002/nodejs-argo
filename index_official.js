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

// 现在从环境变量中获取 XRAY_VERSION 和 CLOUDFLARED_VERSION，并提供默认值
const XRAY_VERSION = process.env.XRAY_VERSION || '25.12.8'; 
const CLOUDFLARED_VERSION = process.env.CLOUDFLARED_VERSION || '2025.11.1';
const KOMARI_VERSION = process.env.KOMARI_VERSION || '1.1.40';

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
  // 识别常见的ARM架构别名，归类为 'arm'
  if (arch === 'arm' || arch === 'arm64' || arch === 'aarch64') return 'arm';
  // 识别常见的AMD/Intel架构别名，归类为 'amd'
  if (arch === 'x64' || arch === 'x32' || arch === 'ia32') return 'amd';
  return 'unknown'; // 确保在遇到不常见架构时不会崩溃
}

// --- [获取Xray/Cloudflared的官方下载链接] ---
function getOfficialDownloadLinks(arch) {
  // 注意：此处使用了基础环境变量中定义的 XRAY_VERSION 和 CLOUDFLARED_VERSION
  if (arch === 'arm') {
    return {
      // Xray 版本号前带 v
      xrayUrl: `https://github.com/XTLS/Xray-core/releases/download/v${XRAY_VERSION}/Xray-linux-arm64-v8a.zip`,
      // Cloudflared 版本号前不带 v
      cloudflaredUrl: `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-arm64`,
    };
  } else if (arch === 'amd') {
    return {
      // Xray 版本号前带 v
      xrayUrl: `https://github.com/XTLS/Xray-core/releases/download/v${XRAY_VERSION}/Xray-linux-64.zip`,
      // Cloudflared 版本号前不带 v
      cloudflaredUrl: `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-amd64`,
    };
  }
  throw new Error(`Unsupported architecture: ${arch}`);
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
// --- [修正后的 komari-agent 下载逻辑] ---
async function downloadKomariAgent() {
  if (fs.existsSync(komariAgentPath)) return true;

  const arch = getSystemArchitecture();
  // 修正：使用反引号（`）进行模板字符串解析，并根据您的反馈移除 'v' 前缀。
  const url = arch === 'arm'
    ? `https://github.com/komari-monitor/komari-agent/releases/download/${KOMARI_VERSION}/komari-agent-linux-arm64`
    : `https://github.com/komari-monitor/komari-agent/releases/download/${KOMARI_VERSION}/komari-agent-linux-amd64`;
    
  try {
    const res = await axios.get(url, { responseType: 'stream' });
    
    // 检查 HTTP 状态码是否为 200 (OK)
    if (res.status !== 200) {
        throw new Error(`Failed to download komari-agent. Status: ${res.status}`);
    }
    
    const writer = fs.createWriteStream(komariAgentPath);
    res.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', () => {
        fs.chmodSync(komariAgentPath, 0o755);
        resolve(true);
      });
      writer.on('error', (err) => {
          fs.unlink(komariAgentPath, () => {}); // 尝试清理文件
          reject(err);
      });
    });
  } catch (error) {
      console.error(`Error in downloadKomariAgent: ${error.message}`);
      // 将原始错误重新抛出，以便主流程可以捕获并停止。
      throw error; 
  }
}
// --- [修正后的 komari-agent 下载逻辑结束] ---


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
// --- [修改后的下载逻辑] ---
async function downloadAndRun() {
  const arch = getSystemArchitecture();
  // links 使用了新的 getOfficialDownloadLinks 函数，该函数使用了环境变量中的版本号
  const links = getOfficialDownloadLinks(arch); 

  // 文件列表及对应的官方下载 URL
  // webPath 对应 Xray-core
  // botPath 对应 cloudflared
  const filesToDownload = [
    { file: webPath, url: links.xrayUrl, isZip: true }, // Xray 是 ZIP 包
    { file: botPath, url: links.cloudflaredUrl, isZip: false } // cloudflared 是单个文件
  ];

  for (const f of filesToDownload) {
    const downloadPath = f.isZip ? `${f.file}.zip` : f.file;
    const res = await axios.get(f.url, { responseType: 'stream' });

    // 1. 下载文件
    await new Promise((r, j) => {
      const w = fs.createWriteStream(downloadPath);
      res.data.pipe(w);
      w.on('finish', r);
      w.on('error', j);
    });

    // 2. 如果是 ZIP 包 (Xray-core)，解压并提取 Xray 可执行文件
    if (f.isZip) {
        // 使用系统命令解压 ZIP 包
        try {
            // 注意：这需要在系统上安装 unzip 命令
            execSync(`unzip -o ${downloadPath} xray -d ${FILE_PATH}`);
            // Xray 可执行文件被解压到 FILE_PATH/Xray
            const extractedXrayPath = path.join(FILE_PATH, 'xray');
            // 将解压后的 Xray 重命名为 webPath
            fs.renameSync(extractedXrayPath, webPath);
            // 清理 zip 文件
            fs.unlinkSync(downloadPath);
        } catch (e) {
            console.error('Error during Xray zip extraction:', e);
            throw new Error('Failed to extract Xray-core from zip.');
        }
    }

    // 3. 赋予执行权限
    fs.chmodSync(f.file, 0o755);
  }

  // 运行 Xray
  await exec(`nohup ${webPath} run -c ${configPath} >/dev/null 2>&1 &`); // 官方 Xray 运行命令是 'run -c'

  // 运行 cloudflared
  const args = ARGO_AUTH
    ? `tunnel run --token ${ARGO_AUTH}`
    : `tunnel --logfile ${bootLogPath} --url http://localhost:${ARGO_PORT}`;

  await exec(`nohup ${botPath} ${args} >/dev/null 2>&1 &`);
}
// --- [修改后的下载逻辑结束] ---


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
  try {
    await downloadKomariAgent();
    await generateConfig();
    await downloadAndRun();
    startKomariAgent();
    await extractDomains();
    await pushTelegram();
    cleanFiles(); // 在主流程末尾调用
  } catch (e) {
      console.error('An error occurred during startup:', e.message);
      process.exit(1);
  }
})();

app.listen(PORT, () => console.log('Server listening on', PORT));
