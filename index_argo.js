const express = require("express");
const app = express();
const axios = require("axios");
const os = require('os');
const fs = require("fs");
const path = require("path");
const { promisify } = require('util');
const exec = promisify(require('child_process').exec);
const { execSync } = require('child_process');
const { spawn } = require('child_process');

// 环境变量配置
const UPLOAD_URL = process.env.UPLOAD_URL || '';
const PROJECT_URL = process.env.PROJECT_URL || '';
const AUTO_ACCESS = process.env.AUTO_ACCESS || false;
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
// 环境变量配置 - 在原有配置后增加
const ENABLE_CF_ARGO = process.env.ENABLE_CF_ARGO || 'true'; // CF Argo 开关
const DIRECT_DOMAIN = process.env.DIRECT_DOMAIN || ''; // 直连域名
const DIRECT_PORT = process.env.DIRECT_PORT || 443; // 直连端口
// komari-agent相关环境变量
const ENDPOINT = process.env.ENDPOINT || 'https://gcp.240713.xyz'; // 需要替换为实际端点
const TOKEN = process.env.TOKEN || 'rP6F8lvOgWZXViUxnmDq1I';
// Telegram推送相关环境变量
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const CHAT_ID = process.env.CHAT_ID || '';

// 创建运行文件夹
if (!fs.existsSync(FILE_PATH)) {
  fs.mkdirSync(FILE_PATH, { recursive: true });
  console.log(`${FILE_PATH} is created`);
} else {
  console.log(`${FILE_PATH} already exists`);
}

// 生成随机6位字符文件名
function generateRandomName() {
  const characters = 'abcdefghijklmnopqrstuvwxyz';
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return result;
}

// 全局常量
const webName = generateRandomName();
const botName = generateRandomName();
const komariAgentName = 'komari-agent';
let webPath = path.join(FILE_PATH, webName);
let botPath = path.join(FILE_PATH, botName);
let komariAgentPath = path.join(FILE_PATH, komariAgentName);
let subPath = path.join(FILE_PATH, 'sub.txt');
let listPath = path.join(FILE_PATH, 'list.txt');
let bootLogPath = path.join(FILE_PATH, 'boot.log');
let configPath = path.join(FILE_PATH, 'config.json');

// 下载komari-agent
async function downloadKomariAgent() {
  if (fs.existsSync(komariAgentPath)) {
    console.log('komari-agent already exists');
    return true;
  }

  const architecture = getSystemArchitecture();
  let agentUrl;
  
  if (architecture === 'arm') {
    agentUrl = 'https://github.com/komari-monitor/komari-agent/releases/download/1.1.12/komari-agent-linux-arm64';
  } else {
    agentUrl = 'https://github.com/komari-monitor/komari-agent/releases/download/1.1.12/komari-agent-linux-amd64';
  }

  try {
    console.log('Downloading komari-agent...');
    const response = await axios({
      method: 'get',
      url: agentUrl,
      responseType: 'stream',
    });

    const writer = fs.createWriteStream(komariAgentPath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', () => {
        writer.close();
        // 设置执行权限
        fs.chmodSync(komariAgentPath, 0o755);
        console.log('komari-agent downloaded successfully');
        resolve(true);
      });
      writer.on('error', err => {
        fs.unlink(komariAgentPath, () => { });
        console.error(`komari-agent download failed: ${err.message}`);
        reject(err);
      });
    });
  } catch (error) {
    console.error('Error downloading komari-agent:', error.message);
    
    // 如果下载失败，尝试备用下载源
    console.log('Trying alternative download source...');
    return downloadKomariAgentAlternative();
  }
}

// 备用下载方法
async function downloadKomariAgentAlternative() {
  const architecture = getSystemArchitecture();
  let agentUrl;
  
  // 尝试不同的下载源
  if (architecture === 'arm') {
    agentUrl = 'https://github.com/komari-monitor/komari-agent/releases/download/1.1.12/komari-agent-linux-arm64';
  } else {
    agentUrl = 'https://github.com/komari-monitor/komari-agent/releases/download/1.1.12/komari-agent-linux-amd64';
  }

  try {
    console.log('Trying alternative download source...');
    const response = await axios({
      method: 'get',
      url: agentUrl,
      responseType: 'stream',
    });

    const writer = fs.createWriteStream(komariAgentPath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', () => {
        writer.close();
        fs.chmodSync(komariAgentPath, 0o755);
        console.log('komari-agent downloaded successfully from alternative source');
        resolve(true);
      });
      writer.on('error', err => {
        fs.unlink(komariAgentPath, () => { });
        console.error(`Alternative download failed: ${err.message}`);
        reject(err);
      });
    });
  } catch (error) {
    console.error('Error downloading komari-agent from alternative source:', error.message);
    return false;
  }
}

// 启动komari-agent（使用--ignore-unsafe-cert参数）
function startKomariAgent() {
  // 验证ENDPOINT格式
  if (!ENDPOINT || !ENDPOINT.startsWith('http')) {
    console.error('Invalid ENDPOINT format. It should be a valid URL starting with http:// or https://');
    console.log('Current ENDPOINT:', ENDPOINT);
    return;
  }

  if (!fs.existsSync(komariAgentPath)) {
    console.error('komari-agent not found at:', komariAgentPath);
    console.log('Available files in', FILE_PATH, ':', fs.readdirSync(FILE_PATH));
    return;
  }

  try {
    // 使用绝对路径
    const absolutePath = path.resolve(komariAgentPath);
    console.log('Starting komari-agent from:', absolutePath);
    
    // 使用--ignore-unsafe-cert参数启动komari-agent
    const args = ['-e', ENDPOINT, '-t', TOKEN, '--ignore-unsafe-cert'];
    
    console.log('Starting komari-agent with args:', args);
    
    // 修改为后台运行 - 使用nohup和&
    const command = `nohup ${absolutePath} ${args.join(' ')} > ${path.join(FILE_PATH, 'komari-agent.log')} 2>&1 &`;
    
    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error('Failed to start komari-agent:', error);
      } else {
        console.log('komari-agent started successfully in background');
        console.log(`ENDPOINT: ${ENDPOINT}`);
        console.log(`TOKEN: ${TOKEN}`);
        console.log(`Logs are being written to: ${path.join(FILE_PATH, 'komari-agent.log')}`);
      }
    });

  } catch (error) {
    console.error('Error starting komari-agent:', error);
  }
}

// 删除历史节点
function deleteNodes() {
  try {
    if (!UPLOAD_URL) return;
    if (!fs.existsSync(subPath)) return;

    let fileContent;
    try {
      fileContent = fs.readFileSync(subPath, 'utf-8');
    } catch {
      return null;
    }

    const decoded = Buffer.from(fileContent, 'base64').toString('utf-8');
    const nodes = decoded.split('\n').filter(line => 
      /(vless|vmess|trojan|hysteria2|tuic):\/\//.test(line)
    );

    if (nodes.length === 0) return;

    axios.post(`${UPLOAD_URL}/api/delete-nodes`, 
      JSON.stringify({ nodes }),
      { headers: { 'Content-Type': 'application/json' } }
    ).catch((error) => { 
      return null; 
    });
    return null;
  } catch (err) {
    return null;
  }
}

// 清理历史文件
function cleanupOldFiles() {
  try {
    const files = fs.readdirSync(FILE_PATH);
    files.forEach(file => {
      const filePath = path.join(FILE_PATH, file);
      try {
        const stat = fs.statSync(filePath);
        // 保留komari-agent
        if (stat.isFile() && file !== komariAgentName && !file.includes('komari-agent')) {
          fs.unlinkSync(filePath);
        }
      } catch (err) {
        // 忽略错误
      }
    });
  } catch (err) {
    // 忽略错误
  }
}

// 根路由
app.get("/", function(req, res) {
  res.send("Hello world!");
});

// 生成xr-ay配置文件
async function generateConfig() {
  const enableCFArgo = ENABLE_CF_ARGO.toLowerCase() === 'true';
  
  let config;
  
  if (enableCFArgo) {
    // CF Argo 开启模式：vmess+ws+tls+argo
    config = {
      log: { access: '/dev/null', error: '/dev/null', loglevel: 'none' },
      inbounds: [
        { 
          port: ARGO_PORT, 
          protocol: 'vless', 
          settings: { 
            clients: [{ id: UUID, flow: 'xtls-rprx-vision' }], 
            decryption: 'none', 
            fallbacks: [{ path: "/vmess-argo", dest: 3003 }]
          }, 
          streamSettings: { network: 'tcp' } 
        },
        { 
          port: 3003, 
          listen: "127.0.0.1", 
          protocol: "vmess", 
          settings: { clients: [{ id: UUID, alterId: 0 }] }, 
          streamSettings: { network: "ws", wsSettings: { path: "/vmess-argo" } }, 
          sniffing: { enabled: true, destOverride: ["http", "tls", "quic"], metadataOnly: false } 
        }
      ],
      dns: { servers: ["https+local://8.8.8.8/dns-query"] },
      outbounds: [ { protocol: "freedom", tag: "direct" }, {protocol: "blackhole", tag: "block"} ]
    };
  } else {
    // CF Argo 关闭模式：vmess+ws+tls 直连
    config = {
      log: { access: '/dev/null', error: '/dev/null', loglevel: 'none' },
      inbounds: [
        { 
          port: 3000, 
          listen: "0.0.0.0",
          protocol: "vmess", 
          settings: { 
            clients: [{ id: UUID, alterId: 0 }] 
          }, 
          streamSettings: { 
            network: "ws", 
            security: "tls",
            wsSettings: { 
              path: "/vmess-direct" 
            },
            tlsSettings: {
              serverName: DIRECT_DOMAIN,
              allowInsecure: false
            }
          }, 
          sniffing: { enabled: true, destOverride: ["http", "tls", "quic"], metadataOnly: false } 
        }
      ],
      dns: { servers: ["https+local://8.8.8.8/dns-query"] },
      outbounds: [ { protocol: "freedom", tag: "direct" }, {protocol: "blackhole", tag: "block"} ]
    };
  }
  
  fs.writeFileSync(path.join(FILE_PATH, 'config.json'), JSON.stringify(config, null, 2));
  console.log(`Configuration generated: ${enableCFArgo ? 'CF Argo Enabled' : 'Direct Mode'}`);
}

// 判断系统架构
function getSystemArchitecture() {
  const arch = os.arch();
  if (arch === 'arm' || arch === 'arm64' || arch === 'aarch64') {
    return 'arm';
  } else {
    return 'amd';
  }
}

// 下载文件函数
function downloadFile(fileName, fileUrl, callback) {
  const filePath = fileName; 
  
  if (!fs.existsSync(FILE_PATH)) {
    fs.mkdirSync(FILE_PATH, { recursive: true });
  }
  
  const writer = fs.createWriteStream(filePath);

  axios({
    method: 'get',
    url: fileUrl,
    responseType: 'stream',
  })
    .then(response => {
      response.data.pipe(writer);

      writer.on('finish', () => {
        writer.close();
        console.log(`Download ${path.basename(filePath)} successfully`);
        callback(null, filePath);
      });

      writer.on('error', err => {
        fs.unlink(filePath, () => { });
        const errorMessage = `Download ${path.basename(filePath)} failed: ${err.message}`;
        console.error(errorMessage);
        callback(errorMessage);
      });
    })
    .catch(err => {
      const errorMessage = `Download ${path.basename(filePath)} failed: ${err.message}`;
      console.error(errorMessage);
      callback(errorMessage);
    });
}

// 下载并运行依赖文件
async function downloadFilesAndRun() {  
  const architecture = getSystemArchitecture();
  const filesToDownload = getFilesForArchitecture(architecture);
  const enableCFArgo = ENABLE_CF_ARGO.toLowerCase() === 'true';

  if (filesToDownload.length === 0) {
    console.log(`Can't find a file for the current architecture`);
    return;
  }

  const downloadPromises = filesToDownload.map(fileInfo => {
    return new Promise((resolve, reject) => {
      downloadFile(fileInfo.fileName, fileInfo.fileUrl, (err, filePath) => {
        if (err) {
          reject(err);
        } else {
          resolve(filePath);
        }
      });
    });
  });

  try {
    await Promise.all(downloadPromises);
  } catch (err) {
    console.error('Error downloading files:', err);
    return;
  }

  // 授权文件
  function authorizeFiles(filePaths) {
    const newPermissions = 0o775;
    filePaths.forEach(absoluteFilePath => {
      if (fs.existsSync(absoluteFilePath)) {
        fs.chmod(absoluteFilePath, newPermissions, (err) => {
          if (err) {
            console.error(`Empowerment failed for ${absoluteFilePath}: ${err}`);
          } else {
            console.log(`Empowerment success for ${absoluteFilePath}: ${newPermissions.toString(8)}`);
          }
        });
      }
    });
  }
  
  const filesToAuthorize = [webPath];
  if (enableCFArgo) {
    filesToAuthorize.push(botPath);
  }
  authorizeFiles(filesToAuthorize);

  // 运行xr-ay
  const command1 = `nohup ${webPath} -c ${FILE_PATH}/config.json >/dev/null 2>&1 &`;
  try {
    await exec(command1);
    console.log(`${webName} is running`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  } catch (error) {
    console.error(`web running error: ${error}`);
  }

  // 仅在 CF Argo 开启时运行 cloudflared
  if (enableCFArgo && fs.existsSync(botPath)) {
    let args;

    if (ARGO_AUTH.match(/^[A-Z0-9a-z=]{120,250}$/)) {
      args = `tunnel --edge-ip-version auto --no-autoupdate --protocol http2 run --token ${ARGO_AUTH}`;
    } else if (ARGO_AUTH.match(/TunnelSecret/)) {
      args = `tunnel --edge-ip-version auto --config ${FILE_PATH}/tunnel.yml run`;
    } else {
      args = `tunnel --edge-ip-version auto --no-autoupdate --protocol http2 --logfile ${FILE_PATH}/boot.log --loglevel info --url http://localhost:${ARGO_PORT}`;
    }

    try {
      await exec(`nohup ${botPath} ${args} >/dev/null 2>&1 &`);
      console.log(`${botName} is running`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    } catch (error) {
      console.error(`Error executing command: ${error}`);
    }
  }
  
  await new Promise((resolve) => setTimeout(resolve, 5000));
}

//根据系统架构返回对应的url
function getFilesForArchitecture(architecture) {
  let baseFiles;
  if (architecture === 'arm') {
    baseFiles = [
      { fileName: webPath, fileUrl: "https://arm64.ssss.nyc.mn/web" },
      { fileName: botPath, fileUrl: "https://arm64.ssss.nyc.mn/bot" }
    ];
  } else {
    baseFiles = [
      { fileName: webPath, fileUrl: "https://amd64.ssss.nyc.mn/web" },
      { fileName: botPath, fileUrl: "https://amd64.ssss.nyc.mn/bot" }
    ];
  }
  return baseFiles;
}

// 获取固定隧道json
function argoType() {
  if (!ARGO_AUTH || !ARGO_DOMAIN) {
    console.log("ARGO_DOMAIN or ARGO_AUTH variable is empty, use quick tunnels");
    return;
  }

  if (ARGO_AUTH.includes('TunnelSecret')) {
    fs.writeFileSync(path.join(FILE_PATH, 'tunnel.json'), ARGO_AUTH);
    const tunnelYaml = `
  tunnel: ${ARGO_AUTH.split('"')[11]}
  credentials-file: ${path.join(FILE_PATH, 'tunnel.json')}
  protocol: http2
  
  ingress:
    - hostname: ${ARGO_DOMAIN}
      service: http://localhost:${ARGO_PORT}
      originRequest:
        noTLSVerify: true
    - service: http_status:404
  `;
    fs.writeFileSync(path.join(FILE_PATH, 'tunnel.yml'), tunnelYaml);
  } else {
    console.log("ARGO_AUTH mismatch TunnelSecret,use token connect to tunnel");
  }
}
argoType();

// 获取域名信息
async function extractDomains() {
  const enableCFArgo = ENABLE_CF_ARGO.toLowerCase() === 'true';
  
  if (enableCFArgo) {
    // CF Argo 模式
    console.log('Running in CF Argo mode');
    if (ARGO_AUTH && ARGO_DOMAIN) {
      console.log('ARGO_DOMAIN:', ARGO_DOMAIN);
      await generateLinks(ARGO_DOMAIN);
    } else {
      // 临时隧道逻辑
      await extractTempDomains();
    }
  } else {
    // 直连模式
    console.log('Running in Direct mode');
    if (!DIRECT_DOMAIN) {
      console.error('DIRECT_DOMAIN is required when ENABLE_CF_ARGO is false');
      // 尝试从环境变量或其他地方获取备用域名
      const fallbackDomain = process.env.SERVER_IP ? 
        `direct-${process.env.SERVER_IP.replace(/\./g, '-')}.example.com` : 
        'direct.example.com';
      console.log(`Using fallback domain: ${fallbackDomain}`);
      await generateDirectLinks(fallbackDomain);
    } else {
      console.log('DIRECT_DOMAIN:', DIRECT_DOMAIN);
      await generateDirectLinks(DIRECT_DOMAIN);
    }
  }
}

// 直连模式生成链接
async function generateDirectLinks(domain) {
  try {
    const metaInfo = execSync(
      'curl -sm 5 https://speed.cloudflare.com/meta | awk -F\\" \'{print $26"-"$18}\' | sed -e \'s/ /_/g\'',
      { encoding: 'utf-8' }
    );
    const ISP = metaInfo.trim();
    const nodeName = NAME ? `${NAME}-${ISP}` : ISP;

    return new Promise((resolve) => {
      setTimeout(async () => {
        const VMESS = { 
          v: '2', 
          ps: `${nodeName}-Direct`, 
          add: domain, 
          port: DIRECT_PORT, 
          id: UUID, 
          aid: '0', 
          scy: 'none', 
          net: 'ws', 
          type: 'none', 
          host: domain, 
          path: '/vmess-direct', 
          tls: 'tls', 
          sni: domain, 
          alpn: '', 
          fp: 'firefox'
        };
        
        const subTxt = `vmess://${Buffer.from(JSON.stringify(VMESS)).toString('base64')}`;
        
        // 保存订阅文件
        const encodedContent = Buffer.from(subTxt).toString('base64');
        console.log('Generated subscription content (Direct Mode):');
        console.log(encodedContent);
        fs.writeFileSync(subPath, encodedContent);
        console.log(`${FILE_PATH}/sub.txt saved successfully (Direct Mode)`);
        
        // 推送订阅内容
        await pushSubscriptionContent();
        
        // 上传节点
        uploadNodes();
        
        // 设置订阅路由
        app.get(`/${SUB_PATH}`, (req, res) => {
          res.set('Content-Type', 'text/plain; charset=utf-8');
          res.send(encodedContent);
        });
        
        console.log(`Direct mode configuration completed for domain: ${domain}`);
        resolve(subTxt);
      }, 2000);
    });
  } catch (error) {
    console.error('Error generating direct links:', error);
    // 创建基本的订阅内容作为备用
    const fallbackVMESS = {
      v: '2',
      ps: 'Direct-Fallback',
      add: domain,
      port: DIRECT_PORT,
      id: UUID,
      aid: '0',
      scy: 'none',
      net: 'ws',
      type: 'none',
      host: domain,
      path: '/vmess-direct',
      tls: 'tls',
      sni: domain,
      fp: 'firefox'
    };
    
    const subTxt = `vmess://${Buffer.from(JSON.stringify(fallbackVMESS)).toString('base64')}`;
    const encodedContent = Buffer.from(subTxt).toString('base64');
    fs.writeFileSync(subPath, encodedContent);
    
    app.get(`/${SUB_PATH}`, (req, res) => {
      res.set('Content-Type', 'text/plain; charset=utf-8');
      res.send(encodedContent);
    });
    
    return subTxt;
  }
}

// CF Argo 模式生成链接
async function generateLinks(argoDomain) {
  try {
    const metaInfo = execSync(
      'curl -sm 5 https://speed.cloudflare.com/meta | awk -F\\" \'{print $26"-"$18}\' | sed -e \'s/ /_/g\'',
      { encoding: 'utf-8' }
    );
    const ISP = metaInfo.trim();
    const nodeName = NAME ? `${NAME}-${ISP}` : ISP;

    return new Promise((resolve) => {
      setTimeout(async () => {
        const VMESS = { 
          v: '2', 
          ps: `${nodeName}`, 
          add: CFIP, 
          port: CFPORT, 
          id: UUID, 
          aid: '0', 
          scy: 'none', 
          net: 'ws', 
          type: 'none', 
          host: argoDomain, 
          path: '/vmess-argo?ed=2560', 
          tls: 'tls', 
          sni: argoDomain, 
          alpn: '', 
          fp: 'firefox'
        };
        
        const subTxt = `vmess://${Buffer.from(JSON.stringify(VMESS)).toString('base64')}`;
        
        // 保存订阅文件
        const encodedContent = Buffer.from(subTxt).toString('base64');
        console.log('Generated subscription content (Argo Mode):');
        console.log(encodedContent);
        fs.writeFileSync(subPath, encodedContent);
        console.log(`${FILE_PATH}/sub.txt saved successfully (Argo Mode)`);
        
        // 推送订阅内容
        await pushSubscriptionContent();
        
        // 上传节点
        uploadNodes();
        
        // 设置订阅路由
        app.get(`/${SUB_PATH}`, (req, res) => {
          res.set('Content-Type', 'text/plain; charset=utf-8');
          res.send(encodedContent);
        });
        
        console.log(`Argo mode configuration completed for domain: ${argoDomain}`);
        resolve(subTxt);
      }, 2000);
    });
  } catch (error) {
    console.error('Error generating argo links:', error);
    // 创建基本的订阅内容作为备用
    const fallbackVMESS = {
      v: '2',
      ps: 'Argo-Fallback',
      add: CFIP,
      port: CFPORT,
      id: UUID,
      aid: '0',
      scy: 'none',
      net: 'ws',
      type: 'none',
      host: argoDomain,
      path: '/vmess-argo?ed=2560',
      tls: 'tls',
      sni: argoDomain,
      fp: 'firefox'
    };
    
    const subTxt = `vmess://${Buffer.from(JSON.stringify(fallbackVMESS)).toString('base64')}`;
    const encodedContent = Buffer.from(subTxt).toString('base64');
    fs.writeFileSync(subPath, encodedContent);
    
    app.get(`/${SUB_PATH}`, (req, res) => {
      res.set('Content-Type', 'text/plain; charset=utf-8');
      res.send(encodedContent);
    });
    
    return subTxt;
  }
}

// 提取临时域名（CF Argo 临时隧道）
async function extractTempDomains() {
  try {
    console.log('Looking for temporary Argo domain...');
    
    // 等待一段时间让 cloudflared 生成日志
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    if (!fs.existsSync(path.join(FILE_PATH, 'boot.log'))) {
      console.log('boot.log file not found, waiting longer...');
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
    
    if (fs.existsSync(path.join(FILE_PATH, 'boot.log'))) {
      const fileContent = fs.readFileSync(path.join(FILE_PATH, 'boot.log'), 'utf-8');
      const lines = fileContent.split('\n');
      const argoDomains = [];
      
      lines.forEach((line) => {
        // 匹配多种格式的临时域名
        const domainMatch = line.match(/https?:\/\/([^ ]*trycloudflare\.com)\/?/);
        if (domainMatch) {
          const domain = domainMatch[1];
          argoDomains.push(domain);
        }
        
        // 匹配其他可能的域名格式
        const otherMatch = line.match(/assigned\s+to\s+([a-zA-Z0-9.-]+\.trycloudflare\.com)/);
        if (otherMatch) {
          argoDomains.push(otherMatch[1]);
        }
      });

      if (argoDomains.length > 0) {
        const argoDomain = argoDomains[0];
        console.log('Found ArgoDomain:', argoDomain);
        await generateLinks(argoDomain);
        return;
      }
    }
    
    console.log('ArgoDomain not found in boot.log, attempting to restart cloudflared...');
    
    // 重启 cloudflared 进程
    async function killBotProcess() {
      try {
        if (process.platform === 'win32') {
          await exec(`taskkill /f /im ${botName}.exe > nul 2>&1`);
        } else {
          await exec(`pkill -f "[${botName.charAt(0)}]${botName.substring(1)}" > /dev/null 2>&1`);
        }
        console.log('Stopped previous cloudflared process');
      } catch (error) {
        // 忽略错误，可能进程不存在
      }
    }
    
    await killBotProcess();
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // 重新启动 cloudflared
    const args = `tunnel --edge-ip-version auto --no-autoupdate --protocol http2 --logfile ${FILE_PATH}/boot.log --loglevel info --url http://localhost:${ARGO_PORT}`;
    try {
      await exec(`nohup ${botPath} ${args} >/dev/null 2>&1 &`);
      console.log(`${botName} restarted`);
      await new Promise(resolve => setTimeout(resolve, 8000));
      
      // 再次尝试提取域名
      if (fs.existsSync(path.join(FILE_PATH, 'boot.log'))) {
        const fileContent = fs.readFileSync(path.join(FILE_PATH, 'boot.log'), 'utf-8');
        const lines = fileContent.split('\n');
        const argoDomains = [];
        
        lines.forEach((line) => {
          const domainMatch = line.match(/https?:\/\/([^ ]*trycloudflare\.com)\/?/);
          if (domainMatch) {
            const domain = domainMatch[1];
            argoDomains.push(domain);
          }
        });

        if (argoDomains.length > 0) {
          const argoDomain = argoDomains[0];
          console.log('Found ArgoDomain after restart:', argoDomain);
          await generateLinks(argoDomain);
          return;
        }
      }
      
      console.log('Still no ArgoDomain found, using fallback method');
      await generateLinks('fallback.trycloudflare.com');
      
    } catch (error) {
      console.error(`Error restarting cloudflared: ${error}`);
      await generateLinks('error.trycloudflare.com');
    }
  } catch (error) {
    console.error('Error extracting temporary domains:', error);
    await generateLinks('error.trycloudflare.com');
  }
}

  // 生成 list 和 sub 信息
  async function generateLinks(argoDomain) {
    const metaInfo = execSync(
      'curl -sm 5 https://speed.cloudflare.com/meta | awk -F\\" \'{print $26"-"$18}\' | sed -e \'s/ /_/g\'',
      { encoding: 'utf-8' }
    );
    const ISP = metaInfo.trim();
    const nodeName = NAME ? `${NAME}-${ISP}` : ISP;
  
    return new Promise((resolve) => {
      setTimeout(async () => {
        const VMESS = { v: '2', ps: `${nodeName}`, add: CFIP, port: CFPORT, id: UUID, aid: '0', scy: 'none', net: 'ws', type: 'none', host: argoDomain, path: '/vmess-argo?ed=2560', tls: 'tls', sni: argoDomain, alpn: '', fp: 'firefox'};
        const subTxt = `  vmess://${Buffer.from(JSON.stringify(VMESS)).toString('base64')} `;
        
        // 保存订阅文件
        const encodedContent = Buffer.from(subTxt).toString('base64');
        console.log(encodedContent);
        fs.writeFileSync(subPath, encodedContent);
        console.log(`${FILE_PATH}/sub.txt saved successfully`);
        
        // 只推送订阅内容
        await pushSubscriptionContent();
        
        uploadNodes();
        app.get(`/${SUB_PATH}`, (req, res) => {
          res.set('Content-Type', 'text/plain; charset=utf-8');
          res.send(encodedContent);
        });
        resolve(subTxt);
      }, 2000);
    });
  }


// 自动上传节点或订阅
async function uploadNodes() {
  if (UPLOAD_URL && PROJECT_URL) {
    const subscriptionUrl = `${PROJECT_URL}/${SUB_PATH}`;
    const jsonData = {
      subscription: [subscriptionUrl]
    };
    try {
        const response = await axios.post(`${UPLOAD_URL}/api/add-subscriptions`, jsonData, {
            headers: {
                'Content-Type': 'application/json'
            }
        });
        
        if (response && response.status === 200) {
            console.log('Subscription uploaded successfully');
            return response;
        } else {
          return null;
        }
    } catch (error) {
        if (error.response) {
            if (error.response.status === 400) {
            }
        }
    }
  } else if (UPLOAD_URL) {
      if (!fs.existsSync(listPath)) return;
      const content = fs.readFileSync(listPath, 'utf-8');
      const nodes = content.split('\n').filter(line => /(vless|vmess|trojan|hysteria2|tuic):\/\//.test(line));

      if (nodes.length === 0) return;

      const jsonData = JSON.stringify({ nodes });

      try {
          const response = await axios.post(`${UPLOAD_URL}/api/add-nodes`, jsonData, {
              headers: { 'Content-Type': 'application/json' }
          });
          if (response && response.status === 200) {
            console.log('Nodes uploaded successfully');
            return response;
        } else {
            return null;
        }
      } catch (error) {
          return null;
      }
  } else {
      return;
  }
}

// 清理文件
function cleanFiles() {
  setTimeout(() => {
    const enableCFArgo = ENABLE_CF_ARGO.toLowerCase() === 'true';
    const filesToDelete = [bootLogPath, configPath, webPath];
    
    // 仅在 CF Argo 模式时清理 bot 文件
    if (enableCFArgo) {
      filesToDelete.push(botPath);
    }
    
    if (process.platform === 'win32') {
      exec(`del /f /q ${filesToDelete.join(' ')} > nul 2>&1`, (error) => {
        console.clear();
        console.log('App is running');
        console.log(`Mode: ${enableCFArgo ? 'CF Argo' : 'Direct'}`);
        console.log('Thank you for using this script, enjoy!');
      });
    } else {
      exec(`rm -rf ${filesToDelete.join(' ')} >/dev/null 2>&1`, (error) => {
        console.clear();
        console.log('App is running');
        console.log(`Mode: ${enableCFArgo ? 'CF Argo' : 'Direct'}`);
        console.log('Thank you for using this script, enjoy!');
      });
    }
  }, 90000);
}
cleanFiles();

// 自动访问项目URL
async function AddVisitTask() {
  if (!AUTO_ACCESS || !PROJECT_URL) {
    console.log("Skipping adding automatic access task");
    return;
  }

  try {
    const response = await axios.post('https://oooo.serv00.net/add-url', {
      url: PROJECT_URL
    }, {
      headers: {
        'Content-Type': 'application/json'
      }
    });
    console.log(`automatic access task added successfully`);
    return response;
  } catch (error) {
    console.error(`Add automatic access task faild: ${error.message}`);
    return null;
  }
}
// 推送订阅内容函数
async function pushSubscriptionContent() {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.log('Telegram推送未配置: BOT_TOKEN 或 CHAT_ID 为空');
    return false;
  }

  try {
    // 读取sub.txt内容
    if (!fs.existsSync(subPath)) {
      console.log('sub.txt 文件不存在');
      return false;
    }

    const subContent = fs.readFileSync(subPath, 'utf-8');
    
    // 解码base64内容
    const decodedContent = Buffer.from(subContent, 'base64').toString('utf-8');
    
    // 如果内容太长，分割发送
    if (decodedContent.length > 4000) {
      // 分割内容发送
      const chunks = decodedContent.match(/[\s\S]{1,4000}/g) || [];
      for (let i = 0; i < chunks.length; i++) {
        await sendTelegramMessage(`<b>订阅内容 (${i + 1}/${chunks.length})</b>\n\n<pre>${chunks[i]}</pre>`);
        // 避免发送过快
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    } else {
      // 直接发送完整内容
      await sendTelegramMessage(`<b>订阅内容</b>\n\n<pre>${decodedContent}</pre>`);
    }
    
    console.log('订阅内容推送成功');
    return true;
  } catch (error) {
    console.error('推送订阅内容失败:', error.message);
    return false;
  }
}

// 简化的Telegram发送函数
async function sendTelegramMessage(message) {
  if (!BOT_TOKEN || !CHAT_ID) {
    return false;
  }

  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    const response = await axios.post(url, {
      chat_id: CHAT_ID,
      text: message,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    });

    return response.data.ok;
  } catch (error) {
    console.error('Telegram推送错误:', error.message);
    return false;
  }
}
// 主运行逻辑
async function startserver() {
  try {
    console.log('Starting server with configuration:');
    console.log('ENDPOINT:', ENDPOINT);
    console.log('TOKEN:', TOKEN);
    console.log('FILE_PATH:', FILE_PATH);
    
    deleteNodes();
    cleanupOldFiles();
    
    // 下载komari-agent
    const agentDownloaded = await downloadKomariAgent();
    
    await generateConfig();
    await downloadFilesAndRun();
    
    // 启动komari-agent（使用--ignore-unsafe-cert参数）
    if (agentDownloaded) {
      console.log('Starting komari-agent...');
      startKomariAgent();
    } else {
      console.error('komari-agent download failed, skipping startup');
    }
    
    await extractDomains();
    await AddVisitTask();
  } catch (error) {
    console.error('Error in startserver:', error);
  }
}
startserver().catch(error => {
  console.error('Unhandled error in startserver:', error);
});

app.listen(PORT, () => console.log(`http server is running on port:${PORT}!`));
