// netlify/functions/search_multi.js
const YouTubeMusicApi = require('youtube-music-api');

// re-use normalizeItem, extractVideoId, detectType from search.js pattern
function normalizeItem(raw, typeHint) {
  try {
    const coerceToArray = (val) => {
      if (!val && val !== 0) return [];
      if (Array.isArray(val)) return val;
      if (typeof val === 'object') {
        if (val.name && typeof val.name === 'string') return [{ name: val.name }];
        return Object.values(val).filter(Boolean);
      }
      return [val];
    };
    const extractNameFromArtistEntry = (a) => {
      if (!a && a !== 0) return null;
      if (typeof a === 'string') return a;
      if (typeof a === 'object') {
        return a.name || a.title || a.artist || null;
      }
      return null;
    };
    const type = typeHint || raw.type || detectType(raw);
    const title = raw.title || raw.name || raw.subtitle || '';
    const id = raw.videoId || raw.entityId || raw.browseId || raw.id || raw.video_id || '';
    const artistsRaw = raw.artists || raw.artist || raw.subtitles || [];
    const artistsArr = coerceToArray(artistsRaw);
    const artists = artistsArr.map(extractNameFromArtistEntry).filter(Boolean);
    let thumbnails = [];
    if (Array.isArray(raw.thumbnails)) thumbnails = raw.thumbnails;
    else if (raw.thumbnail) thumbnails = (Array.isArray(raw.thumbnail) ? raw.thumbnail : [raw.thumbnail]);
    else if (raw.thumbs) thumbnails = raw.thumbs;
    const duration = raw.duration || raw.length || raw.duration_seconds || null;
    const videoId = raw.videoId || raw.id || (raw.url && extractVideoId(raw.url)) || null;
    const watchUrl = videoId ? `https://www.youtube.com/watch?v=${videoId}` : null;
    const embedUrl = videoId ? `https://www.youtube.com/embed/${videoId}` : null;
    return { type, id, title, artists, thumbnails, duration, raw, videoId, watchUrl, embedUrl };
  } catch (err) {
    return {
      type: typeHint || (raw && raw.type) || 'unknown',
      id: raw && (raw.videoId || raw.id || raw.entityId) || null,
      title: raw && (raw.title || raw.name) || null,
      artists: [],
      thumbnails: [],
      duration: null,
      raw,
      videoId: raw && (raw.videoId || raw.id) || null,
      watchUrl: null,
      embedUrl: null,
      warning: 'normalizeItem failed: ' + (err && err.message ? err.message : String(err))
    };
  }
}

function extractVideoId(url) {
  if (!url) return null;
  const m = url.match(/[?&]v=([^&]+)/) || url.match(/\/watch\/([^?&/]+)/) || url.match(/\/embed\/([^?&/]+)/);
  return m ? m[1] : null;
}
function detectType(raw) {
  if (!raw) return 'unknown';
  if (raw.type) return raw.type;
  if (raw.videoId) return 'song';
  return 'other';
}

exports.handler = async function (event, context) {
  const defaultHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json"
  };

  try {
    const params = event.queryStringParameters || {};
    const q = (params.q || params.query || '').trim();
    const limit = Math.min(100, parseInt(params.limit || '50', 10) || 50);

    if (!q) {
      return { statusCode: 400, headers: defaultHeaders, body: JSON.stringify({ error: 'Missing query param "q"' }) };
    }

    const api = new YouTubeMusicApi();
    if (typeof api.initalize === 'function') await api.initalize();
    else if (typeof api.initialize === 'function') await api.initialize();
    else if (typeof api.init === 'function') await api.init();

    // Try multiple method names for "multi" search
    let raw = null;
    if (typeof api.searchMulti === 'function') raw = await api.searchMulti(q);
    else if (typeof api.search_multi === 'function') raw = await api.search_multi(q);
    else if (typeof api.search === 'function') raw = await api.search(q);
    else raw = {};

    // raw might be object with different keys (songs, albums, artists, playlists)
    const buckets = ['songs', 'albums', 'artists', 'playlists', 'videos', 'results', 'content'];
    let items = [];
    if (Array.isArray(raw)) items = raw.map(r => normalizeItem(r));
    else if (raw && typeof raw === 'object') {
      for (const b of buckets) {
        if (raw[b] && Array.isArray(raw[b])) {
          items = items.concat(raw[b].map(r => normalizeItem(r)));
        } else if (raw[b] && raw[b].results && Array.isArray(raw[b].results)) {
          items = items.concat(raw[b].results.map(r => normalizeItem(r)));
        }
      }
      // fallback: flatten any arrays found
      if (items.length === 0) {
        for (const v of Object.values(raw)) {
          if (Array.isArray(v)) items = items.concat(v.map(r => normalizeItem(r)));
        }
      }
    }

    items = items.slice(0, limit);

    return { statusCode: 200, headers: defaultHeaders, body: JSON.stringify({ query: q, count: items.length, items }) };
  } catch (err) {
    console.error('search_multi error:', err);
    return { statusCode: 500, headers: defaultHeaders, body: JSON.stringify({ error: 'Failed search_multi', details: err && err.message || String(err) }) };
  }
};
