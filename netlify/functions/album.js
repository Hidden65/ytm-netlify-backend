// netlify/functions/album.js
const YouTubeMusicApi = require('youtube-music-api');

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

    const type = typeHint || raw.type || (raw.videoId ? 'song' : 'other');
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
    const embedUrl = videoId ? `https://www.youtube.com/embed/${videoId}` : null;

    return { type, id, title, artists, thumbnails, duration, raw, videoId, watchUrl, embedUrl };
  } catch (err) {
    return { type: typeHint || 'unknown', id: null, title: null, artists: [], thumbnails: [], duration: null, raw, videoId: null, watchUrl: null, embedUrl: null, warning: 'normalize failed' };
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
    const id = params.id || params.albumId || params.browseId;
    if (!id) return { statusCode: 400, headers: defaultHeaders, body: JSON.stringify({ error: 'Missing album id. Use ?id=<browseId>' }) };

    const api = new YouTubeMusicApi();
    if (typeof api.initalize === 'function') await api.initalize();
    else if (typeof api.initialize === 'function') await api.initialize();
    else if (typeof api.init === 'function') await api.init();

    // Try common method names: album, getAlbum, browse (with album id)
    let raw = null;
    if (typeof api.getAlbum === 'function') raw = await api.getAlbum(id);
    else if (typeof api.album === 'function') raw = await api.album(id);
    else if (typeof api.browse === 'function') raw = await api.browse(id);
    else raw = {};

    // raw might have tracks or songs property
    let tracks = [];
    if (raw && Array.isArray(raw.tracks)) tracks = raw.tracks.map(t => normalizeItem(t, 'song'));
    else if (raw && Array.isArray(raw.songs)) tracks = raw.songs.map(t => normalizeItem(t, 'song'));
    else if (raw && raw.content && Array.isArray(raw.content)) tracks = raw.content.map(t => normalizeItem(t, 'song'));
    else {
      // search for array values
      for (const v of Object.values(raw)) {
        if (Array.isArray(v)) {
          tracks = tracks.concat(v.map(t => normalizeItem(t, 'song')));
        }
      }
    }
    // album metadata
    const albumInfo = {
      id,
      title: raw.title || raw.name || raw.subtitle || null,
      artists: (raw.artists || raw.artist || []).map ? (raw.artists || raw.artist).map(a => (a.name || a)) : raw.artists || [],
      thumbnails: raw.thumbnails || raw.thumbnail || [],
      raw
    };

    return { statusCode: 200, headers: defaultHeaders, body: JSON.stringify({ album: albumInfo, tracks: tracks.slice(0, 500) }) };
  } catch (err) {
    console.error('album function error:', err);
    return { statusCode: 500, headers: defaultHeaders, body: JSON.stringify({ error: 'Failed to fetch album', details: err && err.message || String(err) }) };
  }
};
