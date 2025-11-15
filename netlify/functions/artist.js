// netlify/functions/artist.js
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
    const videoId = raw.videoId || raw.id || (raw.url && (urlMatch(raw.url))) || null;
    const watchUrl = videoId ? `https://www.youtube.com/watch?v=${videoId}` : null;
    const embedUrl = videoId ? `https://www.youtube.com/embed/${videoId}` : null;
    return { type, id, title, artists, thumbnails, duration, raw, videoId, watchUrl, embedUrl };
  } catch (err) {
    return { type: typeHint || 'unknown', id: null, title: null, artists: [], thumbnails: [], duration: null, raw, videoId: null, watchUrl: null, embedUrl: null, warning: 'normalize failed' };
  }
}

function urlMatch(url) {
  if (!url) return null;
  const m = url.match(/[?&]v=([^&]+)/) || url.match(/\/watch\/([^?&/]+)/) || url.match(/\/embed\/([^?&/]+)/);
  return m ? m[1] : null;
}

exports.handler = async function (event, context) {
  const defaultHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json"
  };

  try {
    const params = event.queryStringParameters || {};
    const id = params.id || params.artistId || params.browseId;
    if (!id) return { statusCode: 400, headers: defaultHeaders, body: JSON.stringify({ error: 'Missing artist id. Use ?id=<browseId>' }) };

    const api = new YouTubeMusicApi();
    if (typeof api.initalize === 'function') await api.initalize();
    else if (typeof api.initialize === 'function') await api.initialize();
    else if (typeof api.init === 'function') await api.init();

    let raw = null;
    if (typeof api.getArtist === 'function') raw = await api.getArtist(id);
    else if (typeof api.artist === 'function') raw = await api.artist(id);
    else if (typeof api.browse === 'function') raw = await api.browse(id);
    else raw = {};

    // typical structure: raw.tracks, raw.songs, raw.albums, raw.playlists
    const songs = [];
    const albums = [];
    const playlists = [];

    for (const v of Object.values(raw)) {
      if (Array.isArray(v)) {
        // guess whether array contains songs or albums
        for (const it of v) {
          const t = (it && (it.type || it.videoId || it.browseId)) ? normalizeItem(it) : normalizeItem(it);
          // push to songs by heuristic
          if (t.type === 'song' || t.videoId) songs.push(t);
          else if (t.type === 'album' || it && it.subtitle && it.subtitle.toLowerCase && it.subtitle.toLowerCase().includes('album')) albums.push(t);
          else playlists.push(t);
        }
      }
    }

    const artistInfo = {
      id,
      name: raw.name || raw.title || raw.artist || null,
      thumbnails: raw.thumbnails || raw.thumbnail || [],
      raw
    };

    return { statusCode: 200, headers: defaultHeaders, body: JSON.stringify({ artist: artistInfo, songs: songs.slice(0, 200), albums: albums.slice(0, 200), playlists: playlists.slice(0,200) }) };
  } catch (err) {
    console.error('artist function error:', err);
    return { statusCode: 500, headers: defaultHeaders, body: JSON.stringify({ error: 'Failed to fetch artist', details: err && err.message || String(err) }) };
  }
};
