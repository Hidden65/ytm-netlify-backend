// netlify/functions/search.js
// Prereq: npm install youtube-music-api
// Optional: npm install newpipe-extractor-js youtube-dl-exec

const YouTubeMusicApi = require('youtube-music-api');

// ------------------ Helpers (normalize, detect, extract video id) ------------------
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
    if ((raw.subtitle || '').toLowerCase().includes('songs') || (raw.subtitle || '').toLowerCase().includes('tracks')) {
      return 'album';
    }
  }
  return 'other';
}

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

// ------------------ NewPipe extraction helpers (robust) ------------------
const util = require('util');

async function tryNewPipeExtract(videoId) {
  function inspectModule(m) {
    try {
      if (!m) return { type: 'undefined' };
      const keys = Object.keys(m);
      const hasDefault = !!m.default;
      const typeofDefault = m.default ? typeof m.default : null;
      return { type: typeof m, keys, hasDefault, typeofDefault };
    } catch (e) {
      return { error: String(e) };
    }
  }

  const packageNames = [
    'newpipe-extractor-js',
    'newpipe-extractor',
    'newpipe-extractor-core',
    '@newpipe/extractor',
    'newpipe-extractor-native'
  ];

  let lastRequireError = null;
  let loaded = null;
  let whichPackage = null;

  for (const pkg of packageNames) {
    try {
      // eslint-disable-next-line global-require,import/no-dynamic-require
      const mod = require(pkg);
      loaded = mod;
      whichPackage = pkg;
      break;
    } catch (err) {
      lastRequireError = err;
    }
  }

  if (!loaded) {
    try {
      // eslint-disable-next-line global-require
      loaded = require('newpipe-extractor-js');
      whichPackage = 'newpipe-extractor-js';
    } catch (err) {
      throw new Error('No NewPipe extractor package found. Require attempts failed. Last require error: ' + (lastRequireError && lastRequireError.message ? lastRequireError.message : String(lastRequireError)));
    }
  }

  try {
    const inspectInfo = inspectModule(loaded);
    console.log('Loaded NewPipe module:', whichPackage, inspectInfo);
  } catch (e) {
    console.log('Loaded NewPipe module but inspect failed:', e && e.message ? e.message : e);
  }

  const callAttempts = [
    async (mod) => mod.getInfo && await mod.getInfo(videoId),
    async (mod) => mod.getVideoInfo && await mod.getVideoInfo(videoId),
    async (mod) => mod.getStreams && await mod.getStreams(videoId),
    async (mod) => mod.getStreamInfo && await mod.getStreamInfo(videoId),
    async (mod) => mod.extract && await mod.extract(videoId),
    async (mod) => mod.fetchInfo && await mod.fetchInfo(videoId),
    async (mod) => (typeof mod === 'function' ? await mod(videoId) : null),
    async (mod) => (mod.default && typeof mod.default === 'function' ? await mod.default(videoId) : null),
    async (mod) => (mod.video && typeof mod.video.getInfo === 'function' ? await mod.video.getInfo(videoId) : null),
    async (mod) => (mod.videoInfo && typeof mod.videoInfo.get === 'function' ? await mod.videoInfo.get(videoId) : null)
  ];

  let info = null;
  for (const attempt of callAttempts) {
    try {
      info = await attempt(loaded);
      if (info) break;
    } catch (err) {
      console.log('NewPipe call attempt failed (continuing):', err && err.message ? err.message : String(err));
      continue;
    }
  }

  if (!info && loaded && loaded.default) {
    for (const attempt of callAttempts) {
      try {
        info = await attempt(loaded.default);
        if (info) break;
      } catch (err) {
        console.log('NewPipe.default call attempt failed:', err && err.message ? err.message : String(err));
        continue;
      }
    }
  }

  // Fallback to youtube-dl-exec if available
  if (!info) {
    try {
      // eslint-disable-next-line global-require
      const ytdlExec = require('youtube-dl-exec');
      console.log('Falling back to youtube-dl-exec for metadata extraction');

      let meta = null;
      try {
        meta = await ytdlExec(`https://www.youtube.com/watch?v=${videoId}`, { dumpSingleJson: true, noCheckCertificates: true });
      } catch (errA) {
        try {
          if (typeof ytdlExec === 'function') {
            meta = await ytdlExec(`https://www.youtube.com/watch?v=${videoId}`, ['-j']);
          }
        } catch (errB) {
          console.log('youtube-dl-exec invocation failed:', errA && errA.message ? errA.message : errA, errB && errB.message ? errB.message : errB);
          meta = null;
        }
      }

      if (meta) {
        const formats = Array.isArray(meta.formats) ? meta.formats : [];
        const normalized = formats.map(f => {
          return {
            url: f.url || f.direct_url || (f.protocol && f.protocol + '://' + f.url),
            mimeType: f.ext || f.format || null,
            bitrate: f.bitrate || f.tbr || null,
            audioBitrate: f.abr || null,
            qualityLabel: f.format_note || f.format || null,
            isAudioOnly: !!(f.vcodec === 'none' || (f.acodec && !f.vcodec))
          };
        }).filter(Boolean);
        return { info: meta, formats: normalized };
      }
    } catch (e) {
      console.log('youtube-dl-exec fallback not available or failed:', e && e.message ? e.message : e);
    }
  }

  if (!info) {
    const modInfo = inspectModule(loaded);
    const diag = `NewPipe extractor did not return info (incompatible API). Module: ${whichPackage}. Module keys: ${JSON.stringify(modInfo.keys || [])}`;
    if (lastRequireError && lastRequireError.message) {
      console.log('Last require error:', lastRequireError.message);
    }
    throw new Error(diag);
  }

  let formats = [];
  if (Array.isArray(info.formats)) formats = info.formats;
  else if (Array.isArray(info.streams)) formats = info.streams;
  else {
    for (const v of Object.values(info)) {
      if (Array.isArray(v) && v.length > 0 && typeof v[0] === 'object') {
        formats = v;
        break;
      }
    }
  }

  const normalizedFormats = (formats || []).map((f) => {
    try {
      const url = f.url || f.uri || f.downloadUrl || f.direct_url || f.directUrl || f.cdnUrl || null;
      const mimeType = f.mimeType || f.type || f.contentType || f.ext || null;
      const bitrate = f.bitrate || f.bps || f.tbr || null;
      const audioBitrate = f.audioBitrate || f.abr || null;
      const qualityLabel = f.qualityLabel || f.quality || f.label || f.format_note || null;
      const isAudioOnly = !!((mimeType && mimeType.includes && mimeType.includes('audio')) || (f.acodec && !f.vcodec) || (f.vcodec === 'none'));
      return { url, mimeType, bitrate, audioBitrate, qualityLabel, isAudioOnly, raw: f };
    } catch (err) {
      return { url: null, mimeType: null, bitrate: null, audioBitrate: null, qualityLabel: null, isAudioOnly: false, raw: f };
    }
  }).filter(f => f.url);

  return { info, formats: normalizedFormats };
}

// ------------------ Utility for selecting best audio ------------------
function pickBestAudio(formats) {
  if (!Array.isArray(formats) || formats.length === 0) return null;
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
    const type = (params.type || '').trim().toLowerCase();
    const limit = Math.min(50, parseInt(params.limit || '25', 10) || 25);

    const extract = (params.extract === 'true' || params.action === 'extract' || params.extract === '1');
    const videoIdParam = (params.videoId || params.id || params.video || params.v || '').trim();

    if (extract) {
      if (!videoIdParam) {
        return { statusCode: 400, headers: defaultHeaders, body: JSON.stringify({ error: 'Missing videoId for extraction. Use ?extract=true&videoId=<id>' }) };
      }
      try {
        const prefer = (params.extract_prefer || 'audio').toLowerCase();
        const exLimit = Math.min(50, parseInt(params.extract_limit || '10', 10) || 10);
        const npResult = await tryNewPipeExtract(videoIdParam);
        const formats = npResult.formats || [];
        const best = prefer === 'video' ? (formats[0] || null) : pickBestAudio(formats);
        const reply = { extractor: 'newpipe-extractor-js-or-fallback', videoId: videoIdParam, info: npResult.info || null, availableFormatsCount: formats.length, formats: formats.slice(0, exLimit), best };
        return { statusCode: 200, headers: defaultHeaders, body: JSON.stringify(reply) };
      } catch (err) {
        console.error('NewPipe extraction failed:', err && err.message ? err.message : String(err));
        return { statusCode: 500, headers: defaultHeaders, body: JSON.stringify({ error: 'Extraction failed', details: err && err.message ? err.message : String(err) }) };
      }
    }

    if (!q) {
      return { statusCode: 400, headers: defaultHeaders, body: JSON.stringify({ error: 'Missing query param "q". Example: ?q=never%20gonna%20give%20you%20up' }) };
    }

    const api = new YouTubeMusicApi();
    if (typeof api.initalize === 'function') await api.initalize();
    else if (typeof api.initialize === 'function') await api.initialize();
    else if (typeof api.init === 'function') await api.init();

    let rawResults;
    if (type && ['song', 'video', 'album', 'artist', 'playlist'].includes(type)) rawResults = await api.search(q, type);
    else rawResults = await api.search(q);

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

    return { statusCode: 200, headers: defaultHeaders, body: JSON.stringify({ query: q, type: type || 'all', count: items.length, items }) };

  } catch (err) {
    console.error('Netlify function search error:', err);
    const message = err && err.message ? err.message : String(err);
    return { statusCode: 500, headers: defaultHeaders, body: JSON.stringify({ error: 'Failed to search YouTube Music', details: message }) };
  }
};
