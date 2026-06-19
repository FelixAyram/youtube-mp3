#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Local server for the Tampermonkey userscript."""

from __future__ import annotations

import json
import subprocess
import sys
import threading
import uuid
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import urlparse

HOST = "127.0.0.1"
PORT = 7831
DOWNLOADS_DIR = Path.home() / "Downloads" / "YouTube Playlists"
BROWSER_COOKIES = ("chrome", "edge", "firefox", "brave", "opera")

jobs: dict[str, dict] = {}


def yt_dlp_cmd(args: list[str]) -> list[str]:
    return [sys.executable, "-m", "yt_dlp", *args]


def run_yt_dlp(job_id: str, playlist_url: str, fmt: str) -> None:
    job = jobs[job_id]
    job["state"] = "running"
    job["message"] = "Iniciando yt-dlp..."

    output_dir = DOWNLOADS_DIR / job_id[:8]
    output_dir.mkdir(parents=True, exist_ok=True)
    job["outputDir"] = str(output_dir)

    output_template = str(output_dir / "%(playlist_index)03d - %(title)s.%(ext)s")

    base_args = [
        "--ignore-errors",
        "--no-overwrites",
        "--embed-metadata",
        "--embed-thumbnail",
        "--convert-thumbnails",
        "jpg",
        "--parse-metadata",
        "%(uploader|)s:%(meta_artist)s",
        "--parse-metadata",
        "%(playlist_title|)s:%(meta_album)s",
        "-o",
        output_template,
        playlist_url,
    ]

    if fmt in {"mp3", "m4a", "opus", "flac", "wav"}:
        base_args.extend(["-x", "--audio-format", fmt, "--audio-quality", "0"])
        if fmt == "mp3":
            base_args.extend(
                [
                    "--postprocessor-args",
                    "ffmpeg:-c:v mjpeg -disposition:v:0 attached_pic",
                ]
            )
    elif fmt in {"mp4", "webm"}:
        base_args.extend(["--merge-output-format", fmt])
    else:
        job["state"] = "error"
        job["error"] = f"Formato no soportado: {fmt}"
        return

    last_error = ""
    for browser in BROWSER_COOKIES:
        cmd = yt_dlp_cmd([*base_args, "--cookies-from-browser", browser])
        job["log"] = " ".join(cmd)
        try:
            proc = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
            )
            files = list(output_dir.glob("*"))
            job["files"] = len(files)
            job["log"] = (proc.stdout or "")[-2000:] + (proc.stderr or "")[-2000:]

            if proc.returncode == 0 or files:
                job["state"] = "done"
                job["message"] = f"Listo: {len(files)} archivos (cookies: {browser})"
                return

            last_error = proc.stderr.strip() or proc.stdout.strip() or "yt-dlp fallo"
            if "could not find" in last_error.lower():
                continue
        except FileNotFoundError:
            job["state"] = "error"
            job["error"] = "Instala yt-dlp: pip install yt-dlp (y ffmpeg en PATH)"
            return
        except Exception as exc:
            last_error = str(exc)

    job["state"] = "error"
    job["error"] = last_error or "yt-dlp fallo con todos los navegadores"


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format: str, *args) -> None:
        return

    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _json(self, code: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self) -> None:
        path = urlparse(self.path).path

        if path == "/health":
            self._json(200, {"ok": True})
            return

        if path.startswith("/status/"):
            job_id = path.split("/status/", 1)[1]
            job = jobs.get(job_id)
            if not job:
                self._json(404, {"error": "Trabajo no encontrado"})
                return
            self._json(200, job)
            return

        self._json(404, {"error": "Not found"})

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        if path != "/download":
            self._json(404, {"error": "Not found"})
            return

        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length).decode("utf-8")
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            self._json(400, {"error": "JSON invalido"})
            return

        playlist_url = data.get("url", "").strip()
        fmt = data.get("format", "mp3").strip().lower()

        if not playlist_url or "list=" not in playlist_url:
            self._json(400, {"error": "URL de playlist invalida"})
            return

        job_id = str(uuid.uuid4())
        jobs[job_id] = {
            "state": "queued",
            "message": "En cola...",
            "files": 0,
            "outputDir": "",
        }

        thread = threading.Thread(
            target=run_yt_dlp,
            args=(job_id, playlist_url, fmt),
            daemon=True,
        )
        thread.start()

        self._json(200, {"jobId": job_id})


def main() -> None:
    DOWNLOADS_DIR.mkdir(parents=True, exist_ok=True)
    server = HTTPServer((HOST, PORT), Handler)
    print(f"Servidor yt-dlp en http://{HOST}:{PORT}")
    print(f"Descargas en: {DOWNLOADS_DIR}")
    print("Deja esta ventana abierta mientras uses el script de Tampermonkey.")
    print("Ctrl+C para detener.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServidor detenido.")
        sys.exit(0)


if __name__ == "__main__":
    main()
