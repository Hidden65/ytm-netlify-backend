// netlify/functions/search.js
const YouTubeMusicApi = require('youtube-music-api');

// Helper: normalize various item shapes returned by youtube-music-api
function normalizeItem(raw, typeHint) {
  try {
    // Defensive helpers for artists/subtitles/thumbnails/duration
    const coerceToArray = (val) => {
      if (!val && val !== 0) return [];
      if (Array.isArray(val)) return val;
      // If it's an object with numeric keys or 'name' prop, try to extract
      if (typeof val === 'object') {
        // common shape: { name: 'Artist' } or {0: {...}, 1: {...}}
        if (val.name && typeof val.name === 'string') return [{ name: val.name }];
        // flatten object values
        return Object.values(val).filter(Boolean);
      }
      // string -> single element array
      return [val];
    };

    const extractNameFromArtistEntry = (a) => {
      if (!a && a !== 0) return null;
      if (typeof a === 'string') return a;
      if (typeof a === 'object') {
        // common object shapes: { name: 'X' } or { title: 'X' } or { id: '...', name: 'X' }
        return a.name || a.title || a.artist || null;
      }
      return null;
    };

    const type = typeHint || raw.type || detectType(raw);
    const title = raw.title || raw.name || raw.subtitle || '';
    const id = raw.videoId || raw.entityId || raw.browseId || raw.id || raw.video_id || '';
    // artists / subtitles normalization (defensive)
    const artistsRaw = raw.artists || raw.artist || raw.subtitles || [];
    const artistsArr = coerceToArray(artistsRaw);
    const artists = artistsArr
      .map(extractNameFromArtistEntry)
      .filter(Boolean);

    // thumbnails can be a single object, an array, or nested
    let thumbnails = [];
    if (Array.isArray(raw.thumbnails)) thumbnails = raw.thumbnails;
    else if (raw.thumbnail) thumbnails = (Array.isArray(raw.thumbnail) ? raw.thumbnail : [raw.thumbnail]);
    else if (raw.thumbs) thumbnails = raw.thumbs;
    else thumbnails = [];

    const duration = raw.duration || raw.length || raw.duration_seconds || null;

    // Construct YouTube URLs when a videoId is available
    const videoId = raw.videoId || raw.id || (raw.url && extractVideoId(raw.url)) || null;
    const watchUrl = videoId ? `https://www.youtube.com/watch?v=${videoId}` : null;
    const embedUrl = videoId ? `https://www.youtube.com/embed/${videoId}` : null;

    return {
      type,
      id,
      title,
      artists,
      thumbnails,
      duration,
      raw,
      videoId,
      watchUrl,
      embedUrl
    };
  } catch (err) {
    // Don't throw — return a best-effort minimal object and include the error message
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
      // warning helps debugging in logs without crashing entire function
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
    if ((raw.subtitle || '').toLowerCase().includes('songs') || (raw.subtitle || '').toLowerCase().includes('tracks')) {
      return 'album';
    }
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
    const q = (params.q || params.query || '').trim();
    const type = (params.type || '').trim().toLowerCase(); // optional: song|video|album|artist|playlist
    const limit = Math.min(50, parseInt(params.limit || '25', 10) || 25);

    if (!q) {
      return {
        statusCode: 400,
        headers: defaultHeaders,
        body: JSON.stringify({ error: 'Missing query param "q". Example: ?q=never%20gonna%20give%20you%20up' })
      };
    }

    const api = new YouTubeMusicApi();
    if (typeof api.initalize === 'function') {
      await api.initalize();
    } else if (typeof api.initialize === 'function') {
      await api.initialize();
    } else if (typeof api.init === 'function') {
      await api.init();
    }

    let rawResults;
    if (type && ['song', 'video', 'album', 'artist', 'playlist'].includes(type)) {
      rawResults = await api.search(q, type);
    } else {
      rawResults = await api.search(q);
    }

    let items = [];

    if (Array.isArray(rawResults)) {
      items = rawResults.map(r => normalizeItem(r));
    } else if (rawResults && typeof rawResults === 'object') {
      const possibleKeys = ['songs', 'albums', 'videos', 'artists', 'playlists', 'result', 'content', 'resultArray', 'results'];
      let found = false;
      for (const k of possibleKeys) {
        if (rawResults[k]) {
          found = true;
          const block = rawResults[k];
          if (Array.isArray(block)) {
            items = items.concat(block.map(r => normalizeItem(r, inferTypeFromKey(k))));
          } else if (block && Array.isArray(block.results || block.contents || block.items)) {
            const arr = block.results || block.contents || block.items;
            items = items.concat(arr.map(r => normalizeItem(r, inferTypeFromKey(k))));
          } else if (block && typeof block === 'object') {
            const arr = block.results || block.contents || block.items || [];
            items = items.concat((Array.isArray(arr) ? arr : []).map(r => normalizeItem(r, inferTypeFromKey(k))));
          }
        }
      }
      if (!found) {
        for (const v of Object.values(rawResults)) {
          if (Array.isArray(v)) {
            items = items.concat(v.map(r => normalizeItem(r)));
          }
        }
      }
    }

    items = items.slice(0, limit);

    return {
      statusCode: 200,
      headers: defaultHeaders,
      body: JSON.stringify({
        query: q,
        type: type || 'all',
        count: items.length,
        items
      })
    };

  } catch (err) {
    console.error('Netlify function search error:', err);
    const message = err && err.message ? err.message : String(err);
    return {
      statusCode: 500,
      headers: defaultHeaders,
      body: JSON.stringify({ error: 'Failed to search YouTube Music', details: message })
    };
  }
};

function inferTypeFromKey(k) {
  if (!k) return null;
  k = k.toLowerCase();
  if (k.includes('song') || k.includes('songs') || k.includes('video')) return 'song';
  if (k.includes('album')) return 'album';
  if (k.includes('artist')) return 'artist';
  if (k.includes('playlist')) return 'playlist';
  if (k.includes('video')) return 'video';
  return null;
}
