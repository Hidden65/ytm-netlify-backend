// netlify/functions/search.js
const YouTubeMusicApi = require('youtube-music-api'); // package name: youtube-music-api

exports.handler = async function (event, context) {
  try {
    // validate query param
    const params = event.queryStringParameters || {};
    const q = params.q || params.query || '';

    if (!q || q.trim().length === 0) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Missing query parameter "q". Example: ?q=never%20gonna%20give%20you%20up' })
      };
    }

    // initialize the API
    const api = new YouTubeMusicApi();
    // IMPORTANT: initialize() must be awaited before using search()
    await api.initalize();

    // optional second param: 'song' | 'video' | 'album' | 'artist' | 'playlist'
    // if you want all types, call with unspecified type or call multiple searches
    const type = params.type || 'song';

    // call search
    const results = await api.search(q, type);

    // results usually contain multiple categories; return what you need
    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        query: q,
        type,
        results
      })
    };
  } catch (err) {
    // Log full error server-side (Netlify will show this in function logs)
    console.error('YouTube Music fetch error:', err);

    // try to include more helpful details in the response for debugging
    const details = (err && err.response && err.response.data) ? err.response.data : (err && err.message) ? err.message : err;

    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Failed to fetch data from YouTube Music.',
        details: details
      })
    };
  }
};
