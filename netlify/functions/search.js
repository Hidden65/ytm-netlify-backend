// netlify/functions/search.js
// Prereqs (install in your project):
// npm install youtube-music-api
// Optional: npm install newpipe-extractor-js youtube-dl-exec

const YouTubeMusicApi = require('youtube-music-api');
const util = require('util');

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

// ------------------ NewPipe extraction helpers (works with newpipe-extractor-js API) ------------------

async function tryNewPipeExtract(videoIdOrUrl) {
  // try to require the module
  let np;
  try {
    // package name observed in your environment
    // eslint-disable-next-line global-require,import/no-dynamic-require
    np = require('newpipe-extractor-js');
  } catch (e) {
    // if not installed, throw helpful message
    throw new Error('Failed to require newpipe-extractor-js: ' + (e && e.message ? e.message : String(e)));
  }

  console.log('newpipe-extractor-js loaded — available keys:', Object.keys(np));

  // init if available
  try {
    if (typeof np.initializeNewPipe === 'function') {
      console.log('Calling initializeNewPipe()');
      await np.initializeNewPipe();
    } else if (typeof np.initializeNewPipeWithPoToken === 'function') {
      console.log('Calling initializeNewPipeWithPoToken()');
      // initializeNewPipeWithPoToken can accept args in some builds; call without args first
      await np.initializeNewPipeWithPoToken();
    } else if (typeof np.initialize === 'function') {
      console.log('Calling initialize()');
      await np.initialize();
    }
  } catch (e) {
    console.log('NewPipe initialize call failed/returned (non-fatal):', e && e.message ? e.message : e);
  }

  // determine videoId from input
  let videoId = videoIdOrUrl;
  if (typeof videoIdOrUrl === 'string' && videoIdOrUrl.includes('youtube')) {
    if (typeof np.extractVideoIdFromUrl === 'function') {
      try {
        const extracted = await np.extractVideoIdFromUrl(videoIdOrUrl);
        if (extracted) videoId = extracted;
      } catch (e) {
        console.log('extractVideoIdFromUrl failed:', e && e.message ? e.message : e);
      }
    } else {
      const m = String(videoIdOrUrl).match(/[?&]v=([^&]+)/) || String(videoIdOrUrl).match(/\/embed\/([^?&/]+)/) || String(videoIdOrUrl).match(/\/watch\/([^?&/]+)/);
      if (m) videoId = m[1];
    }
  }

  if (!videoId) throw new Error('Could not determine videoId from input: ' + String(videoIdOrUrl));

  // We'll try several extractor functions that exist in the module
  let rawInfo = null;
  let rawFormats = [];

  const pushFormatsFrom = (candidate) => {
    if (!candidate) return;
    if (Array.isArray(candidate)) {
      rawFormats = rawFormats.concat(candidate);
      return;
    }
    if (candidate.streams && Array.isArray(candidate.streams)) {
      rawFormats = rawFormats.concat(candidate.streams);
      return;
    }
    if (candidate.formats && Array.isArray(candidate.formats)) {
      rawFormats = rawFormats.concat(candidate.formats);
      return;
    }
    if (typeof candidate === 'object') {
      rawFormats.push(candidate);
      return;
    }
  };

  try {
    // 1) getBestAudioStream (preferred)
    if (typeof np.getBestAudioStream === 'function') {
      try {
        const best = await np.getBestAudioStream(videoId);
        if (best) {
          pushFormatsFrom(best);
          rawInfo = rawInfo || {};
          rawInfo.bestAudio = best;
        }
      } catch (e) {
        console.log('getBestAudioStream failed:', e && e.message ? e.message : e);
      }
    }

    // 2) extractStreamInfo
    if (rawFormats.length === 0 && typeof np.extractStreamInfo === 'function') {
      try {
        const info = await np.extractStreamInfo(videoId);
        rawInfo = rawInfo || info || {};
        pushFormatsFrom(info);
      } catch (e) {
        console.log('extractStreamInfo failed:', e && e.message ? e.message : e);
      }
    }

    // 3) getDashStreams
    if (rawFormats.length === 0 && typeof np.getDashStreams === 'function') {
      try {
        const dash = await np.getDashStreams(videoId);
        rawInfo = rawInfo || {};
        pushFormatsFrom(dash);
      } catch (e) {
        console.log('getDashStreams failed:', e && e.message ? e.message : e);
      }
    }

    // 4) getBestDashAudioStream
    if (rawFormats.length === 0 && typeof np.getBestDashAudioStream === 'function') {
      try {
        const bestDash = await np.getBestDashAudioStream(videoId);
        if (bestDash) {
          pushFormatsFrom(bestDash);
          rawInfo = rawInfo || {};
          rawInfo.bestDash = bestDash;
        }
      } catch (e) {
        console.log('getBestDashAudioStream failed:', e && e.message ? e.message : e);
      }
    }

    // 5) getBestVideoStream (if audio-only not found)
    if (rawFormats.length === 0 && typeof np.getBestVideoStream === 'function') {
      try {
        const bestVideo = await np.getBestVideoStream(videoId);
        if (bestVideo) {
          pushFormatsFrom(bestVideo);
          rawInfo = rawInfo || {};
          rawInfo.bestVideo = bestVideo;
        }
      } catch (e) {
        console.log('getBestVideoStream failed:', e && e.message ? e.message : e);
      }
    }

    // 6) findBestAudioFormat
    if (rawFormats.length === 0 && typeof np.findBestAudioFormat === 'function') {
      try {
        const best = await np.findBestAudioFormat(videoId);
        if (best) {
          pushFormatsFrom(best);
          rawInfo = rawInfo || {};
          rawInfo.findBest = best;
        }
      } catch (e) {
        console.log('findBestAudioFormat failed:', e && e.message ? e.message : e);
      }
    }
  } catch (err) {
    console.log('Unexpected error while calling newpipe APIs:', err && err.message ? err.message : err);
  }

  // Fallback: try youtube-dl-exec if available (optional)
  if ((!rawFormats || rawFormats.length === 0)) {
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

  if (!rawFormats || rawFormats.length === 0) {
    const keys = Object.keys(np || {});
    throw new Error('NewPipe extractor did not return formats. Available keys: ' + JSON.stringify(keys));
  }

  // Normalize rawFormats to expected output
  const normalized = rawFormats.map((f) => {
    try {
      const url = f.url || f.uri || f.audioUrl || f.baseUrl || f.cdnUrl || f.downloadUrl || f.mediaUrl || f.urlString || null;
      const mimeType = f.mimeType || f.type || f.contentType || f.ext || null;
      const bitrate = f.bitrate || f.bps || f.tbr || null;
      const audioBitrate = f.audioBitrate || f.abr || null;
      const qualityLabel = f.qualityLabel || f.quality || f.label || f.format || f.format_note || null;
      const isAudioOnly =
        !!(
          (mimeType && typeof mimeType === 'string' && mimeType.includes('audio')) ||
          (f.acodec && !f.vcodec) ||
          (f.vcodec === 'none') ||
          (f.type && String(f.type).toLowerCase().includes('audio'))
        );
      return { url, mimeType, bitrate, audioBitrate, qualityLabel, isAudioOnly, raw: f };
    } catch (e) {
      return { url: null, mimeType: null, bitrate: null, audioBitrate: null, qualityLabel: null, isAudioOnly: false, raw: f };
    }
  }).filter(x => x.url);

  if (normalized.length === 0) {
    throw new Error('No usable URLs found in NewPipe extract output.');
  }

  // de-duplicate identical URLs
  const seen = new Set();
  const dedup = [];
  for (const f of normalized) {
    if (!seen.has(f.url)) {
      seen.add(f.url);
      dedup.push(f);
    }
  }

  return { info: rawInfo || null, formats: dedup };
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
        console.error('Extraction failed:', err && err.message ? err.message : String(err));
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
