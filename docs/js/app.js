const REPO = "FelixAyram/youtube-mp3";

const urlBox = document.getElementById("url-box");
const btnDownload = document.getElementById("btn-download");

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

function buildIssueUrl(playlistUrl, format) {
  const title = encodeURIComponent(`[DOWNLOAD] ${playlistUrl}`);
  const body = encodeURIComponent(`format:${format}\n\nDescarga automatica desde GitHub Actions.`);
  return `https://github.com/${REPO}/issues/new?title=${title}&body=${body}`;
}

function updateDownloadLink() {
  const playlistUrl = getPlaylistUrl();
  const format = getFormat();

  if (!playlistUrl) {
    btnDownload.href = "#";
    btnDownload.classList.add("disabled");
    btnDownload.style.pointerEvents = "none";
    btnDownload.style.opacity = "0.45";
    btnDownload.textContent = "Falta URL de playlist";
    return;
  }

  btnDownload.href = buildIssueUrl(playlistUrl, format);
  btnDownload.style.pointerEvents = "";
  btnDownload.style.opacity = "";
  btnDownload.textContent =
    format === "mp3" ? "Descargar MP3 en GitHub" : `Descargar ${format.toUpperCase()} en GitHub`;
}

document.querySelectorAll(".format").forEach((label) => {
  label.addEventListener("click", () => {
    document.querySelectorAll(".format").forEach((l) => l.classList.remove("selected"));
    label.classList.add("selected");
    label.querySelector("input").checked = true;
    updateDownloadLink();
  });
});

const playlistUrl = getPlaylistUrl();

if (playlistUrl) {
  urlBox.textContent = playlistUrl;
  urlBox.classList.remove("empty");
  urlBox.title = playlistUrl;
} else {
  urlBox.textContent = "Abrí esta página desde YouTube con el botón de Tampermonkey.";
}

updateDownloadLink();

if (playlistUrl && new URLSearchParams(location.search).get("autostart") === "1") {
  window.open(buildIssueUrl(playlistUrl, getFormat()), "_blank", "noopener");
  document.getElementById("step-1")?.classList.add("done");
  document.getElementById("step-2")?.classList.add("active");
}
