// netlify/functions/suggestion.js
const YouTubeMusicApi = require("youtube-music-api");

// Normalize results like your other functions
function normalizeSuggestion(raw) {
  try {
    const title =
      raw.title ||
      raw.query ||
      raw.name ||
      raw.suggestion ||
      raw.term ||
      raw.text ||
      "";

    const type =
      raw.type ||
      raw.category ||
      raw.suggestionType ||
      (raw.videoId ? "song" : "suggestion");

    return {
      title,
      type,
      raw,
    };
  } catch (err) {
    return {
      title: null,
      type: "unknown",
      raw,
      warning: "normalizeSuggestion failed: " + (err?.message || err),
    };
  }
}

exports.handler = async function (event, context) {
  const defaultHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  try {
    const params = event.queryStringParameters || {};
    const q = (params.q || params.query || "").trim();
    const limit = Math.min(20, parseInt(params.limit || "10", 10) || 10);

    if (!q) {
      return {
        statusCode: 400,
        headers: defaultHeaders,
        body: JSON.stringify({
          error: 'Missing query param "q". Example: ?q=ariana',
        }),
      };
    }

    const api = new YouTubeMusicApi();
    if (typeof api.initalize === "function") await api.initalize();
    else if (typeof api.initialize === "function") await api.initialize();
    else if (typeof api.init === "function") await api.init();

    // Try autocomplete methods
    let raw = null;

    if (typeof api.getSearchSuggestions === "function")
      raw = await api.getSearchSuggestions(q);
    else if (typeof api.search_suggestions === "function")
      raw = await api.search_suggestions(q);
    else if (typeof api.suggestions === "function")
      raw = await api.suggestions(q);
    else if (typeof api.search === "function") {
      // fallback: use search but extract only titles
      const sr = await api.search(q);
      raw =
        Array.isArray(sr)
          ? sr.map((r) => ({ title: r.title }))
          : sr.results || [];
    } else raw = [];

    let items = [];
    if (Array.isArray(raw)) {
      items = raw.map((s) => normalizeSuggestion(s));
    } else if (raw && raw.suggestions && Array.isArray(raw.suggestions)) {
      items = raw.suggestions.map((s) => normalizeSuggestion(s));
    } else if (raw && typeof raw === "object") {
      for (const v of Object.values(raw)) {
        if (Array.isArray(v)) {
          items = items.concat(v.map((s) => normalizeSuggestion(s)));
        }
      }
    }

    items = items.slice(0, limit);

    return {
      statusCode: 200,
      headers: defaultHeaders,
      body: JSON.stringify({
        query: q,
        count: items.length,
        suggestions: items,
      }),
    };
  } catch (err) {
    console.error("suggestion.js error:", err);
    return {
      statusCode: 500,
      headers: defaultHeaders,
      body: JSON.stringify({
        error: "Failed to fetch suggestions",
        details: err?.message || String(err),
      }),
    };
  }
};
