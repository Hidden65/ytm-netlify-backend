// netlify/functions/recommendations.js
const YouTubeMusicApi = require('youtube-music-api');

function normalizeItem(raw) {
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
    const title = raw.title || raw.name || raw.subtitle || '';
    const id = raw.videoId || raw.entityId || raw.browseId || raw.id || raw.video_id || '';
    const artistsRaw = raw.artists || raw.artist || raw.subtitles || [];
    const artistsArr = coerceToArray(artistsRaw);
    const artists = artistsArr.map(extractNameFromArtistEntry).filter(Boolean);
    let thumbnails = [];
    if (Array.isArray(raw.thumbnails)) thumbnails = raw.thumbnails;
    else if (raw.thumbnail) thumbnails = (Array.isArray(raw.thumbnail) ? raw.thumbnail : [raw.thumbnail]);
    else if (raw.thumbs) thumbnails = raw.thumbs;
    const videoId = raw.videoId || raw.id || null;
    const watchUrl = videoId ? `https://www.youtube.com/watch?v=${videoId}` : null;
    return { id, title, artists, thumbnails, raw, videoId, watchUrl };
  } catch (err) {
    return { id: null, title: null, artists: [], thumbnails: [], raw, videoId: null, watchUrl: null, warning: 'normalize failed' };
  }
}

exports.handler = async function (event, context) {
  const defaultHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json"
  };

  try {
    const params = event.queryStringParameters || {};
    // expecting videoId or id param to generate recommendations for a track
    const videoId = params.videoId || params.id || params.video;
    const limit = Math.min(50, parseInt(params.limit || '25', 10) || 25);

    if (!videoId) return { statusCode: 400, headers: defaultHeaders, body: JSON.stringify({ error: 'Missing videoId. Use ?videoId=<videoId>' }) };

    const api = new YouTubeMusicApi();
    if (typeof api.initalize === 'function') await api.initalize();
    else if (typeof api.initialize === 'function') await api.initialize();
    else if (typeof api.init === 'function') await api.init();

    let raw = null;
    if (typeof api.getRecommendations === 'function') raw = await api.getRecommendations(videoId);
    else if (typeof api.recommendations === 'function') raw = await api.recommendations(videoId);
    else if (typeof api.recommend === 'function') raw = await api.recommend(videoId);
    else if (typeof api.getRelated === 'function') raw = await api.getRelated(videoId);
    else raw = {};

    let items = [];
    if (Array.isArray(raw)) items = raw.map(normalizeItem);
    else if (raw && Array.isArray(raw.recommended)) items = raw.recommended.map(normalizeItem);
    else {
      for (const v of Object.values(raw)) {
        if (Array.isArray(v)) items = items.concat(v.map(normalizeItem));
      }
    }

    items = items.slice(0, limit);

    return { statusCode: 200, headers: defaultHeaders, body: JSON.stringify({ videoId, count: items.length, items }) };
  } catch (err) {
    console.error('recommendations function error:', err);
    return { statusCode: 500, headers: defaultHeaders, body: JSON.stringify({ error: 'Failed to fetch recommendations', details: err && err.message || String(err) }) };
  }
};
