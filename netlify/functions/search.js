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
// Replace your existing tryNewPipeExtract with this improved version
const util = require('util');
const child_process = require('child_process');

async function tryNewPipeExtract(videoId) {
  // helper that inspects a module and returns keys and basic info
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

  // Try list of probable package names
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
      // continue
    }
  }

  // If still not loaded, try default require (in case user installed under different name)
  if (!loaded) {
    try {
      // try requiring the installed module by using the main name if present
      // This will normally fail but gives a clearer error we can return
      // eslint-disable-next-line global-require
      loaded = require('newpipe-extractor-js');
      whichPackage = 'newpipe-extractor-js';
    } catch (err) {
      // failed to require any expected package
      // Return an error object that the caller can convert to a 500 with details
      throw new Error('No NewPipe extractor package found. Require attempts failed. Last require error: ' + (lastRequireError && lastRequireError.message ? lastRequireError.message : String(lastRequireError)));
    }
  }

  // Log inspection to function logs for debugging (helps determine API)
  try {
    const inspectInfo = inspectModule(loaded);
    console.log('Loaded NewPipe module:', whichPackage, inspectInfo);
  } catch (e) {
    console.log('Loaded NewPipe module but inspect failed:', e && e.message ? e.message : e);
  }

  // Try a set of known function names and call patterns
  const callAttempts = [
    // direct named functions
    async (mod) => mod.getInfo && await mod.getInfo(videoId),
    async (mod) => mod.getVideoInfo && await mod.getVideoInfo(videoId),
    async (mod) => mod.getStreams && await mod.getStreams(videoId),
    async (mod) => mod.getStreamInfo && await mod.getStreamInfo(videoId),
    async (mod) => mod.extract && await mod.extract(videoId),
    async (mod) => mod.fetchInfo && await mod.fetchInfo(videoId),
    // default export as function
    async (mod) => (typeof mod === 'function' ? await mod(videoId) : null),
    async (mod) => (mod.default && typeof mod.default === 'function' ? await mod.default(videoId) : null),
    // some libs expose a 'video' or 'videoInfo' namespace
    async (mod) => (mod.video && typeof mod.video.getInfo === 'function' ? await mod.video.getInfo(videoId) : null),
    async (mod) => (mod.videoInfo && typeof mod.videoInfo.get === 'function' ? await mod.videoInfo.get(videoId) : null)
  ];

  let info = null;
  // attempt calls against loaded module and also its .default (if present)
  for (const attempt of callAttempts) {
    try {
      info = await attempt(loaded);
      if (info) break;
    } catch (err) {
      // swallow and continue trying others
      console.log('NewPipe call attempt failed (continuing):', err && err.message ? err.message : String(err));
      continue;
    }
  }

  // try against default export if not tried above
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

  // If NewPipe-style module returned nothing useful, fallback to youtube-dl-exec (yt-dlp wrapper)
  if (!info) {
    // attempt youtube-dl-exec (which can use yt-dlp binary) as a fallback
    try {
      // dynamic require to avoid hard dependency if not desired
      // eslint-disable-next-line global-require
      const ytdlExec = require('youtube-dl-exec'); // or 'youtube-dl-exec'
      console.log('Falling back to youtube-dl-exec for metadata extraction');

      // call with json metadata only, no download
      const execOpts = {
        dumpSingleJson: true,
        noWarnings: true,
        preferFreeFormats: true,
        // additional args can be added as needed
      };

      // youtube-dl-exec returns a promise that resolves with json if used as function
      // some wrappers expect CLI args array; try common patterns
      let meta = null;
      try {
        // pattern: ytdlExec(url, options)
        meta = await ytdlExec(`https://www.youtube.com/watch?v=${videoId}`, { dumpSingleJson: true, noCheckCertificates: true });
      } catch (errA) {
        try {
          // pattern: ytdlExec.exec([...])
          if (typeof ytdlExec === 'function') {
            meta = await ytdlExec(`https://www.youtube.com/watch?v=${videoId}`, ['-j']);
          }
        } catch (errB) {
          console.log('youtube-dl-exec invocation failed:', errA && errA.message ? errA.message : errA, errB && errB.message ? errB.message : errB);
          meta = null;
        }
      }

      if (meta) {
        // normalize meta into {streams/formats: [...] } shape similar to NewPipe expectation
        const formats = Array.isArray(meta.formats) ? meta.formats : [];
        const normalized = formats.map(f => {
          return {
            url: f.url || f.direct_url || f.protocol && f.protocol + '://' + f.url,
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
    // If we reached here, we couldn't obtain metadata. Provide helpful diagnostic info:
    // Inspect the loaded module keys again and include a short message.
    const modInfo = inspectModule(loaded);
    const diag = `NewPipe extractor did not return info (incompatible API). Module: ${whichPackage}. Module keys: ${JSON.stringify(modInfo.keys || [])}`;
    // attach lastRequireError message if we have it
    if (lastRequireError && lastRequireError.message) {
      console.log('Last require error:', lastRequireError.message);
    }
    throw new Error(diag);
  }

  // If we have 'info' but not 'formats', attempt to find arrays within 'info'
  let formats = [];
  if (Array.isArray(info.formats)) formats = info.formats;
  else if (Array.isArray(info.streams)) formats = info.streams;
  else {
    // find first array-like property that looks like formats
    for (const v of Object.values(info)) {
      if (Array.isArray(v) && v.length > 0 && typeof v[0] === 'object') {
        formats = v;
        break;
      }
    }
  }

  // normalize formats array to expected output (same logic as before)
  const normalizedFormats = (formats || []).map((f) => {
    try {
      const url = f.url || f.uri || f.downloadUrl || f.direct_url || f.directUrl || f.cdnUrl || null;
      const mimeType = f.mimeType || f.type || f.contentType || f.ext || null;
      const bitrate = f.bitrate || f.bps || f.tbr || null;
      const audioBitrate = f.audioBitrate || f.abr || null;
      const qualityLabel = f.qualityLabel || f.quality || f.label || f.format_note || null;
      const isAudioOnly = !!(mimeType && (mimeType.includes && mimeType.includes('audio')) || (f.acodec && !f.vcodec) || (f.vcodec === 'none'));
      return { url, mimeType, bitrate, audioBitrate, qualityLabel, isAudioOnly, raw: f };
    } catch (err) {
      return { url: null, mimeType: null, bitrate: null, audioBitrate: null, qualityLabel: null, isAudioOnly: false, raw: f };
    }
  }).filter(f => f.url);

  return { info, formats: normalizedFormats };
}
