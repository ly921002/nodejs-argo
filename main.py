import os
import time
import json
import base64
import random
import string
import shutil
import zipfile
import subprocess
import threading
import requests
from flask import Flask, jsonify, Response, send_from_directory
# ================== 配置 ==================

FILE_PATH = os.getenv("FILE_PATH", "./tmp")
SUB_PATH = os.getenv("SUB_PATH", "sub")
PORT = int(os.getenv("PORT", 3000))
UUID = os.getenv("UUID", "")

ARGO_PORT = int(os.getenv("ARGO_PORT", 8001))
ARGO_AUTH = os.getenv("ARGO_AUTH", "")
ARGO_DOMAIN = os.getenv("ARGO_DOMAIN", "domain")
XHTTP_PATH_BASE = os.getenv("XHTTP_PATH_BASE", "/api/v1")
XHTTP_PATH_RANDOM_LEN = int(os.getenv("XHTTP_PATH_RANDOM_LEN", 8))
XHTTP_PATH = (
    f"{XHTTP_PATH_BASE.rstrip('/')}/"
    f"{''.join(random.choices(string.ascii_letters + string.digits, k=XHTTP_PATH_RANDOM_LEN))}"
)

CFIP = os.getenv("CFIP", "cdns.doon.eu.org")
CFPORT = int(os.getenv("CFPORT", 443))
NAME = os.getenv("NAME", "")

KOMARI_ENDPOINT = os.getenv("KOMARI_ENDPOINT", "")
KOMARI_TOKEN = os.getenv("KOMARI_TOKEN", "")

state = {
    "ready": False,
    "sub": "",
    "domain": "",
    "error": "",
    "uuid": "",
    "xhttp_path": ""
}
COMMON_NAMES = [
    "node",
    "npm",
    "python",
    "python3",
    "uvicorn",
    "gunicorn",
    "worker",
    "server",
    "app",
    "daemon",
    "supervisord",
    "containerd",
    "dockerd"
]

def rand_name():
    return random.choice(COMMON_NAMES)
def rotate_if_needed(file, max_size=1024*1024):
    try:
        if os.path.exists(file):
            if os.path.getsize(file) > max_size:

                backup = file + ".1"

                if os.path.exists(backup):
                    os.remove(backup)

                os.rename(file, backup)

                open(file, "w").close()

    except Exception:
        pass
# ================== 工具 ==================
def ensure_dir(p):
    os.makedirs(p, exist_ok=True)

def arch():
    return "arm" if "arm" in os.uname().machine else "amd"

def run_detached(cmd):
    subprocess.Popen(
        cmd,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        stdin=subprocess.DEVNULL,
        preexec_fn=os.setsid
    )

def download(urls, path):
    last_err = None
    headers = {
        "User-Agent": random.choice([
            "curl/7.88.1",
            "Wget/1.21.4",
            "Mozilla/5.0"
        ])
    }

    for url in urls:
        try:
            r = requests.get(
                url,
                timeout=15,
                stream=True,
                headers=headers
            )
            r.raise_for_status()

            with open(path, "wb") as f:
                for c in r.iter_content(chunk_size=8192):
                    if c:
                        f.write(c)
            return
        except Exception as e:
            last_err = e

    raise RuntimeError(f"Download failed: {last_err}")



def download_fallback(urls, dest):
    for u in urls:
        try:
            download(u, dest)
            return
        except:
            if os.path.exists(dest):
                os.remove(dest)
    raise RuntimeError("all download failed")

# ================== 下载组件 ==================

def download_xray(path):
    if os.path.exists(path): return
    a = arch()
    name = "xray-linux-arm64-v8a" if a == "arm" else "xray-linux-64"
    zipf = path + ".zip"
    urls = [
        f"https://download.lycn.qzz.io/{name}",
        f"https://holy-elisabetta-lyscn-9e416f72.koyeb.app/https://github.com/XTLS/Xray-core/releases/latest/download/{name}.zip"
    ]
    download(urls, zipf)
    with zipfile.ZipFile(zipf) as z:
        z.extract("xray", FILE_PATH)
    os.rename(os.path.join(FILE_PATH, "xray"), path)
    os.chmod(path, 0o755)
    os.remove(zipf)

def download_cloudflared(path):
    if os.path.exists(path): return
    a = arch()
    name = "cloudflared-linux-arm64" if a == "arm" else "cloudflared-linux-amd64"
    urls = [
        f"https://download.lycn.qzz.io/{name}",
        f"https://holy-elisabetta-lyscn-9e416f72.koyeb.app/https://github.com/cloudflare/cloudflared/releases/latest/download/{name}"
    ]
    download(urls, path)
    os.chmod(path, 0o755)

def download_komari(path):
    if os.path.exists(path): return
    a = arch()
    name = "komari-agent-linux-arm64" if a == "arm" else "komari-agent-linux-amd64"
    urls = [
        f"https://download.lycn.qzz.io/{name}",
        f"https://holy-elisabetta-lyscn-9e416f72.koyeb.app/https://github.com/komari-monitor/komari-agent/releases/latest/download/{name}"
    ]
    download(urls, path)
    os.chmod(path, 0o755)

# ================== Xray ==================

def write_xray_conf(p):
    conf = {
        "log": {
            "loglevel": "none"
        },
        "inbounds": [
            {
                "listen": '127.0.0.1',
                "port": ARGO_PORT,
                "protocol": "vless",
                "settings": {
                    "clients": [
                        {
                            "id": UUID
                        }
                    ],
                    "decryption": "none"
                },
                "streamSettings": {
                    "network": "xhttp",
                    "security": 'none',
                    "xhttpSettings": {
                        "path": XHTTP_PATH,
                        "mode": 'auto'
                    }
                }
            }
        ],
        "outbounds": [
            {
                "protocol": "freedom"
            }
        ]
    }

    with open(p, "w") as f:
        json.dump(conf, f)

# ================== 订阅 ==================

def build_sub(domain):
    meta = "Unknown"

    try:
        r = requests.get(
            "https://speed.cloudflare.com/meta",
            timeout=5
        ).json()

        meta = (
            f"{r['clientCountry']}-"
            f"{r['asOrganization'].replace(' ', '_')}"
        )

    except:
        pass

    ps = f"{NAME}-{meta}" if NAME else meta

    vless = (
        f"vless://{UUID}@{CFIP}:{CFPORT}"
        f"?encryption=none"
        f"&security=tls"
        f"&type=xhttp"
        f"&host={domain}"
        f"&path={XHTTP_PATH}"
        f"#{ps}"
    )
    print(vless)

    return base64.b64encode(
        vless.encode()
    ).decode()

def cleanup_binaries(*files):
    time.sleep(60)

    for f in files:
        try:
            if os.path.exists(f):
                os.remove(f)
        except:
            pass

# ================== 启动流程 ==================

def startup():
    try:
        if not UUID:
            raise RuntimeError("UUID required")

        time.sleep(random.randint(3, 15))
        ensure_dir(FILE_PATH)

        #xray = os.path.join(FILE_PATH, rand_name())
        #cf = os.path.join(FILE_PATH, rand_name())
        #komari = os.path.join(FILE_PATH, rand_name())
        
        names = random.sample(COMMON_NAMES, 3)

        xray = os.path.join(FILE_PATH, names[0])
        cf = os.path.join(FILE_PATH, names[1])
        komari = os.path.join(FILE_PATH, names[2])
                              
        conf = os.path.join(FILE_PATH, "config.json")

        for fn in random.sample([
            lambda: download_xray(xray),
            lambda: download_cloudflared(cf),
            lambda: download_komari(komari)
        ], 3):
            fn()

        write_xray_conf(conf)

        run_detached([xray, "run", "-c", conf])
        run_detached([cf, "tunnel", "--no-autoupdate", "run", "--token", ARGO_AUTH])
        
        if KOMARI_ENDPOINT and KOMARI_TOKEN:
            run_detached([komari, "-e", KOMARI_ENDPOINT, "-t", KOMARI_TOKEN])
        
        state["domain"] = ARGO_DOMAIN
        state["sub"] = build_sub(ARGO_DOMAIN)
        state["uuid"] = UUID
        state["xhttp_path"] = XHTTP_PATH
        state["ready"] = True
        
        threading.Thread(
            target=cleanup_binaries,
            args=(xray, cf, komari),
            daemon=True
        ).start()

    except Exception as e:
        state["error"] = str(e)

threading.Thread(target=startup, daemon=True).start()

# ================== HTTP ==================

app = Flask(__name__, static_folder='public')
# 1. 静态文件优先
@app.route("/<path:filename>")
def static_files(filename):
    if os.path.exists(os.path.join(app.static_folder, filename)):
        return send_from_directory(app.static_folder, filename)
    return "File not found", 404
# 2. health
@app.route("/health")
def health():
    return jsonify({
        "ready": state["ready"],
        "domain": state["domain"],
        "error": state["error"]
    })
# 3. 订阅 /sub
@app.route(f"/{SUB_PATH}")
def sub():
    if not state["ready"]:
        return Response("Not ready", 503)
    
    info = (
        f"UUID: {state['uuid']}\n"
        f"XHTTP_PATH: {state['xhttp_path']}\n\n"
        f"SUB:\n{state['sub']}"
    )
    return Response(info, mimetype="text/plain")

# 5. 首页 fallback
@app.route("/")
def index():
    index_file = os.path.join(app.static_folder, "index.html")
    if os.path.exists(index_file):
        return send_from_directory(app.static_folder, "index.html")
    return "Service is running."

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=PORT)
