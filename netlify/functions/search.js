// netlify/functions/search.js

// The correct way to import the library for a CommonJS module (Netlify Functions)
const YTMusic = require('ytmusic-api').default;

exports.handler = async (event, context) => {
    // This log will appear in your Netlify function logs
    console.log('Function invoked! Query:', event.queryStringParameters.q);

    const query = event.queryStringParameters.q;

    if (!query) {
        return {
            statusCode: 400,
            body: JSON.stringify({ error: 'Query parameter "q" is required.' }),
        };
    }

    try {
        // 1. Instantiate the API
        const ytmusic = new YTMusic();
        
        // 2. Perform the search. The method is just .search()
        const searchResults = await ytmusic.search(query);

        // 3. The results are in a 'songs' array
        const songs = searchResults.songs || [];

        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'application/json',
                // Add CORS headers to allow your frontend to call this
                'Access-Control-Allow-Origin': '*', 
                'Access-Control-Allow-Headers': 'Content-Type',
            },
            // Send back the first 5 results as JSON
            body: JSON.stringify(songs.slice(0, 5)),
        };

    } catch (error) {
        console.error("Search failed:", error); // This error will also be in the logs
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to fetch data from YouTube Music.', details: error.message }),
        };
    }
};
