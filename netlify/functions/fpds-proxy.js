// netlify/functions/fpds-proxy.js
// Federal Procurement Data System (FPDS) API Proxy

exports.handler = async (event, context) => {
  // Enable CORS
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json'
  };

  // Handle preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    const params = event.queryStringParameters || {};
    
    // Try a super simple query first - just get recent contracts
    let query = `LAST_MOD_DATE:[2024/10/01,2025/10/12]`;
    
    // Add NAICS if provided
    if (params.naics) {
      query = `PRINCIPAL_NAICS_CODE:"${params.naics}"`;
    }
    
    // Build FPDS query URL
    const baseUrl = 'https://www.fpds.gov/ezsearch/FEEDS/ATOM';
    const fpdsUrl = `${baseUrl}?FEEDNAME=PUBLIC&q=${encodeURIComponent(query)}`;
    
    console.log('Querying FPDS with:', fpdsUrl);

    // Fetch from FPDS with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);
    
    const response = await fetch(fpdsUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'application/atom+xml, application/xml, text/xml'
      },
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      console.error('FPDS error status:', response.status);
      console.error('FPDS error body:', errorText.substring(0, 500));
      
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success: false,
          error: `FPDS returned status ${response.status}`,
          details: errorText.substring(0, 200),
          query: query
        })
      };
    }

    const xmlText = await response.text();
    
    console.log('FPDS response received, length:', xmlText.length);
    console.log('First 500 chars:', xmlText.substring(0, 500));
    
    // Parse the Atom feed XML
    const parsedData = parseAtomFeed(xmlText);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        count: parsedData.length,
        data: parsedData,
        query: query
      })
    };

  } catch (error) {
    console.error('FPDS Proxy Error:', error);
    
    if (error.name === 'AbortError') {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success: false,
          error: 'FPDS request timed out after 15 seconds'
        })
      };
    }
    
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: false,
        error: error.message,
        type: error.name
      })
    };
  }
};

// Build FPDS query string from parameters
function buildFPDSQuery(params) {
  const conditions = [];
  
  // NAICS Code
  if (params.naics) {
    conditions.push(`PRINCIPAL_NAICS_CODE:"${params.naics}"`);
  }
  
  // Agency Code
  if (params.agency) {
    conditions.push(`CONTRACTING_AGENCY_ID:"${params.agency}"`);
  }
  
  // Date range (last modified date works better than signed date)
  if (params.startDate && params.endDate) {
    const start = params.startDate.replace(/-/g, '/');
    const end = params.endDate.replace(/-/g, '/');
    conditions.push(`LAST_MOD_DATE:[${start},${end}]`);
  }
  
  // If no conditions, return just NAICS and Agency
  if (conditions.length === 0) {
    return '*';
  }
  
  return conditions.join(' ');
}

// Parse FPDS Atom feed XML
function parseAtomFeed(xmlText) {
  const contracts = [];
  
  try {
    // Extract all <entry> elements
    const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
    let match;
    
    while ((match = entryRegex.exec(xmlText)) !== null) {
      const entryContent = match[1];
      
      // Extract contract data from entry
      const contract = {
        // Basic info
        piid: extractTag(entryContent, 'PIID'),
        agency: extractTag(entryContent, 'agencyID'),
        agencyName: extractTagAttribute(entryContent, 'agencyID', 'name'),
        
        // Vendor info
        vendorName: extractTag(entryContent, 'UEI_NAME') || extractTag(entryContent, 'vendorName'),
        vendorUEI: extractTag(entryContent, 'VENDOR_UEI'),
        parentCompany: extractTag(entryContent, 'ULTIMATE_UEI_NAME'),
        
        // Financial
        obligatedAmount: parseFloat(extractTag(entryContent, 'obligatedAmount') || '0'),
        baseAndAllOptions: parseFloat(extractTag(entryContent, 'baseAndAllOptionsValue') || '0'),
        
        // Dates
        signedDate: extractTag(entryContent, 'signedDate'),
        startDate: extractTag(entryContent, 'effectiveDate'),
        completionDate: extractTag(entryContent, 'currentCompletionDate'),
        
        // Classification
        naicsCode: extractTag(entryContent, 'NAICS_CODE') || extractTag(entryContent, 'principalNAICSCode'),
        naicsDescription: extractTag(entryContent, 'NAICS_DESCRIPTION') || extractTag(entryContent, 'principalNAICSDescription'),
        pscCode: extractTag(entryContent, 'PRODUCT_OR_SERVICE_CODE') || extractTag(entryContent, 'productOrServiceCode'),
        
        // Set-aside
        setAside: extractTag(entryContent, 'typeOfSetAside'),
        
        // Description
        description: extractTag(entryContent, 'descriptionOfContractRequirement')
      };
      
      contracts.push(contract);
    }
    
    return contracts;
    
  } catch (error) {
    console.error('XML parsing error:', error);
    return [];
  }
}

// Helper: Extract text content from XML tag
function extractTag(xml, tagName) {
  // Try with namespace prefix first
  let regex = new RegExp(`<(?:ns\\d+:)?${tagName}[^>]*>([^<]*)<`, 'i');
  let match = xml.match(regex);
  if (match) return match[1].trim();
  
  // Try without namespace
  regex = new RegExp(`<${tagName}[^>]*>([^<]*)<`, 'i');
  match = xml.match(regex);
  return match ? match[1].trim() : null;
}

// Helper: Extract attribute from XML tag
function extractTagAttribute(xml, tagName, attrName) {
  const regex = new RegExp(`<(?:ns\\d+:)?${tagName}[^>]*${attrName}="([^"]*)"`, 'i');
  const match = xml.match(regex);
  return match ? match[1].trim() : null;
}