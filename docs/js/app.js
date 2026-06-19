const SERVER = "http://127.0.0.1:7831";
const POLL_MS = 2000;

const urlBox = document.getElementById("url-box");
const statusEl = document.getElementById("status");
const btnDownload = document.getElementById("btn-download");
const btnRecheck = document.getElementById("btn-recheck");
const serverBadge = document.getElementById("server-badge");
const serverText = document.getElementById("server-text");
const helpOffline = document.getElementById("help-offline");

let playlistUrl = "";
let jobId = null;
let pollTimer = null;
let serverOnline = false;

function getPlaylistUrl() {
  const params = new URLSearchParams(location.search);
  const direct = params.get("url") || params.get("playlist");
  if (direct) return direct.trim();

  const list = params.get("list");
  if (list) return `https://www.youtube.com/playlist?list=${list}`;

  return "";
}

function getFormat() {
  return document.querySelector('input[name="format"]:checked')?.value || "mp3";
}

function log(msg, type = "run") {
  statusEl.classList.add("visible", type);
  statusEl.classList.remove("ok", "err", "run");
  statusEl.classList.add(type);
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  statusEl.textContent = statusEl.textContent ? `${statusEl.textContent}\n${line}` : line;
  statusEl.scrollTop = statusEl.scrollHeight;
}

function setServerState(online) {
  serverOnline = online;
  serverBadge.classList.toggle("online", online);
  serverBadge.classList.toggle("offline", !online);
  serverText.textContent = online
    ? "Servidor local conectado"
    : "Servidor local offline";
  btnDownload.disabled = !online || !playlistUrl;
  helpOffline.hidden = online;
}

async function checkServer() {
  try {
    const res = await fetch(`${SERVER}/health`, { method: "GET", mode: "cors" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    setServerState(!!data.ok);
    return true;
  } catch {
    setServerState(false);
    return false;
  }
}

async function pollStatus() {
  if (!jobId) return;

  try {
    const res = await fetch(`${SERVER}/status/${jobId}`, { mode: "cors" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const job = await res.json();

    if (job.message) log(job.message);

    if (job.state === "done") {
      clearInterval(pollTimer);
      pollTimer = null;
      btnDownload.disabled = false;
      btnDownload.textContent = "Descargar MP3";
      log(`✓ Completado: ${job.files || 0} archivo(s) en ${job.outputDir || "Descargas"}`, "ok");
      return;
    }

    if (job.state === "error") {
      clearInterval(pollTimer);
      pollTimer = null;
      btnDownload.disabled = false;
      btnDownload.textContent = "Reintentar descarga";
      log(`✗ Error: ${job.error || "desconocido"}`, "err");
    }
  } catch (err) {
    log(`Error consultando estado: ${err.message}`, "err");
  }
}

async function startDownload() {
  if (!playlistUrl || !serverOnline) return;

  btnDownload.disabled = true;
  btnDownload.textContent = "Descargando…";
  statusEl.textContent = "";
  log(`Iniciando descarga (${getFormat().toUpperCase()})…`);

  try {
    const res = await fetch(`${SERVER}/download`, {
      method: "POST",
      mode: "cors",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: playlistUrl, format: getFormat() }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }

    const data = await res.json();
    jobId = data.jobId;
    log(`Trabajo iniciado (${jobId.slice(0, 8)}…)`);

    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(pollStatus, POLL_MS);
    pollStatus();
  } catch (err) {
    log(`No se pudo iniciar: ${err.message}`, "err");
    btnDownload.disabled = false;
    btnDownload.textContent = "Reintentar descarga";
  }
}

document.querySelectorAll(".format").forEach((label) => {
  label.addEventListener("click", () => {
    document.querySelectorAll(".format").forEach((l) => l.classList.remove("selected"));
    label.classList.add("selected");
    label.querySelector("input").checked = true;
    const fmt = getFormat();
    btnDownload.textContent = fmt === "mp3" ? "Descargar MP3" : `Descargar ${fmt.toUpperCase()}`;
  });
});

btnRecheck.addEventListener("click", async () => {
  log("Comprobando servidor…");
  await checkServer();
});

btnDownload.addEventListener("click", startDownload);

playlistUrl = getPlaylistUrl();

if (playlistUrl) {
  urlBox.textContent = playlistUrl;
  urlBox.classList.remove("empty");
  urlBox.title = playlistUrl;
} else {
  urlBox.textContent = "Sin URL — abrí esta página desde YouTube con el script de Tampermonkey.";
}

(async () => {
  const ok = await checkServer();
  if (ok && playlistUrl && new URLSearchParams(location.search).get("autostart") === "1") {
    startDownload();
  }
})();
