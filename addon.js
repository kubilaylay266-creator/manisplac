#!/usr/bin/env node
/* Stremio Public Domain Addon — tek dosya, bağımlılık yok (Node 18+) */
const http = require('http');
const crypto = require('crypto');

const PORT = process.env.PORT || 7000;
const HOST = process.env.HOST || '0.0.0.0';
const BASE = process.env.BASE_URL || `http://127.0.0.1:${PORT}`;

const MANIFEST = {
  id: 'org.example.pdstreams',
  version: '1.0.0',
  name: 'Public Domain Streams',
  description: 'Internet Archive public domain movies. Direct MP4 + torrent (P2P).',
  resources: ['catalog', 'meta', 'stream'],
  types: ['movie'],
  catalogs: [{ type: 'movie', id: 'pd', name: 'Public Domain Movies' }],
  idPrefixes: ['ia:'],
  behaviorHints: { adult: false }
};

/* ---------- HTTP yardımcıları ---------- */
function sendJSON(res, obj, code = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

async function getJSON(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'stremio-pd-addon/1.0' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function getBuffer(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'stremio-pd-addon/1.0' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

/* ---------- Oynatılabilirlik filtreleri ---------- */
function isVideo(name = '') { return /\.(mp4|m4v|webm|mkv|mov)$/i.test(name); }

function codecInfo(name = '') {
  const n = name.toLowerCase();
  const hevc = /(x265|hevc|h\.?265|10bit)/.test(n);
  const av1  = /(av1)/.test(n);
  const x264 = /(x264|h\.?264|avc)/.test(n);
  const aac  = /(aac)/.test(n);
  const badAudio = /(ac3|ac-3|dts|truehd|eac3)/.test(n);
  return { hevc, av1, x264, aac, badAudio };
}

/* Web'de (Stremio Web / tarayıcı) güvenli mi? */
function webFriendly(name = '') {
  if (!/\.(mp4|m4v|webm)$/i.test(name)) return false;
  const c = codecInfo(name);
  if (c.hevc || c.av1) return false;
  if (c.badAudio) return false;
  return true;
}

/* ---------- Bencode (torrent infoHash için) ---------- */
function readBencode(buf, start) {
  const c = buf[start];
  if (c === 0x69) { // 'i'
    const end = buf.indexOf(0x65, start);
    return { value: buf.slice(start, end + 1), end: end + 1 };
  }
  if (c === 0x6c) { // 'l'
    let p = start + 1;
    while (buf[p] !== 0x65) p = readBencode(buf, p).end;
    return { value: buf.slice(start, p + 1), end: p + 1 };
  }
  if (c === 0x64) { // 'd'
    let p = start + 1;
    while (buf[p] !== 0x65) {
      p = readBencode(buf, p).end; // key
      p = readBencode(buf, p).end; // value
    }
    return { value: buf.slice(start, p + 1), end: p + 1 };
  }
  const colon = buf.indexOf(0x3a, start);
  const len = parseInt(buf.slice(start, colon).toString(), 10);
  const end = colon + 1 + len;
  return { value: buf.slice(start, end), end };
}

function infoHashFromTorrent(buf) {
  const key = Buffer.from('4:info');
  const i = buf.indexOf(key);
  if (i < 0) return null;
  const start = i + key.length;
  const { value } = readBencode(buf, start);
  return crypto.createHash('sha1').update(value).digest('hex');
}

/* ---------- Internet Archive sağlayıcı ---------- */
async function iaSearch(query, rows = 30) {
  const q = query || 'collection:(feature_films) AND mediatype:(movies)';
  const url = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(q)}` +
    `&fl[]=identifier&fl[]=title&fl[]=description&fl[]=year` +
    `&rows=${rows}&page=1&output=json`;
  const data = await getJSON(url);
  return data.response?.docs || [];
}

async function iaMeta(identifier) {
  return getJSON(`https://archive.org/metadata/${identifier}`);
}

/* ---------- Endpoint'ler ---------- */
async function handleCatalog(type, catalogId, extra) {
  const docs = await iaSearch(extra?.search || null, 30);
  return {
    metas: docs.map(d => ({
      id: `ia:${d.identifier}`,
      type: 'movie',
      name: d.title || d.identifier,
      poster: `https://archive.org/services/img/${d.identifier}`,
      description: d.description || '',
      year: d.year ? Number(d.year) : undefined
    }))
  };
}

async function handleMeta(id) {
  const identifier = id.replace(/^ia:/, '');
  const meta = await iaMeta(identifier);
  const md = meta.metadata || {};
  return {
    meta: {
      id,
      type: 'movie',
      name: md.title || identifier,
      poster: `https://archive.org/services/img/${identifier}`,
      description: md.description || '',
      year: md.year ? Number(md.year) : undefined
    }
  };
}

async function handleStream(id) {
  const identifier = id.replace(/^ia:/, '');
  const meta = await iaMeta(identifier);
  const files = meta.files || [];
  const streams = [];

  // 1) Doğrudan oynatılabilir dosyalar
  for (const f of files) {
    if (!isVideo(f.name)) continue;
    const url = `https://archive.org/download/${identifier}/${encodeURIComponent(f.name)}`;
    const web = webFriendly(f.name);
    streams.push({
      url,
      title: `Direct · ${f.name}`,
      behaviorHints: {
        notWebReady: !web,
        bingeGroup: 'ia-direct',
        filename: f.name
      }
    });
  }

  // 2) Torrent (varsa) → P2P
  const torrent = files.find(f =>
    f.name.endsWith('_archive.torrent') || f.name.endsWith('.torrent')
  );
  if (torrent) {
    try {
      const tUrl = `https://archive.org/download/${identifier}/${encodeURIComponent(torrent.name)}`;
      const buf = await getBuffer(tUrl);
      const hash = infoHashFromTorrent(buf);
      if (hash) {
        // Ana video dosyasının index'ini bul (Stremio'da 0 = ilk dosya)
        let fileIdx = 0;
        const videoFiles = files.filter(f => isVideo(f.name));
        const main = videoFiles.find(f => /\.(mp4|mkv|webm|mov)$/i.test(f.name));
        if (main) {
          // Torrent içindeki sırayı garanti edemeyiz; Stremio dosya listesini
          // kullanıcıya gösterir. fileIdx=0 güvenli başlangıç.
          fileIdx = 0;
        }
        streams.push({
          infoHash: hash,
          fileIdx,
          title: `Torrent · P2P · ${identifier}`,
          sources: [
            `dht:${hash}`,
            'tracker:udp://tracker.opentrackr.org:1337/announce',
            'tracker:udp://tracker.openbittorrent.com:6969/announce'
          ],
          behaviorHints: { bingeGroup: 'ia-torrent' }
        });
      }
    } catch (e) {
      // torrent alınamazsa sessiz geç
    }
  }

  return { streams };
}

/* ---------- Router ---------- */
const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://${req.headers.host}`);

    if (u.pathname === '/manifest.json') return sendJSON(res, MANIFEST);

    // /catalog/{type}/{id}.json  (extra: ?search=...)
    let m = u.pathname.match(/^\/catalog\/([^/]+)\/([^/.]+)(?:\/([^/]+))?\.json$/);
    if (m) {
      const [, type, catalogId, extraStr] = m;
      const extra = {};
      if (extraStr) {
        try {
          for (const part of decodeURIComponent(extraStr).split('&')) {
            const [k, v] = part.split('=');
            extra[k] = decodeURIComponent(v || '');
          }
        } catch {}
      }
      // query string'den de oku
      for (const [k, v] of u.searchParams) extra[k] = v;
      const data = await handleCatalog(type, catalogId, extra);
      return sendJSON(res, data);
    }

    // /meta/{type}/{id}.json
    m = u.pathname.match(/^\/meta\/([^/]+)\/(.+)\.json$/);
    if (m) {
      const data = await handleMeta(m[2]);
      return sendJSON(res, data);
    }

    // /stream/{type}/{id}.json
    m = u.pathname.match(/^\/stream\/([^/]+)\/(.+)\.json$/);
    if (m) {
      const data = await handleStream(m[2]);
      return sendJSON(res, data);
    }

    // Sağlık kontrolü
    if (u.pathname === '/' || u.pathname === '/health') {
      return sendJSON(res, { ok: true, manifest: `${BASE}/manifest.json` });
    }

    sendJSON(res, { err: 'not found' }, 404);
  } catch (e) {
    console.error(e);
    sendJSON(res, { err: String(e) }, 500);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`✅ Addon hazır: ${BASE}/manifest.json`);
  console.log(`   Stremio → Addons → Install from URL → ${BASE}/manifest.json`);
});
