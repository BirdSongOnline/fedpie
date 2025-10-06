exports.handler = async (event) => {
  const API_KEY = 'SAM-d0cfdadb-0dc4-4592-bff9-9bcba7cb1711';
  
  const queryParams = event.queryStringParameters || {};
  
  const params = new URLSearchParams({
    api_key: API_KEY,
    ...queryParams
  });
  
  const samURL = `https://api.sam.gov/opportunities/v2/search?${params}`;
  
  try {
    const response = await fetch(samURL);
    const data = await response.json();
    
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(data)
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ error: error.message })
    };
  }
};