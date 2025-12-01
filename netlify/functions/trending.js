// netlify/functions/trending.js
const YouTubeMusicApi = require('youtube-music-api');

let api = null;

async function initYTMusic() {
  if (!api) {
    api = new YouTubeMusicApi();
    await api.initalize();
  }
  return api;
}

function mapSongResult(item) {
  const videoId = item.videoId || item.id;
  const title = item.name || item.title || 'Unknown Title';
  
  let artist = 'Unknown Artist';
  if (item.artist && Array.isArray(item.artist) && item.artist.length > 0) {
    artist = item.artist.map(a => a.name).filter(Boolean).join(', ');
  } else if (typeof item.artist === 'string') {
    artist = item.artist;
  } else if (item.author) {
    artist = item.author;
  }
  
  let duration = item.duration;
  if (typeof duration === 'number') {
    const mins = Math.floor(duration / 60000);
    const secs = Math.floor((duration % 60000) / 1000);
    duration = `${mins}:${secs.toString().padStart(2, '0')}`;
  }
  
  let thumbnail = null;
  if (item.thumbnails && Array.isArray(item.thumbnails) && item.thumbnails.length > 0) {
    thumbnail = item.thumbnails[item.thumbnails.length - 1].url;
  } else if (item.thumbnail) {
    thumbnail = item.thumbnail;
  }
  
  return {
    videoId,
    title,
    artist,
    duration,
    thumbnail
  };
}

exports.handler = async function (event, context) {
  try {
    const ytmusic = await initYTMusic();
    
    // Try multiple strategies to get trending music
    let results = [];
    
    // Strategy 1: Search for "Top 50 Global" playlist
    try {
      const playlistSearch = await ytmusic.search('Top 50 Global', 'playlist');
      if (playlistSearch.content && playlistSearch.content.length > 0) {
        const topPlaylistId = playlistSearch.content[0].browseId || playlistSearch.content[0].playlistId;
        if (topPlaylistId) {
          const playlist = await ytmusic.getPlaylist(topPlaylistId);
          if (playlist.content && playlist.content.length > 0) {
            results = playlist.content.slice(0, 30).map(mapSongResult);
          }
        }
      }
    } catch (e) {
      console.log('Strategy 1 failed:', e.message);
    }
    
    // Strategy 2: Search for popular/trending songs
    if (results.length === 0) {
      try {
        const trendingQueries = [
          'top hits 2024',
          'viral songs',
          'trending music',
          'popular songs'
        ];
        
        for (const query of trendingQueries) {
          const searchResult = await ytmusic.search(query, 'song');
          if (searchResult.content && searchResult.content.length > 0) {
            results = searchResult.content.slice(0, 30).map(mapSongResult);
            break;
          }
        }
      } catch (e) {
        console.log('Strategy 2 failed:', e.message);
      }
    }
    
    // Strategy 3: Get popular playlists and extract songs
    if (results.length === 0) {
      try {
        const playlistSearch = await ytmusic.search('hot hits', 'playlist');
        if (playlistSearch.content && playlistSearch.content.length > 0) {
          const playlistId = playlistSearch.content[0].browseId || playlistSearch.content[0].playlistId;
          if (playlistId) {
            const playlist = await ytmusic.getPlaylist(playlistId);
            if (playlist.content) {
              results = playlist.content.slice(0, 30).map(mapSongResult);
            }
          }
        }
      } catch (e) {
        console.log('Strategy 3 failed:', e.message);
      }
    }
    
    // Filter out any invalid results
    results = results.filter(r => r && r.videoId);
    
    return {
      statusCode: 200,
      headers: { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      },
      body: JSON.stringify({ 
        results,
        count: results.length,
        source: 'trending'
      })
    };
  } catch (err) {
    console.error('Trending error:', err);
    return {
      statusCode: 500,
      headers: { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({
        error: 'Failed to fetch trending music',
        details: err.message,
        results: []
      })
    };
  }
};
