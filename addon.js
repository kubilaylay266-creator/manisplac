#!/usr/bin/env node
/* Stream-only IA addon — metadata yok, Cinemeta ile birlikte çalışır */
const http = require('http');
const crypto = require('crypto');

const PORT = process.env.PORT || 7000;
const HOST = process.env.HOST || '0.0.0.0';
const BASE = process.env.BASE_URL || `http://127.0.0.1:${PORT}`;

const MANIFEST = {
  id: 'org.example.ia-streams',
  version: '1.0.0',
  name: 'IA Streams',
  description: 'Internet Archive torrent + direct sources (stream only)',
  resources: ['stream'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],            // Cinemeta'nın IMDB ID'lerini kabul et
  behaviorHints: { adult: false }
};

function sendJSON(res, obj, code = 200) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(obj));
}
async function getJSON(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'ia-streams/1.0' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
async function getBuffer(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'ia-streams/1.0' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

function isVideo(n=''){ return /\.(mp4|m4v|webm|mkv|mov)$/i.test(n); }
function webFriendly(n=''){
  if (!/\.(mp4|m4v|webm)$/i.test(n)) return false;
  const l = n.toLowerCase();
  if (/(x265|hevc|h\.?265|10bit|av1)/.test(l)) return false;
  if (/(ac3|ac-3|dts|truehd|eac3)/.test(l)) return false;
  return true;
}

/* bencode → infoHash */
function readBencode(buf, s){
  const c = buf[s];
  if (c === 0x69) { const e = buf.indexOf(0x65,s); return {value:buf.slice(s,e+1),end:e+1}; }
  if (c === 0x6c) { let p=s+1; while(buf[p]!==0x65)p=readBencode(buf,p).end; return {value:buf.slice(s,p+1),end:p+1}; }
  if (c === 0x64) { let p=s+1; while(buf[p]!==0x65){ p=readBencode(buf,p).end; p=readBencode(buf,p).end; } return {value:buf.slice(s,p+1),end:p+1}; }
  const col = buf.indexOf(0x3a,s); const len = parseInt(buf.slice(s,col).toString(),10);
  const e = col+1+len; return {value:buf.slice(s,e),end:e};
}
function infoHashFromTorrent(buf){
  const key = Buffer.from('4:info'); const i = buf.indexOf(key);
  if (i<0) return null;
  const {value} = readBencode(buf, i+key.length);
  return crypto.createHash('sha1').update(value).digest('hex');
}

/* IMDB ID ile IA ara → stream döndür */
async function streamsForImdb(imdb){
  const q = `external-identifier:"urn:imdb:${imdb}"`;
  const url = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(q)}` +
    `&fl[]=identifier&rows=10&output=json`;
  const s = await getJSON(url).catch(() => ({ response: { docs: [] } }));
  const docs = s.response?.docs || [];
  const streams = [];

  for (const doc of docs){
    const identifier = doc.identifier;
    if (!identifier) continue;
    let meta;
    try { meta = await getJSON(`https://archive.org/metadata/${identifier}`); } catch { continue; }
    const files = meta.files || [];

    for (const f of files){
      if (!isVideo(f.name)) continue;
      streams.push({
        url: `https://archive.org/download/${identifier}/${encodeURIComponent(f.name)}`,
        title: `IA · ${f.name}`,
        behaviorHints: { notWebReady: !webFriendly(f.name), bingeGroup: 'ia-direct', filename: f.name }
      });
    }

    const t = files.find(f => f.name.endsWith('_archive.torrent') || f.name.endsWith('.torrent'));
    if (t){
      try {
        const buf = await getBuffer(`https://archive.org/download/${identifier}/${encodeURIComponent(t.name)}`);
        const hash = infoHashFromTorrent(buf);
        if (hash){
          streams.push({
            infoHash: hash,
            fileIdx: 0,
            title: `IA · Torrent · ${identifier}`,
            sources: [
              `dht:${hash}`,
              'tracker:udp://tracker.opentrackr.org:1337/announce',
              'tracker:udp://tracker.openbittorrent.com:6969/announce'
            ],
            behaviorHints: { bingeGroup: 'ia-torrent' }
          });
        }
      } catch {}
    }
  }
  return { streams };
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://${req.headers.host}`);
    if (u.pathname === '/manifest.json') return sendJSON(res, MANIFEST);
    if (u.pathname === '/health') return sendJSON(res, { ok: true });

    const m = u.pathname.match(/^\/stream\/([^/]+)\/(.+)\.json$/);
    if (m){
      const imdb = m[2].split(':')[0];           // tt1234567:1:2 → tt1234567
      if (!/^tt\d+$/.test(imdb)) return sendJSON(res, { streams: [] });
      return sendJSON(res, await streamsForImdb(imdb));
    }
    sendJSON(res, { err: 'not found' }, 404);
  } catch (e) {
    console.error(e);
    sendJSON(res, { streams: [] });
  }
});

server.listen(PORT, HOST, () => console.log(`✅ ${BASE}/manifest.json`));
