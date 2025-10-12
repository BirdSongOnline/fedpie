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
    
    // Build FPDS query URL
    const baseUrl = 'https://www.fpds.gov/ezsearch/FEEDS/ATOM';
    const queryParams = new URLSearchParams({
      FEEDNAME: 'PUBLIC',
      q: buildFPDSQuery(params)
    });

    const fpdsUrl = `${baseUrl}?${queryParams.toString()}`;
    
    console.log('Querying FPDS:', fpdsUrl);

    // Fetch from FPDS
    const response = await fetch(fpdsUrl, {
      headers: {
        'User-Agent': 'FedPIE/1.0'
      }
    });

    if (!response.ok) {
      throw new Error(`FPDS API error: ${response.status} ${response.statusText}`);
    }

    const xmlText = await response.text();
    
    // Parse the Atom feed XML
    const parsedData = parseAtomFeed(xmlText);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        count: parsedData.length,
        data: parsedData,
        query: params
      })
    };

  } catch (error) {
    console.error('FPDS Proxy Error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        success: false,
        error: error.message
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
    conditions.push(`AGENCY_CODE:"${params.agency}"`);
  }
  
  // Date range (signed date)
  if (params.startDate && params.endDate) {
    const start = params.startDate.replace(/-/g, '/');
    const end = params.endDate.replace(/-/g, '/');
    conditions.push(`SIGNED_DATE:[${start},${end}]`);
  }
  
  // Set-aside type
  if (params.setAside) {
    conditions.push(`SOCIO_ECONOMIC_INDICATORS:"${params.setAside}"`);
  }
  
  // Contract value range
  if (params.minValue && params.maxValue) {
    conditions.push(`OBLIGATED_AMOUNT:[${params.minValue},${params.maxValue}]`);
  }
  
  // Default to contracts only (not IDVs)
  conditions.push('CONTRACT_TYPE:"AWARD"');
  
  // If no conditions, return wildcard
  return conditions.length > 0 ? conditions.join(' ') : '*';
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