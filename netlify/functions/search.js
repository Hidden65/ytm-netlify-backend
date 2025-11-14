// netlify/functions/search.js

// CORRECTED: Import the library without .default
const YTMusic = require('ytmusic-api');

exports.handler = async (event, context) => {
    console.log('Function invoked! Query:', event.queryStringParameters.q);

    const query = event.queryStringParameters.q;

    if (!query) {
        return {
            statusCode: 400,
            body: JSON.stringify({ error: 'Query parameter "q" is required.' }),
        };
    }

    try {
        // CORRECTED: Instantiate the API by awaiting the function call
        const ytmusic = await YTMusic();
        
        // Perform the search. The method is just .search()
        const searchResults = await ytmusic.search(query);

        // The results are in a 'songs' array
        const songs = searchResults.songs || [];

        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*', 
                'Access-Control-Allow-Headers': 'Content-Type',
            },
            // Send back the first 5 results as JSON
            body: JSON.stringify(songs.slice(0, 5)),
        };

    } catch (error) {
        console.error("Search failed:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to fetch data from YouTube Music.', details: error.message }),
        };
    }
};
