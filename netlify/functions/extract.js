// netlify/functions/extract.js
// Prereq in your project root:
//   npm install newpipe-extractor-js
//
// Usage:
//   /.netlify/functions/extract?videoId=Uyka5SnxmQ4
//   /.netlify/functions/extract?url=https://www.youtube.com/watch?v=Uyka5SnxmQ4

'use strict';

const DEFAULT_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

function toYoutubeWatchUrl(input) {
  if (!input) return null;
  const s = String(input).trim();
  if (s.startsWith('http://') || s.startsWith('https://')) return s;
  // treat it as plain videoId
  return `https://www.youtube.com/watch?v=${s}`;
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
      f.qualityLabel || f.quality || f.label || f.format || f.format_note || null;

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
      raw: f,
    };
  }
}

function pickBestAudio(formats) {
  if (!Array.isArray(formats) || formats.length === 0) return null;
  const audioOnly = formats.filter((f) => f.isAudioOnly);
  const sortByQuality = (a, b) => {
    const aa = Number(a.audioBitrate || a.bitrate || 0);
    const bb = Number(b.audioBitrate || b.bitrate || 0);
    return bb - aa;
  };
  if (audioOnly.length > 0) {
    audioOnly.sort(sortByQuality);
    return audioOnly[0];
  }
  const byBitrate = formats.slice().sort((a, b) => {
    return Number(b.bitrate || 0) - Number(a.bitrate || 0);
  });
  return byBitrate[0] || null;
}

async function extractWithNewPipe(input) {
  let np;
  try {
    // eslint-disable-next-line global-require
    np = require('newpipe-extractor-js');
  } catch (e) {
    throw new Error(
      'newpipe-extractor-js not installed or failed to require: ' +
        (e && e.message ? e.message : String(e))
    );
  }

  console.log('newpipe-extractor-js keys:', Object.keys(np));

  // Build a full YouTube URL (THIS was the main bug before)
  const url = toYoutubeWatchUrl(input);
  if (!url) {
    throw new Error('Invalid videoId/url input: ' + String(input));
  }
  console.log('Using URL for extraction:', url);

  // Initialize NewPipe if needed
  try {
    if (typeof np.initializeNewPipe === 'function') {
      await np.initializeNewPipe();
      console.log('Called initializeNewPipe()');
    } else if (typeof np.initializeNewPipeWithPoToken === 'function') {
      await np.initializeNewPipeWithPoToken();
      console.log('Called initializeNewPipeWithPoToken()');
    } else if (typeof np.initialize === 'function') {
      await np.initialize();
      console.log('Called initialize()');
    }
  } catch (err) {
    console.log(
      'NewPipe initialization non-fatal error:',
      err && err.message ? err.message : err
    );
  }

  // Optional: set localization / country to something common
  try {
    if (typeof np.setPreferredLocalization === 'function') {
      np.setPreferredLocalization('en');
    }
    if (typeof np.setPreferredContentCountry === 'function') {
      np.setPreferredContentCountry('US');
    }
  } catch (e) {
    console.log(
      'setPreferredLocalization/setPreferredContentCountry error:',
      e && e.message ? e.message : e
    );
  }

  // Collect candidate formats
  let rawFormats = [];
  const info = {};

  const push = (candidate, label) => {
    if (!candidate) return;
    if (Array.isArray(candidate)) {
      rawFormats = rawFormats.concat(candidate);
      return;
    }
    if (candidate.formats && Array.isArray(candidate.formats)) {
      rawFormats = rawFormats.concat(candidate.formats);
      return;
    }
    if (candidate.streams && Array.isArray(candidate.streams)) {
      rawFormats = rawFormats.concat(candidate.streams);
      return;
    }
    if (typeof candidate === 'object') {
      rawFormats.push(candidate);
      return;
    }
  };

  // 1) getBestAudioStream (most useful for you)
  if (typeof np.getBestAudioStream === 'function') {
    try {
      const bestAudio = await np.getBestAudioStream(url);
      console.log('getBestAudioStream result type:', typeof bestAudio);
      if (bestAudio) {
        info.bestAudio = bestAudio;
        push(bestAudio, 'bestAudio');
      }
    } catch (e) {
      console.log(
        'getBestAudioStream failed:',
        e && e.message ? e.message : e
      );
    }
  }

  // 2) extractStreamInfo (might include multiple streams)
  if (rawFormats.length === 0 && typeof np.extractStreamInfo === 'function') {
    try {
      const streamInfo = await np.extractStreamInfo(url);
      console.log(
        'extractStreamInfo result type:',
        streamInfo ? typeof streamInfo : 'null'
      );
      if (streamInfo) {
        info.streamInfo = streamInfo;
        push(streamInfo, 'streamInfo');
      }
    } catch (e) {
      console.log(
        'extractStreamInfo failed:',
        e && e.message ? e.message : e
      );
    }
  }

  // 3) getDashStreams as a fallback
  if (rawFormats.length === 0 && typeof np.getDashStreams === 'function') {
    try {
      const dash = await np.getDashStreams(url);
      console.log('getDashStreams result type:', dash ? typeof dash : 'null');
      if (dash) {
        info.dash = dash;
        push(dash, 'dash');
      }
    } catch (e) {
      console.log(
        'getDashStreams failed:',
        e && e.message ? e.message : e
      );
    }
  }

  if (!rawFormats || rawFormats.length === 0) {
    throw new Error(
      'NewPipe extractor did not return formats for URL: ' + url
    );
  }

  // Normalize and dedupe
  const normalized = rawFormats.map(normalizeFormat).filter((f) => f.url);
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

exports.handler = async function (event, context) {
  try {
    const params = event.queryStringParameters || {};
    const raw = (params.videoId || params.v || params.url || params.q || '').trim();

    if (!raw) {
      return {
        statusCode: 400,
        headers: DEFAULT_HEADERS,
        body: JSON.stringify({
          error:
            'Missing videoId or url. Use ?videoId=Uyka5SnxmQ4 or ?url=https://www.youtube.com/watch?v=Uyka5SnxmQ4',
        }),
      };
    }

    console.log('Incoming extract request param:', raw);

    try {
      const result = await extractWithNewPipe(raw);
      const formats = result.formats || [];
      const best = pickBestAudio(formats);

      return {
        statusCode: 200,
        headers: DEFAULT_HEADERS,
        body: JSON.stringify({
          extractor: 'newpipe-extractor-js',
          input: raw,
          urlUsed: toYoutubeWatchUrl(raw),
          availableFormatsCount: formats.length,
          formats,
          best,
          infoSummary: Object.keys(result.info || {}),
        }),
      };
    } catch (e) {
      console.error(
        'NewPipe extraction failed:',
        e && e.message ? e.message : e
      );
      return {
        statusCode: 500,
        headers: DEFAULT_HEADERS,
        body: JSON.stringify({
          error: 'Extraction failed',
          details: e && e.message ? e.message : String(e),
        }),
      };
    }
  } catch (err) {
    console.error(
      'extract function top-level error:',
      err && err.message ? err.message : err
    );
    return {
      statusCode: 500,
      headers: DEFAULT_HEADERS,
      body: JSON.stringify({
        error: 'Internal server error',
        details: err && err.message ? err.message : String(err),
      }),
    };
  }
};
