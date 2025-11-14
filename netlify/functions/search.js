// netlify/functions/search.js

exports.handler = async (event, context) => {
    // Use dynamic import() to correctly load the ES Module
    const { default: YTMusic } = await import('ytmusic-api');

    const query = event.queryStringParameters.q;

    if (!query) {
        return {
            statusCode: 400,
            body: JSON.stringify({ error: 'Query parameter "q" is required.' }),
        };
    }

    try {
        // Now we can correctly use 'new' to create an instance
        const ytmusic = new YTMusic();
        
        const searchResults = await ytmusic.search(query);
        const songs = searchResults.songs || [];

        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*', 
                'Access-Control-Allow-Headers': 'Content-Type',
            },
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
