// ==UserScript==
// @name         YouTube Playlist Downloader (con portada)
// @namespace    https://github.com/local/youtube-playlist-downloader
// @version      2.5.0
// @description  Elegí formato, arranca el servidor local y descarga con progreso.
// @author       You
// @match        https://www.youtube.com/*
// @match        https://youtube.com/*
// @match        https://m.youtube.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=youtube.com
// @require      https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/umd/ffmpeg.js
// @grant        GM_xmlhttpRequest
// @grant        GM_download
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @connect      www.youtube.com
// @connect      youtube.com
// @connect      i.ytimg.com
// @connect      cdn.jsdelivr.net
// @connect      cipher.kikkia.dev
// @connect      127.0.0.1
// @connect      localhost
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const API_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
    const CIPHER_API = 'https://cipher.kikkia.dev';
    const LOCAL_SERVER = 'http://127.0.0.1:7831';
    const LAUNCH_PROTOCOL = 'ypldl-start://run';
    const FORMATS = [
        { id: 'mp3', label: 'MP3 (audio, recomendado)', type: 'audio', ext: 'mp3' },
        { id: 'm4a', label: 'M4A / AAC (audio nativo)', type: 'audio', ext: 'm4a' },
        { id: 'opus', label: 'OPUS / WEBM (audio)', type: 'audio', ext: 'opus' },
        { id: 'flac', label: 'FLAC (audio sin perdida)', type: 'audio', ext: 'flac' },
        { id: 'wav', label: 'WAV (audio sin comprimir)', type: 'audio', ext: 'wav' },
        { id: 'mp4', label: 'MP4 (video + audio)', type: 'video', ext: 'mp4' },
        { id: 'webm', label: 'WEBM (video + audio)', type: 'video', ext: 'webm' },
    ];
    const MP3_FORMAT = FORMATS[0];

    const state = { running: false, abort: false, playlistCache: null };
    let playerJsUrlCache = null;
    let ffmpegInstance = null;
    let ffmpegWorkerBlobUrl = null;

    // --- HTTP ---

    function gmFetch(url, options = {}) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: options.method || 'GET',
                url,
                headers: options.headers || {},
                data: options.body || undefined,
                responseType: options.responseType || 'text',
                timeout: options.timeout || 600000,
                onload(res) {
                    if (res.status >= 200 && res.status < 300) resolve(res);
                    else reject(new Error(`HTTP ${res.status}`));
                },
                onerror: () => reject(new Error('Error de red (GM)')),
                ontimeout: () => reject(new Error('Timeout (GM)')),
            });
        });
    }

    const STREAM_HEADERS = {
        Referer: 'https://www.youtube.com/',
        Origin: 'https://www.youtube.com',
    };

    function fetchBufferPageXhr(url) {
        const win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
        return new Promise((resolve, reject) => {
            const xhr = new win.XMLHttpRequest();
            xhr.open('GET', url, true);
            xhr.responseType = 'arraybuffer';
            try {
                xhr.setRequestHeader('Referer', STREAM_HEADERS.Referer);
                xhr.setRequestHeader('Origin', STREAM_HEADERS.Origin);
            } catch (_) { /* algunos navegadores bloquean Origin en XHR cross-origin */ }
            xhr.timeout = 600000;
            xhr.onload = () => {
                if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.response);
                else reject(new Error(`HTTP ${xhr.status} (pagina)`));
            };
            xhr.onerror = () => reject(new Error('Error de red (pagina)'));
            xhr.ontimeout = () => reject(new Error('Timeout (pagina)'));
            xhr.send();
        });
    }

    function fetchBufferPageFetch(url) {
        const win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
        return win.fetch(url, {
            method: 'GET',
            credentials: 'omit',
            headers: STREAM_HEADERS,
        }).then(res => {
            if (!res.ok) throw new Error(`HTTP ${res.status} (fetch)`);
            return res.arrayBuffer();
        });
    }

    function gmFetchBuffer(url) {
        return gmFetch(url, {
            responseType: 'arraybuffer',
            headers: { ...STREAM_HEADERS, 'User-Agent': navigator.userAgent },
            timeout: 600000,
        }).then(res => res.response);
    }

    function fetchBufferViaPageScript(url) {
        const win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
        return new Promise((resolve, reject) => {
            const id = 'ypldl_' + Math.random().toString(36).slice(2);
            const timer = setTimeout(() => {
                win.removeEventListener('message', onMsg);
                reject(new Error('Timeout descarga'));
            }, 600000);

            const onMsg = (event) => {
                if (event.source !== win || event.data?.type !== 'ypldl-dl' || event.data.id !== id) return;
                win.removeEventListener('message', onMsg);
                clearTimeout(timer);
                if (event.data.error) reject(new Error(event.data.error));
                else resolve(event.data.buffer);
            };
            win.addEventListener('message', onMsg);

            const script = document.createElement('script');
            script.textContent = `(function(){
                fetch(${JSON.stringify(url)}, {
                    credentials: 'omit',
                    headers: { Referer: 'https://www.youtube.com/', Origin: 'https://www.youtube.com' }
                })
                .then(function(r){ if(!r.ok) throw new Error('HTTP '+r.status); return r.arrayBuffer(); })
                .then(function(buf){ window.postMessage({type:'ypldl-dl',id:${JSON.stringify(id)},buffer:buf},'*'); })
                .catch(function(e){ window.postMessage({type:'ypldl-dl',id:${JSON.stringify(id)},error:String(e.message||e)},'*'); });
            })();`;
            (document.head || document.documentElement).appendChild(script);
            script.remove();
        });
    }

    async function fetchBuffer(url) {
        const errors = [];
        for (const attempt of [
            () => fetchBufferViaPageScript(url),
            () => fetchBufferPageXhr(url),
            () => fetchBufferPageFetch(url),
            () => gmFetchBuffer(url),
        ]) {
            try {
                const buf = await attempt();
                if (buf && buf.byteLength > 0) return buf;
                errors.push('respuesta vacia');
            } catch (err) {
                errors.push(err.message);
            }
        }
        throw new Error(`No se pudo descargar el stream (${errors.join(' | ')})`);
    }

    async function pageFetch(url, options = {}) {
        const win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
        const res = await win.fetch(url, {
            method: options.method || 'GET',
            headers: options.headers || {},
            body: options.body,
            credentials: 'include',
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res;
    }

    async function pageFetchJson(url, options = {}) {
        const res = await pageFetch(url, options);
        return res.json();
    }

    function gmDownloadBlob(blob, filename) {
        return new Promise((resolve, reject) => {
            const url = URL.createObjectURL(blob);
            GM_download({
                url,
                name: filename,
                saveAs: false,
                onload: () => { URL.revokeObjectURL(url); resolve(); },
                onerror: (err) => { URL.revokeObjectURL(url); reject(new Error(err.error || 'Error al descargar')); },
            });
        });
    }

    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    function sanitizeFilename(name) {
        return (name || 'sin_titulo')
            .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 180);
    }

    // --- YouTube config ---

    function getPageConfig() {
        const ytcfg = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window).ytcfg?.data_ || {};
        return {
            apiKey: ytcfg.INNERTUBE_API_KEY || API_KEY,
            visitorData: ytcfg.VISITOR_DATA || '',
            context: ytcfg.INNERTUBE_CONTEXT ? JSON.parse(JSON.stringify(ytcfg.INNERTUBE_CONTEXT)) : null,
        };
    }

    function getInnertubeContext(clientName = 'WEB', clientVersion = '2.20250301.00.00') {
        return {
            client: {
                clientName,
                clientVersion,
                hl: 'es',
                gl: 'ES',
                utcOffsetMinutes: -new Date().getTimezoneOffset(),
            },
        };
    }

    async function innertubePost(endpoint, body) {
        const cfg = getPageConfig();
        const url = `https://www.youtube.com/youtubei/v1/${endpoint}?key=${cfg.apiKey}&prettyPrint=false`;
        const headers = { 'Content-Type': 'application/json' };
        if (cfg.visitorData) headers['X-Goog-Visitor-Id'] = cfg.visitorData;
        const payload = JSON.stringify(body);

        try {
            return await pageFetchJson(url, { method: 'POST', headers, body: payload });
        } catch (_) {
            return gmFetch(url, { method: 'POST', headers, body: payload })
                .then(r => JSON.parse(r.responseText));
        }
    }

    async function getPlayerJsUrl() {
        if (playerJsUrlCache) return playerJsUrlCache;

        const html = document.documentElement.innerHTML;
        const patterns = [
            /"jsUrl"\s*:\s*"([^"]+)"/,
            /"PLAYER_JS_URL"\s*:\s*"([^"]+)"/,
            /(\/s\/player\/[a-f0-9]+\/[^"\\]+base\.js)/,
        ];

        for (const re of patterns) {
            const m = html.match(re);
            if (m) {
                let path = m[1].replace(/\\u0026/g, '&').replace(/\\\//g, '/');
                if (!path.startsWith('http')) path = 'https://www.youtube.com' + path;
                playerJsUrlCache = path;
                return path;
            }
        }

        try {
            const res = await pageFetch('https://www.youtube.com/iframe_api');
            const text = await res.text();
            const m = text.match(/(\/s\/player\/[a-f0-9]+\/[^"]+base\.js)/);
            if (m) {
                playerJsUrlCache = 'https://www.youtube.com' + m[1];
                return playerJsUrlCache;
            }
        } catch (_) { /* ignore */ }

        throw new Error('No se pudo obtener el player de YouTube');
    }

    // --- Playlist parsing ---

    function extractPlaylistId() {
        const params = new URLSearchParams(location.search);
        const list = params.get('list');
        if (list && location.pathname.includes('playlist')) return list;
        return null;
    }

    function extractVideoFromRenderer(item) {
        const renderer = item?.playlistVideoRenderer || item?.richItemRenderer?.content?.playlistVideoRenderer;
        if (!renderer) return null;
        return {
            videoId: renderer.videoId,
            title: renderer.title?.simpleText || renderer.title?.runs?.map(r => r.text).join('') || 'Sin titulo',
            index: parseInt(renderer.index?.simpleText || renderer.index?.runs?.[0]?.text || '0', 10) || 0,
            author: renderer.shortBylineText?.runs?.[0]?.text || '',
        };
    }

    function extractVideoFromLockup(item) {
        const lockup = item?.lockupViewModel;
        if (!lockup || lockup.contentType !== 'LOCKUP_CONTENT_TYPE_VIDEO' || !lockup.contentId) return null;
        const meta = lockup.metadata?.lockupMetadataViewModel;
        return {
            videoId: lockup.contentId,
            title: meta?.title?.content || 'Sin titulo',
            author: meta?.metadata?.contentMetadataViewModel?.metadataRows?.[0]?.metadataParts?.[0]?.text?.content || '',
            index: 0,
        };
    }

    function dedupeVideos(videos) {
        const seen = new Set();
        const unique = [];
        for (const v of videos) {
            if (!v?.videoId || seen.has(v.videoId)) continue;
            seen.add(v.videoId);
            unique.push({ ...v, index: unique.length + 1 });
        }
        return unique;
    }

    function extractVideosFromSectionList(data) {
        const videos = [];
        const sections = data?.contents?.twoColumnBrowseResultsRenderer?.tabs?.[0]
            ?.tabRenderer?.content?.sectionListRenderer?.contents || [];

        for (const sec of sections) {
            for (const item of sec?.playlistVideoListRenderer?.contents || []) {
                const v = extractVideoFromRenderer(item) || extractVideoFromLockup(item);
                if (v) videos.push(v);
            }
            for (const item of sec?.itemSectionRenderer?.contents || []) {
                const v = extractVideoFromRenderer(item) || extractVideoFromLockup(item);
                if (v) videos.push(v);
                for (const nested of item?.playlistVideoListRenderer?.contents || []) {
                    const nv = extractVideoFromRenderer(nested) || extractVideoFromLockup(nested);
                    if (nv) videos.push(nv);
                }
            }
        }
        return dedupeVideos(videos);
    }

    function extractContinuationTokenFromSections(data) {
        const sections = data?.contents?.twoColumnBrowseResultsRenderer?.tabs?.[0]
            ?.tabRenderer?.content?.sectionListRenderer?.contents || [];

        for (const sec of sections) {
            const t1 = sec?.continuationItemViewModel?.continuationCommand?.innertubeCommand?.continuationCommand?.token;
            if (t1) return t1;
            for (const item of sec?.itemSectionRenderer?.contents || []) {
                const t2 = item?.continuationItemViewModel?.continuationCommand?.innertubeCommand?.continuationCommand?.token;
                if (t2) return t2;
                const t3 = item?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token;
                if (t3) return t3;
            }
        }
        return null;
    }

    function extractVideosFromContinuationData(data) {
        const videos = [];
        for (const action of data?.onResponseReceivedActions || []) {
            for (const item of action?.appendContinuationItemsAction?.continuationItems || []) {
                const v = extractVideoFromRenderer(item) || extractVideoFromLockup(item);
                if (v) videos.push(v);
            }
        }
        return videos;
    }

    function extractContinuationFromContinuationData(data) {
        for (const action of data?.onResponseReceivedActions || []) {
            for (const item of action?.appendContinuationItemsAction?.continuationItems || []) {
                const t1 = item?.continuationItemViewModel?.continuationCommand?.innertubeCommand?.continuationCommand?.token;
                if (t1) return t1;
                const t2 = item?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token;
                if (t2) return t2;
            }
        }
        return null;
    }

    function parseVideosFromDOM() {
        const seen = new Set();
        const videos = [];
        document.querySelectorAll('ytd-playlist-video-list-renderer a#video-title, a[href*="watch?v="]').forEach(link => {
            const m = link.href?.match(/[?&]v=([^&]+)/);
            const text = link.textContent?.trim() || link.getAttribute('title') || '';
            if (!m || seen.has(m[1]) || /play all/i.test(text)) return;
            if (link.closest('ytd-mini-guide-entry-renderer, ytd-guide-entry-renderer')) return;
            seen.add(m[1]);
            videos.push({ videoId: m[1], title: text || 'Sin titulo', index: videos.length + 1 });
        });
        return videos;
    }

    function getPlaylistTitle(data) {
        const header = data?.header?.playlistHeaderRenderer ||
            data?.sidebar?.playlistSidebarRenderer?.items?.[0]?.playlistSidebarPrimaryInfoRenderer;
        return header?.title?.simpleText || header?.title?.runs?.map(r => r.text).join('') || 'Playlist';
    }

    function getBrowseContext() {
        return getPageConfig().context || getInnertubeContext();
    }

    async function fetchFullPlaylist(playlistId, onProgress) {
        let title = 'Playlist';
        let videos = [];

        if (window.ytInitialData) {
            title = getPlaylistTitle(window.ytInitialData) || title;
            videos = extractVideosFromSectionList(window.ytInitialData);
        }

        let token = window.ytInitialData ? extractContinuationTokenFromSections(window.ytInitialData) : null;

        if (!videos.length) {
            const browseId = playlistId.startsWith('VL') ? playlistId : `VL${playlistId}`;
            const data = await innertubePost('browse', { context: getBrowseContext(), browseId });
            title = getPlaylistTitle(data) || title;
            videos = extractVideosFromSectionList(data);
            token = extractContinuationTokenFromSections(data);
        }

        while (token) {
            onProgress?.(`Cargando lista... ${videos.length} videos`);
            const cont = await innertubePost('browse', { context: getBrowseContext(), continuation: token });
            videos = dedupeVideos(videos.concat(extractVideosFromContinuationData(cont)));
            token = extractContinuationFromContinuationData(cont);
            await sleep(150);
        }

        if (!videos.length) videos = parseVideosFromDOM();
        if (!videos.length) throw new Error('La playlist esta vacia o es privada');

        onProgress?.(`Playlist "${title}": ${videos.length} videos`);
        state.playlistCache = { title, videos };
        return { title, videos };
    }

    // --- Streams ---

    function hasUsableStream(format) {
        return !!(format?.url || format?.signatureCipher || format?.cipher);
    }

    function getAllFormats(sd) {
        if (!sd) return [];
        return [...(sd.formats || []), ...(sd.adaptiveFormats || [])];
    }

    function hasUsableStreams(sd) {
        return getAllFormats(sd).some(hasUsableStream);
    }

    function formatBitrate(f) {
        return parseInt(f.bitrate, 10) || parseInt(f.averageBitrate, 10) || 0;
    }

    function parseYtInitialPlayerResponse(html) {
        for (const marker of ['ytInitialPlayerResponse = ', 'var ytInitialPlayerResponse = ']) {
            const start = html.indexOf(marker);
            if (start < 0) continue;
            let i = start + marker.length;
            while (html[i] === ' ' || html[i] === '\n') i++;
            if (html[i] !== '{') continue;
            let depth = 0;
            for (let j = i; j < html.length; j++) {
                if (html[j] === '{') depth++;
                else if (html[j] === '}') {
                    depth--;
                    if (depth === 0) {
                        try { return JSON.parse(html.slice(i, j + 1)); } catch (_) { return null; }
                    }
                }
            }
        }
        return null;
    }

    async function getSts() {
        try {
            const playerUrl = await getPlayerJsUrl();
            const res = await gmFetch(`${CIPHER_API}/get_sts`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ player_url: playerUrl }),
            });
            const data = JSON.parse(res.responseText);
            return data.sts || null;
        } catch (_) {
            return null;
        }
    }

    async function getPlayerDataFromWatchPage(videoId) {
        const res = await pageFetch(`https://www.youtube.com/watch?v=${videoId}&bpctr=9999999999&has_verified=1`);
        const html = await res.text();
        const data = parseYtInitialPlayerResponse(html);
        if (!data?.streamingData) throw new Error('Sin datos de reproduccion en watch');
        return data;
    }

    async function getPlayerData(videoId) {
        try {
            const fromWatch = await getPlayerDataFromWatchPage(videoId);
            if (hasUsableStreams(fromWatch.streamingData)) return fromWatch;
        } catch (_) { /* continuar */ }

        const cfg = getPageConfig();
        const sts = await getSts();
        const playbackContext = sts
            ? { contentPlaybackContext: { signatureTimestamp: sts } }
            : undefined;

        const webVersion = cfg.context?.client?.clientVersion || '2.20250301.00.00';
        const contexts = [
            cfg.context,
            getInnertubeContext('WEB', webVersion),
            { client: { clientName: 'MWEB', clientVersion: webVersion, hl: 'es', gl: 'ES' } },
            { client: { clientName: 'TVHTML5_SIMPLY', clientVersion: '2.0', hl: 'es', gl: 'ES' } },
            { client: { clientName: 'ANDROID', clientVersion: '19.45.37', androidSdkVersion: 30, hl: 'es', gl: 'ES' } },
        ].filter(Boolean);

        for (const context of contexts) {
            try {
                const body = {
                    context,
                    videoId,
                    contentCheckOk: true,
                    racyCheckOk: true,
                };
                if (playbackContext) body.playbackContext = playbackContext;
                const data = await innertubePost('player', body);
                if (hasUsableStreams(data?.streamingData)) return data;
            } catch (_) { /* siguiente */ }
        }

        try {
            const last = await getPlayerDataFromWatchPage(videoId);
            if (last?.streamingData) return last;
        } catch (_) { /* ignore */ }

        throw new Error('No se pudo obtener streams del video');
    }

    function pickFormat(streamingData, formatConfig) {
        const combined = streamingData.formats || [];
        const adaptive = streamingData.adaptiveFormats || [];
        const all = [...combined, ...adaptive];

        if (formatConfig.type === 'audio') {
            let pool = all.filter(f => f.mimeType?.startsWith('audio/') && hasUsableStream(f));

            if (!pool.length) {
                pool = combined.filter(f => hasUsableStream(f) && (
                    f.mimeType?.includes('mp4a') ||
                    (f.mimeType?.startsWith('video/') && f.mimeType?.includes('mp4'))
                ));
            }

            if (!pool.length) {
                pool = all.filter(f => hasUsableStream(f));
            }

            if (!pool.length) return null;

            const prefer = {
                m4a: f => f.itag === 140 || f.mimeType?.includes('mp4a'),
                opus: f => f.mimeType?.includes('opus'),
            };
            const matcher = prefer[formatConfig.id];
            if (matcher) {
                const matched = pool.filter(matcher);
                if (matched.length) pool = matched;
            }

            pool.sort((a, b) => formatBitrate(b) - formatBitrate(a));
            return pool[0];
        }

        let pool = all.filter(f => f.mimeType?.startsWith('video/') && hasUsableStream(f) && f.height);
        if (!pool.length) {
            pool = combined.filter(f => hasUsableStream(f) && f.mimeType?.startsWith('video/'));
        }
        const prefer = { mp4: f => f.mimeType?.includes('mp4'), webm: f => f.mimeType?.includes('webm') };
        const matcher = prefer[formatConfig.id];
        if (matcher) {
            const matched = pool.filter(matcher);
            if (matched.length) pool = matched;
        }
        pool.sort((a, b) => (parseInt(b.height, 10) || 0) - (parseInt(a.height, 10) || 0));
        return pool[0];
    }

    async function decryptStreamParams(encryptedSig, nParam) {
        const playerUrl = await getPlayerJsUrl();
        const res = await gmFetch(`${CIPHER_API}/decrypt_signature`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                encrypted_signature: encryptedSig,
                n_param: nParam || '',
                player_url: playerUrl,
            }),
        });
        const data = JSON.parse(res.responseText);
        if (!data.decrypted_signature && !data.decrypted_n_sig) {
            throw new Error(data.error || data.message || 'No se pudo descifrar el stream');
        }
        return data;
    }

    async function resolveStreamUrl(format) {
        if (format.url) return format.url;

        const cipher = format.signatureCipher || format.cipher;
        if (!cipher) throw new Error('Stream sin URL');

        const params = new URLSearchParams(cipher);
        const baseUrl = decodeURIComponent(params.get('url') || '');
        const encryptedSig = params.get('s');
        const sigKey = (params.get('sp') || 'sig').replace('=', '');

        if (!encryptedSig) return baseUrl;

        let nParam = '';
        try { nParam = new URL(baseUrl).searchParams.get('n') || ''; } catch (_) { /* ignore */ }

        const { decrypted_signature: decryptedSig, decrypted_n_sig: decryptedN } =
            await decryptStreamParams(encryptedSig, nParam);

        const url = new URL(baseUrl);
        if (decryptedSig) url.searchParams.set(sigKey, decryptedSig);
        if (decryptedN && nParam) url.searchParams.set('n', decryptedN);
        return url.toString();
    }

    function extFromMime(mime, fallback) {
        if (mime.includes('mp4a')) return 'm4a';
        if (mime.includes('opus')) return 'webm';
        if (mime.includes('audio/webm')) return 'webm';
        if (mime.includes('video/mp4')) return 'mp4';
        if (mime.includes('video/webm')) return 'webm';
        return fallback;
    }

    async function getThumbnailBuffer(videoId) {
        for (const q of ['maxresdefault', 'sddefault', 'hqdefault']) {
            try {
                const buf = await fetchBuffer(`https://i.ytimg.com/vi/${videoId}/${q}.jpg`);
                if (buf?.byteLength > 1000) return buf;
            } catch (_) { /* next */ }
        }
        throw new Error('No se pudo obtener la portada');
    }

    // --- FFmpeg.wasm (precargado via @require) ---

    async function fetchFile(input) {
        if (typeof input === 'string') {
            const buf = await fetchBuffer(input);
            return new Uint8Array(buf);
        }
        if (input instanceof Blob) {
            return new Uint8Array(await input.arrayBuffer());
        }
        if (input instanceof ArrayBuffer) {
            return new Uint8Array(input);
        }
        if (ArrayBuffer.isView(input)) {
            return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
        }
        throw new Error('Entrada no soportada para fetchFile');
    }

    async function toBlobURL(url, mimeType) {
        try {
            const res = await fetch(url);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const blob = new Blob([await res.arrayBuffer()], { type: mimeType });
            return URL.createObjectURL(blob);
        } catch (_) {
            const res = await gmFetch(url, { responseType: 'arraybuffer' });
            const blob = new Blob([res.response], { type: mimeType });
            return URL.createObjectURL(blob);
        }
    }

    async function getFfmpegWorkerBlobUrl() {
        if (ffmpegWorkerBlobUrl) return ffmpegWorkerBlobUrl;
        const workerSrc = 'https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/umd/814.ffmpeg.js';
        const res = await gmFetch(workerSrc, { responseType: 'text' });
        const blob = new Blob([res.responseText], { type: 'text/javascript' });
        ffmpegWorkerBlobUrl = URL.createObjectURL(blob);
        return ffmpegWorkerBlobUrl;
    }

    async function loadFfmpegInstance(onLog) {
        const workerBlob = await getFfmpegWorkerBlobUrl();
        const { FFmpeg } = FFmpegWASM;
        const ffmpeg = new FFmpeg();
        ffmpeg.on('log', ({ message }) => onLog?.(message));

        const coreBase = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/umd';
        const loadOpts = {
            coreURL: await toBlobURL(`${coreBase}/ffmpeg-core.js`, 'text/javascript'),
            wasmURL: await toBlobURL(`${coreBase}/ffmpeg-core.wasm`, 'application/wasm'),
        };

        const win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
        const NativeWorker = win.Worker;
        win.Worker = function (url, options) {
            const src = String(url);
            if (src.includes('814.ffmpeg.js')) return new NativeWorker(workerBlob, options);
            return new NativeWorker(url, options);
        };

        try {
            await ffmpeg.load(loadOpts);
        } finally {
            win.Worker = NativeWorker;
        }

        return ffmpeg;
    }

    async function getFFmpeg(onLog) {
        if (ffmpegInstance) return ffmpegInstance;
        onLog?.('Cargando conversor (solo la 1ra vez, ~30 MB)...');

        if (typeof FFmpegWASM === 'undefined') {
            throw new Error('FFmpeg no cargado. Actualiza el script en Tampermonkey.');
        }

        const ffmpeg = await loadFfmpegInstance(onLog);
        ffmpegInstance = { ffmpeg, fetchFile };
        return ffmpegInstance;
    }

    async function convertWithCover(audioBuffer, thumbBuffer, outputExt, onLog) {
        const { ffmpeg, fetchFile } = await getFFmpeg(onLog);
        const inputName = 'input_audio';
        const thumbName = 'cover.jpg';
        const outputName = `output.${outputExt}`;

        await ffmpeg.writeFile(inputName, await fetchFile(new Blob([audioBuffer])));
        await ffmpeg.writeFile(thumbName, await fetchFile(new Blob([thumbBuffer])));

        const args = ['-i', inputName, '-i', thumbName, '-map', '0:a', '-map', '1:v'];
        const codecs = {
            mp3: ['-c:a', 'libmp3lame', '-b:a', '320k', '-c:v', 'mjpeg', '-disposition:v', 'attached_pic'],
            flac: ['-c:a', 'flac', '-c:v', 'mjpeg', '-disposition:v', 'attached_pic'],
            opus: ['-c:a', 'libopus', '-b:a', '192k', '-c:v', 'mjpeg', '-disposition:v', 'attached_pic'],
            m4a: ['-c:a', 'aac', '-b:a', '256k', '-c:v', 'mjpeg', '-disposition:v', 'attached_pic'],
            wav: ['-c:a', 'pcm_s16le'],
        };
        args.push(...(codecs[outputExt] || ['-c:a', 'copy', '-c:v', 'mjpeg', '-disposition:v', 'attached_pic']));
        args.push('-y', outputName);

        await ffmpeg.exec(args);
        const out = await ffmpeg.readFile(outputName);
        await ffmpeg.deleteFile(inputName);
        await ffmpeg.deleteFile(thumbName);
        await ffmpeg.deleteFile(outputName);
        return out.buffer;
    }

    async function embedCoverInM4a(audioBuffer, thumbBuffer, onLog) {
        const { ffmpeg, fetchFile } = await getFFmpeg(onLog);
        await ffmpeg.writeFile('input.m4a', await fetchFile(new Blob([audioBuffer])));
        await ffmpeg.writeFile('cover.jpg', await fetchFile(new Blob([thumbBuffer])));
        await ffmpeg.exec(['-i', 'input.m4a', '-i', 'cover.jpg', '-map', '0', '-map', '1', '-c', 'copy', '-disposition:v:1', 'attached_pic', '-y', 'output.m4a']);
        const out = await ffmpeg.readFile('output.m4a');
        return out.buffer;
    }

    // --- Download ---

    async function downloadOneVideo(video, formatConfig, playlistTitle, onProgress, onLog) {
        const label = `[${video.index || '?'}] ${video.title}`;
        onProgress(`Obteniendo: ${label}`);

        const player = await getPlayerData(video.videoId);
        const streamFormat = pickFormat(player.streamingData, formatConfig);
        if (!streamFormat) throw new Error('Sin formato compatible');

        const streamUrl = await resolveStreamUrl(streamFormat);
        onProgress(`Descargando: ${label}`);
        const mediaBuffer = await fetchBuffer(streamUrl);
        const thumbBuffer = await getThumbnailBuffer(video.videoId);

        const prefix = sanitizeFilename(`${String(video.index || 0).padStart(3, '0')} - ${video.title}`);
        const folder = sanitizeFilename(playlistTitle);

        if (formatConfig.type === 'video') {
            const ext = extFromMime(streamFormat.mimeType || '', formatConfig.ext);
            await gmDownloadBlob(new Blob([mediaBuffer]), `${folder}/${prefix}.${ext}`);
            await gmDownloadBlob(new Blob([thumbBuffer], { type: 'image/jpeg' }), `${folder}/${prefix} - portada.jpg`);
            onProgress(`Guardado: ${folder}/${prefix}.${ext}`);
            return;
        }

        onProgress(`Convirtiendo a ${formatConfig.ext.toUpperCase()} + portada: ${label}`);
        let finalBuffer;
        let ext = formatConfig.ext;

        if (formatConfig.ext === 'm4a') {
            try { finalBuffer = await embedCoverInM4a(mediaBuffer, thumbBuffer, onLog); }
            catch (_) { finalBuffer = await convertWithCover(mediaBuffer, thumbBuffer, 'm4a', onLog); }
        } else if (formatConfig.ext === 'wav') {
            onLog('WAV: portada guardada como imagen aparte.');
            finalBuffer = await convertWithCover(mediaBuffer, thumbBuffer, 'wav', onLog);
            await gmDownloadBlob(new Blob([thumbBuffer], { type: 'image/jpeg' }), `${folder}/${prefix} - portada.jpg`);
        } else {
            finalBuffer = await convertWithCover(mediaBuffer, thumbBuffer, formatConfig.ext, onLog);
        }

        await gmDownloadBlob(new Blob([finalBuffer]), `${folder}/${prefix}.${ext}`);
        onProgress(`Guardado: ${folder}/${prefix}.${ext}`);
    }

    async function runBrowserDownload(playlistId, formatConfig, onProgress, onLog) {
        const { title, videos } = state.playlistCache?.videos?.length
            ? state.playlistCache
            : await fetchFullPlaylist(playlistId, onProgress);
        onLog(`${videos.length} videos en "${title}"`);
        let done = 0;

        for (const video of videos) {
            if (state.abort) break;
            try {
                await downloadOneVideo(video, formatConfig, title, onProgress, onLog);
                done++;
            } catch (err) {
                onLog(`ERROR "${video.title}": ${err.message}`);
            }
            await sleep(600);
        }

        onProgress(`Finalizado: ${done}/${videos.length} descargados.`);
    }

    // --- UI ---

    function injectStyles() {
        if (document.getElementById('ypldl-styles')) return;
        const style = document.createElement('style');
        style.id = 'ypldl-styles';
        style.textContent = `
            #ypldl-overlay { position:fixed; inset:0; z-index:999999; background:rgba(0,0,0,.72);
                display:flex; align-items:center; justify-content:center;
                font-family:"YouTube Noto",Roboto,Arial,sans-serif; }
            #ypldl-modal { background:#212121; color:#f1f1f1; border-radius:12px;
                width:min(520px,92vw); max-height:88vh; overflow:auto;
                box-shadow:0 8px 40px rgba(0,0,0,.55); padding:24px; }
            #ypldl-modal h2 { margin:0 0 8px; font-size:20px; }
            #ypldl-modal p { margin:0 0 16px; color:#aaa; font-size:13px; line-height:1.5; }
            .ypldl-formats { display:grid; gap:8px; margin-bottom:16px; }
            .ypldl-format { display:flex; align-items:center; gap:10px; background:#303030;
                border:2px solid transparent; border-radius:8px; padding:10px 12px; cursor:pointer; }
            .ypldl-format:hover { background:#3a3a3a; }
            .ypldl-format.selected { border-color:#ff0033; background:#3a2028; }
            .ypldl-format input { accent-color:#ff0033; }
            #ypldl-progress { background:#111; border-radius:8px; padding:12px; font-size:12px;
                line-height:1.6; max-height:180px; overflow-y:auto; white-space:pre-wrap;
                word-break:break-word; margin-bottom:16px; display:none; }
            .ypldl-actions { display:flex; gap:10px; justify-content:flex-end; }
            .ypldl-btn { border:none; border-radius:999px; padding:10px 18px; font-weight:600; cursor:pointer; font-size:14px; }
            .ypldl-btn-primary { background:#ff0033; color:#fff; }
            .ypldl-btn-primary:disabled { opacity:.5; cursor:not-allowed; }
            .ypldl-btn-secondary { background:#3a3a3a; color:#f1f1f1; }
            #ypldl-fab { position:fixed; bottom:24px; right:24px; z-index:999998;
                background:#ff0033; color:#fff; border:none; border-radius:999px;
                padding:12px 20px; font-weight:700; cursor:pointer;
                box-shadow:0 4px 20px rgba(255,0,51,.45); font-family:Roboto,Arial,sans-serif; font-size:14px; }
            #ypldl-fab:hover { filter:brightness(1.08); }
            #ypldl-fab:disabled { opacity:.55; cursor:not-allowed; }
            #ypldl-panel { position:fixed; bottom:80px; right:24px; z-index:999998;
                width:min(360px,92vw); background:#212121; color:#f1f1f1; border-radius:12px;
                box-shadow:0 8px 32px rgba(0,0,0,.55); padding:14px 16px; display:none;
                font-family:Roboto,Arial,sans-serif; }
            #ypldl-panel.visible { display:block; }
            #ypldl-panel h3 { margin:0 0 8px; font-size:14px; }
            #ypldl-panel-log { background:#111; border-radius:8px; padding:10px; font-size:11px;
                line-height:1.5; max-height:140px; overflow-y:auto; white-space:pre-wrap;
                word-break:break-word; margin-bottom:10px; }
            #ypldl-panel-close { background:#3a3a3a; color:#f1f1f1; border:none;
                border-radius:999px; padding:6px 14px; font-size:12px; cursor:pointer; float:right; }
        `;
        document.head.appendChild(style);
    }

    function createModal() {
        injectStyles();
        const overlay = document.createElement('div');
        overlay.id = 'ypldl-overlay';
        overlay.innerHTML = `
            <div id="ypldl-modal">
                <h2>Descargar playlist</h2>
                <p>
                    Elegí el formato y tocá Descargar. El servidor local se inicia solo
                    (yt-dlp + portada embebida). Los archivos van a Descargas / YouTube Playlists.
                </p>
                <div class="ypldl-formats">
                    ${FORMATS.map((f, i) => `
                        <label class="ypldl-format${i === 0 ? ' selected' : ''}">
                            <input type="radio" name="ypldl-format" value="${f.id}" ${i === 0 ? 'checked' : ''}>
                            <span>${f.label}</span>
                        </label>
                    `).join('')}
                </div>
                <div id="ypldl-progress"></div>
                <div class="ypldl-actions">
                    <button class="ypldl-btn ypldl-btn-secondary" id="ypldl-cancel">Cancelar</button>
                    <button class="ypldl-btn ypldl-btn-primary" id="ypldl-start">Descargar</button>
                </div>
            </div>`;

        document.body.appendChild(overlay);

        overlay.querySelectorAll('.ypldl-format').forEach(label => {
            label.addEventListener('click', () => {
                overlay.querySelectorAll('.ypldl-format').forEach(l => l.classList.remove('selected'));
                label.classList.add('selected');
                label.querySelector('input').checked = true;
            });
        });

        const progressEl = overlay.querySelector('#ypldl-progress');
        const startBtn = overlay.querySelector('#ypldl-start');
        const cancelBtn = overlay.querySelector('#ypldl-cancel');
        const logLines = [];
        const setProgress = (msg) => {
            progressEl.style.display = 'block';
            if (logLines.length && logLines[logLines.length - 1] === msg) return;
            logLines.push(msg);
            if (logLines.length > 80) logLines.shift();
            progressEl.textContent = logLines.join('\n');
            progressEl.scrollTop = progressEl.scrollHeight;
        };

        const close = () => {
            state.abort = true;
            state.running = false;
            overlay.remove();
            const fab = document.getElementById('ypldl-fab');
            if (fab) { fab.disabled = false; fab.textContent = 'Descargar playlist'; }
        };
        cancelBtn.addEventListener('click', close);
        overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

        setProgress('Playlist detectada. Elegí formato y tocá Descargar.');

        startBtn.addEventListener('click', async () => {
            if (state.running) return;
            state.running = true;
            state.abort = false;
            startBtn.disabled = true;
            cancelBtn.textContent = 'Cerrar';

            const formatId = overlay.querySelector('input[name="ypldl-format"]:checked').value;
            const fab = document.getElementById('ypldl-fab');
            if (fab) { fab.disabled = true; fab.textContent = 'Descargando…'; }

            try {
                await downloadViaLocalServer(formatId, setProgress);
            } catch (err) {
                setProgress(`Error: ${err.message}`);
            } finally {
                state.running = false;
                startBtn.disabled = false;
                startBtn.textContent = 'Reintentar';
                if (fab) { fab.disabled = false; fab.textContent = 'Descargar playlist'; }
            }
        });
    }

    async function isServerUp() {
        try {
            await gmFetch(`${LOCAL_SERVER}/health`);
            return true;
        } catch {
            return false;
        }
    }

    async function ensureServer(setProgress) {
        if (await isServerUp()) return;

        setProgress('Arrancando servidor local…');
        const launcher = document.createElement('iframe');
        launcher.style.display = 'none';
        launcher.src = LAUNCH_PROTOCOL;
        document.body.appendChild(launcher);
        setTimeout(() => launcher.remove(), 3000);

        for (let i = 0; i < 20; i++) {
            await sleep(1500);
            if (await isServerUp()) {
                setProgress('Servidor listo.');
                return;
            }
        }

        throw new Error(
            'No pudo iniciar el servidor. Ejecutá una sola vez: instalar-un-clic.bat'
        );
    }

    async function downloadViaLocalServer(format, setProgress) {
        await ensureServer(setProgress);
        setProgress(`Iniciando descarga en ${format.toUpperCase()}…`);

        const res = await gmFetch(`${LOCAL_SERVER}/download`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: location.href, format }),
        });
        const { jobId } = JSON.parse(res.responseText);
        let lastMsg = '';

        while (!state.abort) {
            await sleep(2000);
            const st = await gmFetch(`${LOCAL_SERVER}/status/${jobId}`);
            const job = JSON.parse(st.responseText);
            if (job.message && job.message !== lastMsg) {
                setProgress(job.message);
                lastMsg = job.message;
            }
            if (job.state === 'done') {
                setProgress(`✓ Listo: ${job.files} archivo(s)`);
                setProgress(`Carpeta: ${job.outputDir}`);
                return;
            }
            if (job.state === 'error') {
                throw new Error(job.error || 'Error en yt-dlp');
            }
        }
    }

    function openDownloadModal() {
        if (!extractPlaylistId()) {
            alert('Abrí una playlist de YouTube (URL con ?list=...)');
            return;
        }
        createModal();
    }

    function addFloatingButton() {
        if (document.getElementById('ypldl-fab')) return;
        const btn = document.createElement('button');
        btn.id = 'ypldl-fab';
        btn.textContent = 'Descargar playlist';
        btn.title = 'Elegir formato y descargar con progreso';
        btn.addEventListener('click', openDownloadModal);
        document.body.appendChild(btn);
    }

    function init() {
        if (!extractPlaylistId()) return;
        injectStyles();
        addFloatingButton();
    }

    GM_registerMenuCommand('Descargar playlist', openDownloadModal);

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();

    let lastUrl = location.href;
    new MutationObserver(() => {
        if (location.href !== lastUrl) { lastUrl = location.href; setTimeout(init, 800); }
    }).observe(document.body, { childList: true, subtree: true });

})();
