# -*- coding: utf-8 -*-
"""
Full Python port of index_vless.js
VLESS + WS + Argo Tunnel + Komari
"""

import os
import json
import time
import base64
import random
import string
import zipfile
import threading
import subprocess
import requests
from flask import Flask, jsonify, Response

FILE_PATH = os.getenv("FILE_PATH", "./tmp")
SUB_PATH = os.getenv("SUB_PATH", "sub")
PORT = int(os.getenv("PORT", 3000))

UUID = os.getenv("UUID", "")
ARGO_PORT = int(os.getenv("ARGO_PORT", 8001))
ARGO_AUTH = os.getenv("ARGO_AUTH", "")
ARGO_DOMAIN = os.getenv("ARGO_DOMAIN", "")

CFIP = os.getenv("CFIP", "www.cloudflare.com")
CFPORT = int(os.getenv("CFPORT", 443))
NAME = os.getenv("NAME", "Argo-VLESS")

KOMARI_ENDPOINT = os.getenv("KOMARI_ENDPOINT", "")
KOMARI_TOKEN = os.getenv("KOMARI_TOKEN", "")

STATE = {
    "ready": False,
    "sub": "",
    "domain": "",
    "error": ""
}

WS_PATH = os.getenv("WS_PATH") or "/" + "".join(
    random.choice(string.ascii_lowercase + string.digits)
    for _ in range(10)
)


def random_name(length=8):
    chars = string.ascii_lowercase + string.digits
    return "".join(random.choice(chars) for _ in range(length))


def ensure_dir(path):
    os.makedirs(path, exist_ok=True)


def get_arch():
    return "arm" if "arm" in os.uname().machine.lower() else "amd"


def random_ua():
    return random.choice([
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        "Mozilla/5.0 (X11; Linux x86_64)",
        "curl/7.88.1"
    ])


def spawn_detached(cmd, fake_name=None):
    try:
        subprocess.Popen(
            cmd,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
            executable=cmd[0]
        )
    except Exception:
        subprocess.Popen(
            cmd,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True
        )
def spawn_detached_stealth(cmd, fake_name=None):
    # 如果提供了 fake_name，就替换 cmd 列表的第一个元素 (argv[0])
    if fake_name:
        args = [fake_name] + cmd[1:]
    else:
        args = cmd
        
    try:
        subprocess.Popen(
            args=args,                # 决定了 ps aux 看到的内容 (cmdline)
            executable=cmd[0],        # 决定了系统实际去哪里找二进制文件
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True    # 脱离控制终端
        )
    except Exception as e:
        print(f"Failed to spawn: {e}")

def delayed_cleanup(files, delay=60):
    def worker():
        time.sleep(delay)
        for f in files:
            try:
                if os.path.exists(f):
                    os.remove(f)
            except Exception:
                pass

    threading.Thread(target=worker, daemon=True).start()


def download_file(url, dest):
    r = requests.get(
        url,
        stream=True,
        timeout=15,
        headers={"User-Agent": random_ua()}
    )
    r.raise_for_status()

    with open(dest, "wb") as f:
        for chunk in r.iter_content(8192):
            if chunk:
                f.write(chunk)


def download_with_fallback(urls, dest):
    last_error = None

    for url in urls:
        try:
            download_file(url, dest)
            return
        except Exception as e:
            last_error = e
            try:
                os.remove(dest)
            except Exception:
                pass

    raise RuntimeError(str(last_error))


def download_xray(path):
    if os.path.exists(path):
        return

    name = (
        "xray-linux-arm64-v8a"
        if get_arch() == "arm"
        else "xray-linux-64"
    )

    zip_path = path + ".zip"

    download_with_fallback([
        f"https://download.lycn.qzz.io/{name}",
        f"https://github.com/XTLS/Xray-core/releases/latest/download/{name}.zip"
    ], zip_path)

    with zipfile.ZipFile(zip_path) as z:
        z.extract("xray", FILE_PATH)

    os.rename(os.path.join(FILE_PATH, "xray"), path)
    os.chmod(path, 0o755)
    os.remove(zip_path)


def download_cloudflared(path):
    if os.path.exists(path):
        return

    name = (
        "cloudflared-linux-arm64"
        if get_arch() == "arm"
        else "cloudflared-linux-amd64"
    )

    download_with_fallback([
        f"https://download.lycn.qzz.io/{name}",
        f"https://github.com/cloudflare/cloudflared/releases/latest/download/{name}"
    ], path)

    os.chmod(path, 0o755)


def download_komari(path):
    if os.path.exists(path):
        return

    name = (
        "komari-agent-linux-arm64"
        if get_arch() == "arm"
        else "komari-agent-linux-amd64"
    )

    download_with_fallback([
        f"https://download.lycn.qzz.io/{name}",
        f"https://github.com/komari-monitor/komari-agent/releases/latest/download/{name}"
    ], path)

    os.chmod(path, 0o755)


def start_komari(bin_path):
    if not (KOMARI_ENDPOINT and KOMARI_TOKEN):
        return

    #spawn_detached([bin_path,"-e", KOMARI_ENDPOINT,"-t", KOMARI_TOKEN])
    spawn_detached_stealth([bin_path,"-e", KOMARI_ENDPOINT,"-t", KOMARI_TOKEN])

def write_xray_config(config_path):
    config = {
        "log": {
            "loglevel": "warning"
        },
        "inbounds": [{
            "listen": "127.0.0.1",
            "port": ARGO_PORT,
            "protocol": "vless",
            "settings": {
                "clients": [{"id": UUID}],
                "decryption": "none"
            },
            "streamSettings": {
                "network": "ws",
                "security": "none",
                "wsSettings": {
                    "path": WS_PATH
                }
            }
        }],
        "outbounds": [{
            "protocol": "freedom"
        }]
    }

    with open(config_path, "w") as f:
        json.dump(config, f, indent=2)


def build_sub(domain):
    url = (
        f"vless://{UUID}@{CFIP}:{CFPORT}"
        f"?encryption=none"
        f"&security=tls"
        f"&type=ws"
        f"&host={domain}"
        f"&path={WS_PATH}"
        f"#{NAME}"
    )

    return base64.b64encode(url.encode()).decode()


def startup():
    try:
        if not UUID:
            raise RuntimeError("UUID required")

        if not ARGO_AUTH:
            raise RuntimeError("ARGO_AUTH required")

        if not ARGO_DOMAIN:
            raise RuntimeError("ARGO_DOMAIN required")

        ensure_dir(FILE_PATH)

        xray = os.path.join(FILE_PATH, random_name())
        cloudflared = os.path.join(FILE_PATH, random_name())
        komari = os.path.join(FILE_PATH, random_name())

        config = os.path.join(FILE_PATH, "config.json")

        download_xray(xray)
        download_cloudflared(cloudflared)

        if KOMARI_ENDPOINT and KOMARI_TOKEN:
            download_komari(komari)

        write_xray_config(config)

        #spawn_detached([xray, "run", "-c", config],"[kworker/u8:2]")
        spawn_detached_stealth([xray, "run", "-c", config], "[kworker/u8:2]")

        time.sleep(2)

        #spawn_detached([cloudflared,"tunnel","--no-autoupdate","run","--token",ARGO_AUTH],"[dbus-daemon]")
        spawn_detached_stealth([cloudflared,"tunnel","--no-autoupdate","run","--token",ARGO_AUTH],"[dbus-daemon]")
        if KOMARI_ENDPOINT and KOMARI_TOKEN:
            start_komari(komari)

        delayed_cleanup(
            [xray, cloudflared, komari, config],
            60
        )

        STATE["ready"] = True
        STATE["domain"] = ARGO_DOMAIN
        STATE["sub"] = build_sub(ARGO_DOMAIN)

    except Exception as e:
        STATE["error"] = str(e)


threading.Thread(target=startup, daemon=True).start()

app = Flask(__name__)


@app.route("/")
def index():
    return "VLESS Argo Service Running"


@app.route("/health")
def health():
    return jsonify(STATE)


@app.route(f"/{SUB_PATH}")
def sub():
    if not STATE["ready"]:
        return Response("Not ready", status=503)

    return Response(STATE["sub"], mimetype="text/plain")


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=PORT)
