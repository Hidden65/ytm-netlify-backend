// netlify/functions/extract.js
// Install prerequisites in your project root:
// npm install newpipe-extractor-js
// Optional fallback: npm install youtube-dl-exec

'use strict';

const DEFAULT_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json"
};

function extractVideoIdFromString(s) {
  if (!s) return null;
  try {
    const url = String(s);
    if (url.includes('youtube') || url.includes('youtu.be')) {
      const m = url.match(/[?&]v=([^&]+)/) || url.match(/youtu\.be\/([^?&/]+)/) || url.match(/\/embed\/([^?&/]+)/) || url.match(/\/watch\/([^?&/]+)/);
      return m ? m[1] : null;
    }
    // if it's already an id-like string (11-12 chars) return it
    if (/^[A-Za-z0-9_-]{8,}$/.test(url)) return url;
    return null;
  } catch (e) {
    return null;
  }
}

function normalizeFormat(f) {
  try {
    const url = f.url || f.uri || f.audioUrl || f.baseUrl || f.cdnUrl || f.downloadUrl || f.mediaUrl || f.urlString || f.direct_url || null;
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
  // fallback: highest bitrate
  const byBit = formats.slice().sort((a, b) => (Number(b.bitrate || 0) - Number(a.bitrate || 0)));
  return byBit[0] || null;
}

async function tryNewPipe(videoIdOrUrl) {
  let np;
  try {
    // package used in your environment
    // eslint-disable-next-line global-require,import/no-dynamic-require
    np = require('newpipe-extractor-js');
  } catch (e) {
    throw new Error('newpipe-extractor-js not installed or failed to require: ' + (e && e.message ? e.message : String(e)));
  }

  console.log('newpipe-extractor-js keys:', Object.keys(np));

  // try initialize if available
  try {
    if (typeof np.initializeNewPipe === 'function') {
      await np.initializeNewPipe();
      console.log('Called initializeNewPipe()');
    } else if (typeof np.initializeNewPipeWithPoToken === 'function') {
      // call without args first — some builds accept no args
      await np.initializeNewPipeWithPoToken();
      console.log('Called initializeNewPipeWithPoToken()');
    } else if (typeof np.initialize === 'function') {
      await np.initialize();
      console.log('Called initialize()');
    }
  } catch (err) {
    console.log('NewPipe initialization non-fatal error:', err && err.message ? err.message : err);
  }

  // determine video id
  let videoId = extractVideoIdFromString(videoIdOrUrl) || videoIdOrUrl;
  if (!videoId) {
    // try module helper
    if (typeof np.extractVideoIdFromUrl === 'function') {
      try {
        const extracted = await np.extractVideoIdFromUrl(String(videoIdOrUrl));
        if (extracted) videoId = extracted;
      } catch (e) {
        console.log('extractVideoIdFromUrl failed:', e && e.message ? e.message : e);
      }
    }
  }
  if (!videoId) throw new Error('Could not determine videoId from input: ' + String(videoIdOrUrl));

  // collect candidate formats
  let rawFormats = [];
  let info = null;

  // small helper to merge results
  const push = (candidate) => {
    if (!candidate) return;
    if (Array.isArray(candidate)) rawFormats = rawFormats.concat(candidate);
    else if (candidate.formats && Array.isArray(candidate.formats)) rawFormats = rawFormats.concat(candidate.formats);
    else if (candidate.streams && Array.isArray(candidate.streams)) rawFormats = rawFormats.concat(candidate.streams);
    else if (typeof candidate === 'object') rawFormats.push(candidate);
  };

  // Try common extractor functions (order chosen to favor audio)
  const tries = [
    { fn: 'getBestAudioStream' },
    { fn: 'getBestDashAudioStream' },
    { fn: 'findBestAudioFormat' },
    { fn: 'extractStreamInfo' },
    { fn: 'getDashStreams' },
    { fn: 'getBestVideoStream' },
    { fn: 'getBestDashVideoStream' }
  ];

  for (const t of tries) {
    const name = t.fn;
    if (typeof np[name] === 'function') {
      try {
        const res = await np[name](videoId);
        if (res) {
          push(res);
          info = info || {};
          info[name] = res;
          console.log(`${name} returned`, Array.isArray(res) ? `${res.length} items` : 'object');
        }
      } catch (e) {
        console.log(`${name} call failed:`, e && e.message ? e.message : e);
      }
    }
    if (rawFormats.length > 0) break; // stop once we have something
  }

  // If we still have nothing, inspect module keys for debugging and throw
  if (!rawFormats || rawFormats.length === 0) {
    const keys = Object.keys(np || {});
    throw new Error('NewPipe extractor did not return formats. Available keys: ' + JSON.stringify(keys));
  }

  // Normalize and dedupe
  const normalized = rawFormats.map(normalizeFormat).filter(f => f.url);
  const seen = new Set();
  const dedup = [];
  for (const f of normalized) {
    if (!seen.has(f.url)) {
      seen.add(f.url);
      dedup.push(f);
    }
  }

  return { info, formats: dedup };
}

async function tryYtdlExec(videoId) {
  try {
    // eslint-disable-next-line global-require
    const ytdlExec = require('youtube-dl-exec');
    console.log('Using youtube-dl-exec fallback');
    // prefer json dump
    let meta = null;
    try {
      meta = await ytdlExec(`https://www.youtube.com/watch?v=${videoId}`, { dumpSingleJson: true });
    } catch (errA) {
      // alternative invocation pattern
      if (typeof ytdlExec === 'function') {
        try {
          meta = await ytdlExec(`https://www.youtube.com/watch?v=${videoId}`, ['-j']);
        } catch (errB) {
          console.log('youtube-dl-exec invocation patterns failed:', errA && errA.message ? errA.message : errA, errB && errB.message ? errB.message : errB);
          meta = null;
        }
      }
    }
    if (!meta) throw new Error('youtube-dl-exec did not return metadata');
    const formats = Array.isArray(meta.formats) ? meta.formats : [];
    const normalized = formats.map(normalizeFormat).filter(f => f.url);
    return { info: meta, formats: normalized };
  } catch (e) {
    throw new Error('youtube-dl-exec fallback failed: ' + (e && e.message ? e.message : String(e)));
  }
}

exports.handler = async function(event, context) {
  try {
    const params = event.queryStringParameters || {};
    const videoIdRaw = (params.videoId || params.v || params.url || params.q || '').trim();
    if (!videoIdRaw) {
      return { statusCode: 400, headers: DEFAULT_HEADERS, body: JSON.stringify({ error: 'Missing videoId (use ?videoId=VIDEO_ID or ?url=YOUTUBE_URL)' }) };
    }

    // prefer NewPipe extractor, but handle/return helpful errors
    try {
      const npRes = await tryNewPipe(videoIdRaw);
      const formats = npRes.formats || [];
      const best = pickBestAudio(formats);
      return {
        statusCode: 200,
        headers: DEFAULT_HEADERS,
        body: JSON.stringify({ extractor: 'newpipe-extractor-js', videoId: videoIdRaw, availableFormatsCount: formats.length, formats, best, infoSummary: Object.keys(npRes.info || {}) })
      };
    } catch (npErr) {
      console.log('NewPipe extractor error:', npErr && npErr.message ? npErr.message : npErr);

      // try fallback only if youtube-dl-exec installed
      try {
        const ytdlRes = await tryYtdlExec(extractVideoIdFromString(videoIdRaw) || videoIdRaw);
        const formats = ytdlRes.formats || [];
        const best = pickBestAudio(formats);
        return {
          statusCode: 200,
          headers: DEFAULT_HEADERS,
          body: JSON.stringify({ extractor: 'youtube-dl-exec-fallback', videoId: videoIdRaw, availableFormatsCount: formats.length, formats, best })
        };
      } catch (yErr) {
        console.log('youtube-dl-exec fallback error:', yErr && yErr.message ? yErr.message : yErr);
        // Return the original newpipe error details to help debugging
        return {
          statusCode: 500,
          headers: DEFAULT_HEADERS,
          body: JSON.stringify({ error: 'Extraction failed', details: (npErr && npErr.message) ? npErr.message : String(npErr), fallback: (yErr && yErr.message) ? yErr.message : String(yErr) })
        };
      }
    }

  } catch (err) {
    console.error('extract function error:', err && err.message ? err.message : err);
    return { statusCode: 500, headers: DEFAULT_HEADERS, body: JSON.stringify({ error: 'Internal server error', details: err && err.message ? err.message : String(err) }) };
  }
};
