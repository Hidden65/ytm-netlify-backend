// netlify/functions/extract.js
// Prereqs:
//   npm install newpipe-extractor-js
// Optional fallback:
//   npm install youtube-dl-exec

'use strict';

const DEFAULT_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json"
};

// ----------------- small helpers -----------------
function extractVideoIdFromString(s) {
  if (!s) return null;
  const str = String(s).trim();

  // If it's already ID-like
  if (/^[A-Za-z0-9_-]{8,}$/.test(str) && !str.includes('http')) {
    return str;
  }

  try {
    // Try to parse as URL
    const url = str;
    const m =
      url.match(/[?&]v=([^&]+)/) ||
      url.match(/youtu\.be\/([^?&/]+)/) ||
      url.match(/\/embed\/([^?&/]+)/) ||
      url.match(/\/watch\/([^?&/]+)/);
    if (m && m[1]) return m[1];
  } catch (e) {
    // ignore
  }
  return null;
}

function toFullYoutubeUrl(videoIdOrUrl) {
  const raw = String(videoIdOrUrl || '').trim();
  if (!raw) return null;

  // If already a full URL, just return it
  if (raw.startsWith('http://') || raw.startsWith('https://')) {
    return raw;
  }

  // Try to extract an id from it
  const vid = extractVideoIdFromString(raw) || raw;
  return `https://www.youtube.com/watch?v=${vid}`;
}

function normalizeFormat(f) {
  try {
    const url =
      f.url ||
      f.uri ||
      f.audioUrl ||
      f.baseUrl ||
      f.cdnUrl ||
      f.downloadUrl ||
      f.mediaUrl ||
      f.urlString ||
      f.direct_url ||
      null;

    const mimeType = f.mimeType || f.type || f.contentType || f.ext || null;
    const bitrate = f.bitrate || f.bps || f.tbr || null;
    const audioBitrate = f.audioBitrate || f.abr || null;
    const qualityLabel =
      f.qualityLabel ||
      f.quality ||
      f.label ||
      f.format ||
      f.format_note ||
      null;

    const isAudioOnly = !!(
      (mimeType && typeof mimeType === 'string' && mimeType.includes('audio')) ||
      (f.acodec && !f.vcodec) ||
      (f.vcodec === 'none') ||
      (f.type && String(f.type).toLowerCase().includes('audio'))
    );

    return { url, mimeType, bitrate, audioBitrate, qualityLabel, isAudioOnly, raw: f };
  } catch (e) {
    return {
      url: null,
      mimeType: null,
      bitrate: null,
      audioBitrate: null,
      qualityLabel: null,
      isAudioOnly: false,
      raw: f
    };
  }
}

function pickBestAudio(formats) {
  if (!Array.isArray(formats) || formats.length === 0) return null;

  const audio = formats.filter(f => f.isAudioOnly);
  const sorter = (a, b) => {
    const aa = Number(a.audioBitrate || a.bitrate || 0);
    const bb = Number(b.audioBitrate || b.bitrate || 0);
    return bb - aa;
  };

  if (audio.length > 0) {
    audio.sort(sorter);
    return audio[0];
  }

  const byBit = formats.slice().sort((a, b) => (Number(b.bitrate || 0) - Number(a.bitrate || 0)));
  return byBit[0] || null;
}

// ----------------- NewPipe extractor wrapper -----------------
async function tryNewPipe(videoIdOrUrl) {
  let np;
  try {
    // eslint-disable-next-line global-require
    np = require('newpipe-extractor-js');
  } catch (e) {
    throw new Error('newpipe-extractor-js not installed or failed to require: ' + (e && e.message ? e.message : String(e)));
  }

  console.log('newpipe-extractor-js keys:', Object.keys(np));

  // Initialize NewPipe (your debug showed initializeNewPipe() works)
  try {
    if (typeof np.initializeNewPipe === 'function') {
      await np.initializeNewPipe();
      console.log('Called initializeNewPipe() OK');
    } else if (typeof np.initializeNewPipeWithPoToken === 'function') {
      await np.initializeNewPipeWithPoToken();
      console.log('Called initializeNewPipeWithPoToken() OK');
    } else if (typeof np.initialize === 'function') {
      await np.initialize();
      console.log('Called initialize() OK');
    }
  } catch (e) {
    console.log('NewPipe initialization non-fatal error:', e && e.message ? e.message : e);
  }

  // Optional: set localization / country if available
  try {
    if (typeof np.setPreferredLocalization === 'function') {
      np.setPreferredLocalization('en');
      console.log('setPreferredLocalization(en)');
    }
    if (typeof np.setPreferredContentCountry === 'function') {
      np.setPreferredContentCountry('US');
      console.log('setPreferredContentCountry(US)');
    }
  } catch (e) {
    console.log('Localization settings failed (non-fatal):', e && e.message ? e.message : e);
  }

  // We ALWAYS use a full YouTube URL for NewPipe functions
  const fullUrl = toFullYoutubeUrl(videoIdOrUrl);
  if (!fullUrl) throw new Error('Could not build full YouTube URL from: ' + String(videoIdOrUrl));
  console.log('Using URL for NewPipe:', fullUrl);

  let rawFormats = [];
  const info = {};

  const push = (candidate, label) => {
    if (!candidate) return;
    if (Array.isArray(candidate)) {
      rawFormats = rawFormats.concat(candidate);
    } else if (candidate.formats && Array.isArray(candidate.formats)) {
      rawFormats = rawFormats.concat(candidate.formats);
    } else if (candidate.streams && Array.isArray(candidate.streams)) {
      rawFormats = rawFormats.concat(candidate.streams);
    } else if (typeof candidate === 'object') {
      rawFormats.push(candidate);
    }
    if (label) info[label] = candidate;
  };

  // We will try a few functions in order, passing the FULL URL (not just the ID)
  const tries = [
    'getBestAudioStream',
    'getBestDashAudioStream',
    'findBestAudioFormat',
    'extractStreamInfo',
    'getDashStreams',
    'getBestVideoStream',
    'getBestDashVideoStream'
  ];

  for (const name of tries) {
    const fn = np[name];
    if (typeof fn !== 'function') {
      console.log(`${name} not available`);
      continue;
    }

    try {
      console.log(`Calling ${name}(${fullUrl})`);
      const res = await fn(fullUrl);
      console.log(`${name} ->`, res === null ? 'null' : typeof res, Array.isArray(res) ? `len=${res.length}` : '');
      if (res) {
        push(res, name);
      }
    } catch (e) {
      console.log(`${name} call failed:`, e && e.message ? e.message : e);
    }

    // if we already collected some formats, we can stop early
    if (rawFormats.length > 0 && (name === 'getBestAudioStream' || name === 'extractStreamInfo' || name === 'findBestAudioFormat')) {
      break;
    }
  }

  if (!rawFormats || rawFormats.length === 0) {
    throw new Error('NewPipe extractor did not return formats. Available keys: ' + JSON.stringify(Object.keys(np || {})));
  }

  const normalized = rawFormats.map(normalizeFormat).filter(f => f.url);
  const seen = new Set();
  const dedup = [];
  for (const f of normalized) {
    if (!seen.has(f.url)) {
      seen.add(f.url);
      dedup.push(f);
    }
  }

  if (dedup.length === 0) {
    throw new Error('No usable URLs found in NewPipe extract output.');
  }

  return { info, formats: dedup };
}

// ----------------- youtube-dl-exec fallback (optional, may not work on Netlify) -----------------
async function tryYtdlExec(videoIdOrUrl) {
  const vid = extractVideoIdFromString(videoIdOrUrl) || String(videoIdOrUrl).trim();
  const url = `https://www.youtube.com/watch?v=${vid}`;

  try {
    // eslint-disable-next-line global-require
    const ytdlExec = require('youtube-dl-exec');
    console.log('Using youtube-dl-exec fallback for', url);

    let meta = null;
    try {
      meta = await ytdlExec(url, { dumpSingleJson: true });
    } catch (e1) {
      console.log('youtube-dl-exec dumpSingleJson failed, trying -j arg:', e1 && e1.message ? e1.message : e1);
      if (typeof ytdlExec === 'function') {
        try {
          meta = await ytdlExec(url, ['-j']);
        } catch (e2) {
          console.log('youtube-dl-exec -j failed:', e2 && e2.message ? e2.message : e2);
          meta = null;
        }
      }
    }

    if (!meta) {
      throw new Error('youtube-dl-exec did not return metadata');
    }

    const formats = (meta.formats || []).map(normalizeFormat).filter(f => f.url);
    return { info: meta, formats };
  } catch (e) {
    throw new Error('youtube-dl-exec fallback failed: ' + (e && e.message ? e.message : String(e)));
  }
}

// ----------------- Netlify handler -----------------
exports.handler = async function(event, context) {
  try {
    const params = event.queryStringParameters || {};
    const videoParam = (params.videoId || params.v || params.url || params.q || '').trim();

    if (!videoParam) {
      return {
        statusCode: 400,
        headers: DEFAULT_HEADERS,
        body: JSON.stringify({
          error: 'Missing videoId. Use ?videoId=Uyka5SnxmQ4 or ?url=https://www.youtube.com/watch?v=Uyka5SnxmQ4'
        })
      };
    }

    console.log('Extraction request for:', videoParam);

    // 1) Try NewPipe
    try {
      const npRes = await tryNewPipe(videoParam);
      const formats = npRes.formats || [];
      const best = pickBestAudio(formats);
      return {
        statusCode: 200,
        headers: DEFAULT_HEADERS,
        body: JSON.stringify({
          extractor: 'newpipe-extractor-js',
          input: videoParam,
          availableFormatsCount: formats.length,
          formats,
          best,
          infoSummary: Object.keys(npRes.info || {})
        })
      };
    } catch (npErr) {
      console.log('NewPipe extractor error:', npErr && npErr.message ? npErr.message : npErr);

      // 2) Fallback: youtube-dl-exec (if installed & allowed)
      try {
        const yRes = await tryYtdlExec(videoParam);
        const formats = yRes.formats || [];
        const best = pickBestAudio(formats);
        return {
          statusCode: 200,
          headers: DEFAULT_HEADERS,
          body: JSON.stringify({
            extractor: 'youtube-dl-exec-fallback',
            input: videoParam,
            availableFormatsCount: formats.length,
            formats,
            best
          })
        };
      } catch (yErr) {
        console.log('youtube-dl-exec fallback error:', yErr && yErr.message ? yErr.message : yErr);

        return {
          statusCode: 500,
          headers: DEFAULT_HEADERS,
          body: JSON.stringify({
            error: 'Extraction failed',
            details: npErr && npErr.message ? npErr.message : String(npErr),
            fallback: yErr && yErr.message ? yErr.message : String(yErr)
          })
        };
      }
    }

  } catch (err) {
    console.error('extract function error:', err && err.message ? err.message : err);
    return {
      statusCode: 500,
      headers: DEFAULT_HEADERS,
      body: JSON.stringify({ error: 'Internal server error', details: err && err.message ? err.message : String(err) })
    };
  }
};
