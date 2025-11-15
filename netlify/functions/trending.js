// netlify/functions/trending.js
const YouTubeMusicApi = require('youtube-music-api');

// --- copy of normalize helpers (same as search.js) ---
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
    else thumbnails = [];

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
  if (raw.browseId && raw.title && raw.subtitle && raw.thumbnail) {
    if ((raw.subtitle || '').toLowerCase().includes('songs')) return 'album';
  }
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
    const limit = Math.min(50, parseInt(params.limit || '25', 10) || 25);
    const region = params.region || params.country || ''; // optional

    const api = new YouTubeMusicApi();
    if (typeof api.initalize === 'function') await api.initalize();
    else if (typeof api.initialize === 'function') await api.initialize();
    else if (typeof api.init === 'function') await api.init();

    // try common method names for trending
    let raw;
    if (typeof api.trending === 'function') raw = await api.trending(region);
    else if (typeof api.getTrending === 'function') raw = await api.getTrending(region);
    else if (typeof api.get_top_charts === 'function') raw = await api.get_top_charts(region);
    else raw = {};

    // normalize result: if it's an object with lists, flatten
    let items = [];
    if (Array.isArray(raw)) items = raw.map(r => normalizeItem(r)).slice(0, limit);
    else if (raw && typeof raw === 'object') {
      // common keys that may contain entries
      const keys = ['items', 'results', 'tracks', 'songs', 'videos', 'content', 'charts'];
      for (const k of keys) {
        if (raw[k] && Array.isArray(raw[k])) items = items.concat(raw[k].map(r => normalizeItem(r)));
      }
      // fallback: collect array-like values
      if (items.length === 0) {
        for (const val of Object.values(raw)) {
          if (Array.isArray(val)) items = items.concat(val.map(r => normalizeItem(r)));
        }
      }
      items = items.slice(0, limit);
    }

    return {
      statusCode: 200,
      headers: defaultHeaders,
      body: JSON.stringify({ source: 'trending', count: items.length, items })
    };
  } catch (err) {
    console.error('trending function error:', err);
    return { statusCode: 500, headers: defaultHeaders, body: JSON.stringify({ error: 'Failed to fetch trending', details: err && err.message || String(err) }) };
  }
};
