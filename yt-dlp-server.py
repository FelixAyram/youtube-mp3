#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Local server for the Tampermonkey userscript."""

from __future__ import annotations

import json
import shutil
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
AUDIO_FORMATS = {"mp3", "m4a", "opus", "flac", "wav"}
VIDEO_FORMATS = {"mp4", "webm"}

jobs: dict[str, dict] = {}


def yt_dlp_cmd(args: list[str]) -> list[str]:
    return [sys.executable, "-m", "yt_dlp", *args]


def has_ffmpeg() -> bool:
    try:
        subprocess.run(
            ["ffmpeg", "-version"],
            capture_output=True,
            check=True,
        )
        return True
    except (FileNotFoundError, subprocess.CalledProcessError):
        return False


def count_files(output_dir: Path, ext: str) -> int:
    return len(list(output_dir.glob(f"*.{ext}")))


def cleanup_sidecars(output_dir: Path, keep_ext: str) -> None:
    """Quita webm/webp sueltos cuando ya hay archivos finales."""
    if count_files(output_dir, keep_ext) == 0:
        return
    for pattern in ("*.webm", "*.webp", "*.m4a.part", "*.mp3.part"):
        for path in output_dir.glob(pattern):
            try:
                path.unlink()
            except OSError:
                pass


def build_yt_dlp_args(playlist_url: str, output_template: str, fmt: str) -> list[str]:
    common = [
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
    ]

    if fmt in AUDIO_FORMATS:
        common.extend(
            [
                "-f",
                "ba/b",
                "-x",
                "--audio-format",
                fmt,
                "--audio-quality",
                "0",
            ]
        )
        if fmt == "mp3":
            common.extend(
                [
                    "--postprocessor-args",
                    "ffmpeg:-c:v mjpeg -disposition:v:0 attached_pic",
                ]
            )
    elif fmt in VIDEO_FORMATS:
        common.extend(["--merge-output-format", fmt])
    else:
        raise ValueError(f"Formato no soportado: {fmt}")

    common.extend(["-o", output_template, playlist_url])
    return common


def run_yt_dlp(job_id: str, playlist_url: str, fmt: str) -> None:
    job = jobs[job_id]
    job["state"] = "running"
    job["message"] = "Iniciando yt-dlp..."

    if fmt in AUDIO_FORMATS and not has_ffmpeg():
        job["state"] = "error"
        job["error"] = (
            "ffmpeg no está instalado. Sin ffmpeg no hay MP3 ni portada embebida. "
            "Instalá: winget install Gyan.FFmpeg"
        )
        return

    output_dir = DOWNLOADS_DIR / job_id[:8]
    if output_dir.exists():
        shutil.rmtree(output_dir, ignore_errors=True)
    output_dir.mkdir(parents=True, exist_ok=True)
    job["outputDir"] = str(output_dir)

    output_template = str(output_dir / "%(playlist_index)03d - %(title)s.%(ext)s")

    try:
        base_args = build_yt_dlp_args(playlist_url, output_template, fmt)
    except ValueError as exc:
        job["state"] = "error"
        job["error"] = str(exc)
        return

    last_error = ""
    for browser in BROWSER_COOKIES:
        cmd = yt_dlp_cmd([*base_args, "--cookies-from-browser", browser])
        job["log"] = " ".join(cmd)
        job["message"] = f"Descargando con cookies de {browser}…"
        try:
            proc = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
            )
            log_tail = ((proc.stdout or "") + (proc.stderr or ""))[-3000:]
            job["log"] = log_tail

            if fmt in AUDIO_FORMATS:
                final_count = count_files(output_dir, fmt)
                cleanup_sidecars(output_dir, fmt)
                job["files"] = count_files(output_dir, fmt)

                if final_count == 0:
                    last_error = (
                        f"No se generó ningún .{fmt}. "
                        "¿ffmpeg instalado y en PATH? Revisá el log."
                    )
                    if "ffmpeg" in log_tail.lower():
                        last_error = "ffmpeg no encontrado o falló la conversión a " + fmt
                    continue

                job["state"] = "done"
                job["message"] = (
                    f"Listo: {job['files']} archivo(s) .{fmt} con portada "
                    f"(cookies: {browser})"
                )
                return

            files = [p for p in output_dir.iterdir() if p.is_file()]
            job["files"] = len(files)
            if proc.returncode == 0 or files:
                job["state"] = "done"
                job["message"] = f"Listo: {len(files)} archivos (cookies: {browser})"
                return

            last_error = proc.stderr.strip() or proc.stdout.strip() or "yt-dlp falló"
            if "could not find" in last_error.lower():
                continue
        except FileNotFoundError:
            job["state"] = "error"
            job["error"] = "Instala yt-dlp: pip install yt-dlp"
            return
        except Exception as exc:
            last_error = str(exc)

    job["state"] = "error"
    job["error"] = last_error or "yt-dlp falló con todos los navegadores"


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
            self._json(
                200,
                {
                    "ok": True,
                    "ffmpeg": has_ffmpeg(),
                    "version": "2.1",
                },
            )
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
    if not has_ffmpeg():
        print("[AVISO] ffmpeg no está en PATH — MP3 y portadas NO funcionarán.")
    print("Deja esta ventana abierta mientras uses el script de Tampermonkey.")
    print("Ctrl+C para detener.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServidor detenido.")
        sys.exit(0)


if __name__ == "__main__":
    main()
