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

// ------------------ NewPipe extraction helpers ------------------

// Try to call common export names on community NewPipe JS ports.
// This is defensive: packages differ; we attempt a few names.
async function tryNewPipeExtract(videoId) {
  let NewPipe;
  try {
    NewPipe = require('newpipe-extractor-js');
  } catch (e) {
    // not installed or cannot load
    throw new Error('newpipe-extractor-js not installed or failed to load');
  }

  // possible function names that ports expose
  const tryFns = [
    'getInfo',
    'getVideoInfo',
    'getStreams',
    'extract',
    'fetchInfo',
    'getStreamInfo',
    'getVideo'
  ];

  let info = null;
  for (const fn of tryFns) {
    if (NewPipe && typeof NewPipe[fn] === 'function') {
      try {
        // many ports accept video id or full youtube url
        info = await NewPipe[fn](videoId);
        if (info) break;
      } catch (err) {
        // try next
        continue;
      }
    }
  }

  // Some packages export a default function directly
  if (!info && typeof NewPipe === 'function') {
    try {
      info = await NewPipe(videoId);
    } catch (e) {
      // ignore
    }
  }

  if (!info) {
    // last attempt: some ports have 'default' export with functions
    const np = NewPipe && NewPipe.default ? NewPipe.default : null;
    if (np) {
      for (const fn of tryFns) {
        if (np && typeof np[fn] === 'function') {
          try {
            info = await np[fn](videoId);
            if (info) break;
          } catch (err) {
            continue;
          }
        }
      }
      if (!info && typeof np === 'function') {
        try { info = await np(videoId); } catch (_) {}
      }
    }
  }

  if (!info) throw new Error('NewPipe extractor did not return info (incompatible API)');

  // Normalize expected shapes:
  // - info.streams / info.formats / info.media / info.availableFormats etc.
  let formats = [];
  if (Array.isArray(info.streams)) formats = info.streams;
  else if (Array.isArray(info.formats)) formats = info.formats;
  else if (info && Array.isArray(info.availableFormats)) formats = info.availableFormats;
  else if (info && Array.isArray(info.media)) formats = info.media;
  else if (info && info.streams && typeof info.streams === 'object') {
    formats = Object.values(info.streams).flatMap(v => Array.isArray(v) ? v : [v]);
  } else {
    // try to find arrays inside info
    for (const v of Object.values(info)) {
      if (Array.isArray(v)) {
        formats = formats.concat(v);
      }
    }
  }

  // normalize each format into { url, mimeType, bitrate, qualityLabel, audioBitrate, isAudioOnly }
  const normalizedFormats = formats.map((f) => {
    try {
      const url = f.url || f.uri || f.downloadUrl || f.directUrl || f.cdnUrl || null;
      const mimeType = f.mimeType || f.type || f.contentType || null;
      const bitrate = f.bitrate || f.bps || f.audioBitrate || f.avgBitrate || null;
      const audioBitrate = f.audioBitrate || f.abitrate || (f.bitrate && Number(f.bitrate)) || null;
      const qualityLabel = f.qualityLabel || f.quality || f.label || null;
      const isAudioOnly = !!(mimeType && (mimeType.includes('audio') || (f.acodec && !f.vcodec) || (f.audioOnly === true)));
      return { url, mimeType, bitrate, audioBitrate, qualityLabel, isAudioOnly, raw: f };
    } catch (err) {
      return { url: null, mimeType: null, bitrate: null, audioBitrate: null, qualityLabel: null, isAudioOnly: false, raw: f };
    }
  }).filter(f => f.url);

  return { info, formats: normalizedFormats };
}

function pickBestAudio(formats) {
  if (!Array.isArray(formats) || formats.length === 0) return null;
  // Prefer audio-only formats with highest audioBitrate then highest bitrate
  const audioOnly = formats.filter(f => f.isAudioOnly);
  const sortByAudioQuality = (a, b) => {
    const ab = Number(a.audioBitrate || a.bitrate || 0);
    const bb = Number(b.audioBitrate || b.bitrate || 0);
    return bb - ab;
  };
  if (audioOnly.length > 0) {
    audioOnly.sort(sortByAudioQuality);
    return audioOnly[0];
  }
  // fallback: prefer any format with higher bitrate
  const byBitrate = formats.slice().sort((a, b) => (Number(b.bitrate || 0) - Number(a.bitrate || 0)));
  return byBitrate[0];
}

// ------------------ Netlify handler ------------------
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

    // If this is an extraction request, handle separately
    const extract = (params.extract === 'true' || params.action === 'extract' || params.extract === '1');
    const videoIdParam = (params.videoId || params.id || params.video || params.v || '').trim();

    if (extract) {
      if (!videoIdParam) {
        return { statusCode: 400, headers: defaultHeaders, body: JSON.stringify({ error: 'Missing videoId for extraction. Use ?extract=true&videoId=<id>' }) };
      }
      // attempt extraction via newpipe-extractor-js
      try {
        const prefer = (params.extract_prefer || 'audio').toLowerCase();
        const exLimit = Math.min(50, parseInt(params.extract_limit || '10', 10) || 10);
        const npResult = await tryNewPipeExtract(videoIdParam);
        const formats = npResult.formats || [];
        const best = prefer === 'video' ? (formats[0] || null) : pickBestAudio(formats);
        const reply = {
          extractor: 'newpipe-extractor-js',
          videoId: videoIdParam,
          info: npResult.info || null,
          availableFormatsCount: formats.length,
          formats: formats.slice(0, exLimit),
          best
        };
        return { statusCode: 200, headers: defaultHeaders, body: JSON.stringify(reply) };
      } catch (err) {
        console.error('NewPipe extraction failed:', err && err.message ? err.message : String(err));
        return { statusCode: 500, headers: defaultHeaders, body: JSON.stringify({ error: 'Extraction failed', details: err && err.message ? err.message : String(err) }) };
      }
    }

    // Otherwise, regular search flow (unchanged)
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
