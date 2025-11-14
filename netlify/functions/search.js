// netlify/functions/search.js
const YouTubeMusicApi = require('youtube-music-api');

const DEFAULT_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, OPTIONS"
};

function normalize(raw) {
  // raw may be the wrapper object containing results.content OR already a simple list
  const content = (raw && raw.results && Array.isArray(raw.results.content)) ? raw.results.content :
                  (raw && Array.isArray(raw.items)) ? raw.items :
                  (raw && Array.isArray(raw.content)) ? raw.content : [];

  return (content || []).map(it => ({
    id: it.videoId || (it.playlistId && it.playlistId[0]) || null,
    videoId: it.videoId || null,
    title: it.name || it.title || '',
    artist: (it.artist && it.artist.name) || (Array.isArray(it.artist) ? it.artist.map(a=>a.name).join(', ') : '') || '',
    album: (it.album && it.album.name) || '',
    durationMs: it.duration || 0,
    thumbnails: it.thumbnails || [],
    raw: it
  }));
}

exports.handler = async function (event) {
  // handle preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: DEFAULT_HEADERS, body: '' };
  }

  try {
    const params = event.queryStringParameters || {};
    const q = (params.q || '').trim();
    const type = params.type || 'song';
    const limit = Math.min(parseInt(params.limit || '12', 10) || 12, 50);

    if (!q) {
      return {
        statusCode: 400,
        headers: DEFAULT_HEADERS,
        body: JSON.stringify({ error: 'Missing query param q' })
      };
    }

    const api = new YouTubeMusicApi();
    await api.initalize();

    const raw = await api.search(q, type);

    const items = normalize(raw).slice(0, limit);

    return {
      statusCode: 200,
      headers: DEFAULT_HEADERS,
      body: JSON.stringify({
        query: q,
        type,
        items,
        continuation: raw && raw.continuation ? raw.continuation : null
      })
    };
  } catch (err) {
    console.error('search function error:', err && (err.stack || err));
    return {
      statusCode: 500,
      headers: DEFAULT_HEADERS,
      body: JSON.stringify({ error: 'Server error', details: err && (err.message || String(err)) })
    };
  }
};
