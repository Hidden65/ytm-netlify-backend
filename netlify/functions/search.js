// netlify/functions/search.js
const YouTubeMusicApi = require('youtube-music-api');

// Helper: normalize various item shapes returned by youtube-music-api
function normalizeItem(raw, typeHint) {
  // The third-party lib can return different fields depending on type.
  // We'll extract common fields safely.
  const type = typeHint || raw.type || detectType(raw);
  const title = raw.title || raw.name || raw.subtitle || '';
  const id = raw.videoId || raw.entityId || raw.browseId || raw.id || raw.video_id || '';
  const artists = (raw.artists || raw.artist || raw.subtitles || [])
    .map(a => (a && (a.name || a.title)) || (typeof a === 'string' ? a : null))
    .filter(Boolean);
  const thumbnails = raw.thumbnails || raw.thumbnail || raw.thumbs || [];
  const duration = raw.duration || raw.length || null;

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
}

function extractVideoId(url) {
  if (!url) return null;
  // crude extractor for common watch URLs
  const m = url.match(/[?&]v=([^&]+)/) || url.match(/\/watch\/([^?&/]+)/) || url.match(/\/embed\/([^?&/]+)/);
  return m ? m[1] : null;
}

function detectType(raw) {
  if (!raw) return 'unknown';
  if (raw.type) return raw.type;
  if (raw.videoId) return 'song';
  if (raw.browseId && raw.title && raw.subtitle && raw.thumbnail) {
    // heuristics
    if ((raw.subtitle || '').toLowerCase().includes('songs') || (raw.subtitle || '').toLowerCase().includes('tracks')) {
      return 'album';
    }
  }
  return 'other';
}

exports.handler = async function (event, context) {
  // Basic CORS + allow from your frontend (adjust origin in production)
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
    // NOTE: this lib's init fn is often misspelled as "initalize" in published versions
    // the older package requires "await api.initalize();" (spelled that way). If your installed package exposes "initialize", try that.
    if (typeof api.initalize === 'function') {
      await api.initalize();
    } else if (typeof api.initialize === 'function') {
      await api.initialize();
    } else if (typeof api.init === 'function') {
      await api.init();
    }

    // If a specific type is asked, attempt one search. Otherwise do a general search.
    // youtube-music-api supports a 'section' argument (some versions) or type hint; we use the common `search(query, type)` API.
    let rawResults;
    if (type && ['song', 'video', 'album', 'artist', 'playlist'].includes(type)) {
      rawResults = await api.search(q, type);
    } else {
      rawResults = await api.search(q); // full search (returns grouped results)
    }

    // rawResults may be an object with sections or arrays depending on library version.
    // Normalize into a flat `items` array with `{ type, id, title, artists, thumbnails, videoId, watchUrl, embedUrl }`.
    let items = [];

    // Common shapes:
    // 1) { resultCount: 10, content: [...] } or { result: [...] }
    // 2) { songs: {...}, albums: {...}, videos: {...} }
    // 3) direct array returned
    if (Array.isArray(rawResults)) {
      items = rawResults.map(r => normalizeItem(r));
    } else if (rawResults && typeof rawResults === 'object') {
      // try known keys
      const possibleKeys = ['songs', 'albums', 'videos', 'artists', 'playlists', 'result', 'content', 'resultArray', 'results'];
      let found = false;
      for (const k of possibleKeys) {
        if (rawResults[k]) {
          found = true;
          const block = rawResults[k];
          // block might be an object with 'results' or 'contents' array
          if (Array.isArray(block)) {
            items = items.concat(block.map(r => normalizeItem(r, inferTypeFromKey(k))));
          } else if (block && Array.isArray(block.results || block.contents || block.items)) {
            const arr = block.results || block.contents || block.items;
            items = items.concat(arr.map(r => normalizeItem(r, inferTypeFromKey(k))));
          } else if (block && typeof block === 'object') {
            // maybe { results: [...] }
            const arr = block.results || block.contents || block.items || [];
            items = items.concat((Array.isArray(arr) ? arr : []).map(r => normalizeItem(r, inferTypeFromKey(k))));
          }
        }
      }
      if (!found) {
        // fallback: flatten any top-level arrays or object values
        for (const v of Object.values(rawResults)) {
          if (Array.isArray(v)) {
            items = items.concat(v.map(r => normalizeItem(r)));
          }
        }
      }
    }

    // optional: trim to limit
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
      headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" },
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
