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
ARGO_AUTH = os.getenv("ARGO_AUTH", "ey")
ARGO_DOMAIN = os.getenv("ARGO_DOMAIN", "domain")
WS_PATH_BASE = os.getenv("WS_PATH_BASE", "/api/v1")
WS_PATH_RANDOM_LEN = int(os.getenv("WS_PATH_RANDOM_LEN", 8))
WS_PATH = (
    f"{WS_PATH_BASE.rstrip('/')}/"
    f"{''.join(random.choices(string.ascii_letters + string.digits, k=WS_PATH_RANDOM_LEN))}"
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
    "error": ""
}

# ================== 工具 ==================
def rand_name(n=6):
    return ''.join(random.choice(string.ascii_lowercase) for _ in range(n))

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
                    "network": "ws",
                    "wsSettings": {
                        "path": WS_PATH
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
        f"&type=ws"
        f"&host={domain}"
        f"&path={WS_PATH}"
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

        xray = os.path.join(FILE_PATH, rand_name())
        cf = os.path.join(FILE_PATH, rand_name())
        komari = os.path.join(FILE_PATH, rand_name())
        #xray = os.path.join(FILE_PATH, "x")
        #cf = os.path.join(FILE_PATH, "cf")
        #komari = os.path.join(FILE_PATH, "komari")
        conf = os.path.join(FILE_PATH, "config.json")

        for fn in random.sample([
            lambda: download_xray(xray),
            lambda: download_cloudflared(cf),
            lambda: download_komari(komari)
        ], 3):
            fn()

        write_xray_conf(conf)

        run_detached([xray, "run", "-c", conf])

        if ARGO_AUTH:
            run_detached([cf, "tunnel", "run", "--token", ARGO_AUTH])
        else:
            run_detached([cf, "tunnel", "--url", f"http://localhost:{ARGO_PORT}"])

        if KOMARI_ENDPOINT and KOMARI_TOKEN:
            run_detached([komari, "-e", KOMARI_ENDPOINT, "-t", KOMARI_TOKEN])
        
        state["domain"] = ARGO_DOMAIN
        state["sub"] = build_sub(ARGO_DOMAIN)
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

app = Flask(__name__)

@app.route("/")
def index():
    # 尝试返回 index.html，模拟正常网页
    if os.path.exists("index.html"):
        return send_from_directory('.', 'index.html')
    return "Service is running."

@app.route("/health")
def health():
    return jsonify(state)

@app.route(f"/{SUB_PATH}")
def sub(): 
    if not state["ready"]:
        return Response("Not ready", 503)
    return Response(state["sub"], mimetype="text/plain")

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=PORT)
