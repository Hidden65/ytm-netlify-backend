// netlify/functions/playlist.js
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
    const duration = raw.duration || raw.length || raw.duration_seconds || null;
    const videoId = raw.videoId || raw.id || null;
    const watchUrl = videoId ? `https://www.youtube.com/watch?v=${videoId}` : null;
    return { id, title, artists, thumbnails, duration, raw, videoId, watchUrl };
  } catch (err) {
    return { id: null, title: null, artists: [], thumbnails: [], duration: null, raw, videoId: null, watchUrl: null, warning: 'normalize failed' };
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
    const id = params.id || params.playlistId || params.browseId;
    if (!id) return { statusCode: 400, headers: defaultHeaders, body: JSON.stringify({ error: 'Missing playlist id. Use ?id=<browseId>' }) };

    const api = new YouTubeMusicApi();
    if (typeof api.initalize === 'function') await api.initalize();
    else if (typeof api.initialize === 'function') await api.initialize();
    else if (typeof api.init === 'function') await api.init();

    let raw = null;
    if (typeof api.getPlaylist === 'function') raw = await api.getPlaylist(id);
    else if (typeof api.playlist === 'function') raw = await api.playlist(id);
    else if (typeof api.browse === 'function') raw = await api.browse(id);
    else raw = {};

    let items = [];
    if (raw && Array.isArray(raw.tracks)) items = raw.tracks.map(normalizeItem);
    else if (raw && Array.isArray(raw.songs)) items = raw.songs.map(normalizeItem);
    else {
      // find arrays in object
      for (const v of Object.values(raw)) {
        if (Array.isArray(v)) items = items.concat(v.map(normalizeItem));
      }
    }

    const playlistInfo = {
      id,
      title: raw.title || raw.name || raw.subtitle || null,
      description: raw.description || null,
      thumbnails: raw.thumbnails || raw.thumbnail || [],
      raw
    };

    return { statusCode: 200, headers: defaultHeaders, body: JSON.stringify({ playlist: playlistInfo, items: items.slice(0, 1000) }) };
  } catch (err) {
    console.error('playlist function error:', err);
    return { statusCode: 500, headers: defaultHeaders, body: JSON.stringify({ error: 'Failed to fetch playlist', details: err && err.message || String(err) }) };
  }
};
