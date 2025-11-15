// netlify/functions/lyrics.js
const YouTubeMusicApi = require('youtube-music-api');

exports.handler = async function (event, context) {
  const defaultHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json"
  };

  try {
    const params = event.queryStringParameters || {};
    // accept videoId or id or q+artist/title
    const videoId = params.videoId || params.id;
    const q = params.q || params.query || '';
    const artist = params.artist || '';
    const title = params.title || '';

    if (!videoId && !q) {
      return { statusCode: 400, headers: defaultHeaders, body: JSON.stringify({ error: 'Provide either videoId (?videoId=...) or search query (?q=...) to fetch lyrics.' }) };
    }

    const api = new YouTubeMusicApi();
    if (typeof api.initalize === 'function') await api.initalize();
    else if (typeof api.initialize === 'function') await api.initialize();
    else if (typeof api.init === 'function') await api.init();

    // Try methods: getLyrics, lyrics, fetchLyrics
    let raw = null;
    if (videoId) {
      if (typeof api.getLyrics === 'function') raw = await api.getLyrics(videoId);
      else if (typeof api.lyrics === 'function') raw = await api.lyrics(videoId);
      else if (typeof api.fetchLyrics === 'function') raw = await api.fetchLyrics(videoId);
      else raw = {};
    } else {
      // fallback: search for the song then try to extract lyrics from result if provided
      if (typeof api.search === 'function') raw = await api.search(q);
      else raw = {};
    }

    // Normalize possible lyric structures
    let lyrics = null;
    if (raw && raw.lyrics) lyrics = raw.lyrics;
    else if (raw && raw.content && typeof raw.content === 'string') lyrics = raw.content;
    else if (typeof raw === 'string') lyrics = raw;
    else {
      // try to find a string field
      for (const v of Object.values(raw || {})) {
        if (typeof v === 'string' && v.length > 20) { lyrics = v; break; }
      }
    }

    return { statusCode: 200, headers: defaultHeaders, body: JSON.stringify({ videoId: videoId || null, query: q || null, lyrics: lyrics || null, raw }) };
  } catch (err) {
    console.error('lyrics function error:', err);
    return { statusCode: 500, headers: defaultHeaders, body: JSON.stringify({ error: 'Failed to fetch lyrics', details: err && err.message || String(err) }) };
  }
};
