/* ---------- /stream/{type}/{id}.json — IMDB ID ile IA arama ---------- */
async function handleStreamByImdb(id) {
  // id "tt1234567" veya "tt1234567:1:2" (dizi) gelebilir
  const imdb = id.split(':')[0];
  if (!/^tt\d+$/.test(imdb)) return { streams: [] };

  // 1) IA'da IMDB ID ile ara
  const q = `external-identifier:"urn:imdb:${imdb}"`;
  const searchUrl = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(q)}` +
    `&fl[]=identifier&rows=10&output=json`;
  const s = await getJSON(searchUrl).catch(() => ({ response: { docs: [] } }));
  const docs = s.response?.docs || [];

  const streams = [];

  for (const doc of docs) {
    const identifier = doc.identifier;
    if (!identifier) continue;
    let meta;
    try { meta = await iaMeta(identifier); } catch { continue; }
    const files = meta.files || [];

    // Direct oynatılabilir dosyalar
    for (const f of files) {
      if (!isVideo(f.name)) continue;
      const url = `https://archive.org/download/${identifier}/${encodeURIComponent(f.name)}`;
      streams.push({
        url,
        title: `IA · Direct · ${f.name}`,
        behaviorHints: {
          notWebReady: !webFriendly(f.name),
          bingeGroup: 'ia-direct',
          filename: f.name
        }
      });
    }

    // Torrent
    const t = files.find(f => f.name.endsWith('_archive.torrent') || f.name.endsWith('.torrent'));
    if (t) {
      try {
        const buf = await getBuffer(`https://archive.org/download/${identifier}/${encodeURIComponent(t.name)}`);
        const hash = infoHashFromTorrent(buf);
        if (hash) {
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

  // 2) Torrent yoksa ama IA’da direct varsa onlar zaten streams’te
  return { streams };
}
