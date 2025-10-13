// netlify/functions/fpds-proxy.js
// Federal Procurement Data System (FPDS) API Proxy

const https = require('https');

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
    
    // Build query based on what we're looking for
    let query = '';
    
    if (params.naics) {
      // Query for contracts with this NAICS code
      query = `PRINCIPAL_NAICS_CODE:"${params.naics}"`;
      
      // Add date filter - look back 2 years
      const today = new Date();
      const twoYearsAgo = new Date(today);
      twoYearsAgo.setFullYear(today.getFullYear() - 2);
      
      const formatDate = (date) => {
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const year = date.getFullYear();
        return `${month}/${day}/${year}`;
      };
      
      // Use LAST_MOD_DATE to get recent contracts
      query += ` LAST_MOD_DATE:[${formatDate(twoYearsAgo)},${formatDate(today)}]`;
    } else {
      // Fallback: get recent contracts from last month
      const today = new Date();
      const lastMonth = new Date(today);
      lastMonth.setMonth(today.getMonth() - 1);
      
      const formatDate = (date) => {
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const year = date.getFullYear();
        return `${month}/${day}/${year}`;
      };
      
      query = `LAST_MOD_DATE:[${formatDate(lastMonth)},${formatDate(today)}]`;
    }
    
    // Build FPDS query URL
    const baseUrl = 'https://www.fpds.gov/ezsearch/FEEDS/ATOM';
    const fpdsUrl = `${baseUrl}?FEEDNAME=PUBLIC&q=${encodeURIComponent(query)}`;
    
    console.log('Querying FPDS with:', fpdsUrl);

    // Use Node.js https module instead of fetch
    const xmlText = await new Promise((resolve, reject) => {
      https.get(fpdsUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/atom+xml, application/xml, text/xml, */*'
        }
      }, (response) => {
        let data = '';
        
        response.on('data', (chunk) => {
          data += chunk;
        });
        
        response.on('end', () => {
          if (response.statusCode === 200) {
            resolve(data);
          } else {
            reject(new Error(`FPDS returned status ${response.statusCode}`));
          }
        });
      }).on('error', (error) => {
        reject(error);
      });
    });
    
    console.log('FPDS response received, length:', xmlText.length);
    console.log('First 1000 chars:', xmlText.substring(0, 1000));
    
    // Parse the Atom feed XML
    const parsedData = parseAtomFeed(xmlText);
    
    console.log('Parsed contracts:', parsedData.length);
    console.log('Sample contract:', parsedData[0]);

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
    console.error('Error stack:', error.stack);
    
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: false,
        error: error.message || 'Unknown error occurred',
        type: error.name || 'Error',
        stack: error.stack ? error.stack.substring(0, 500) : 'No stack trace'
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
    
    let entryCount = 0;
    while ((match = entryRegex.exec(xmlText)) !== null) {
      entryCount++;
      const entryContent = match[1];
      
      // Extract contract data from entry
      const contract = {
        // Basic info
        piid: extractTag(entryContent, 'PIID'),
        agency: extractTag(entryContent, 'agencyID'),
        agencyName: extractTagAttribute(entryContent, 'agencyID', 'name'),
        
        // Vendor info - try multiple tag names
        vendorName: extractTag(entryContent, 'UEI_NAME') || 
                    extractTag(entryContent, 'vendorName') ||
                    extractTag(entryContent, 'UEILegalBusinessName'),
        vendorUEI: extractTag(entryContent, 'VENDOR_UEI'),
        parentCompany: extractTag(entryContent, 'ULTIMATE_UEI_NAME') ||
                       extractTag(entryContent, 'ultimateParentUEIName'),
        
        // Financial
        obligatedAmount: parseFloat(extractTag(entryContent, 'obligatedAmount') || '0'),
        baseAndAllOptions: parseFloat(extractTag(entryContent, 'baseAndAllOptionsValue') || '0'),
        
        // Dates
        signedDate: extractTag(entryContent, 'signedDate'),
        startDate: extractTag(entryContent, 'effectiveDate'),
        completionDate: extractTag(entryContent, 'currentCompletionDate') ||
                       extractTag(entryContent, 'ultimateCompletionDate'),
        
        // Classification
        naicsCode: extractTag(entryContent, 'principalNAICSCode') ||
                   extractTag(entryContent, 'NAICS_CODE'),
        naicsDescription: extractTag(entryContent, 'principalNAICSDescription') ||
                         extractTag(entryContent, 'NAICS_DESCRIPTION'),
        pscCode: extractTag(entryContent, 'productOrServiceCode') ||
                 extractTag(entryContent, 'PRODUCT_OR_SERVICE_CODE'),
        
        // Set-aside
        setAside: extractTag(entryContent, 'typeOfSetAside'),
        
        // Description
        description: extractTag(entryContent, 'descriptionOfContractRequirement')
      };
      
      // Only add if we have meaningful data
      if (contract.piid || contract.vendorName || contract.obligatedAmount > 0) {
        contracts.push(contract);
      }
    }
    
    console.log(`Found ${entryCount} entries, parsed ${contracts.length} valid contracts`);
    
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