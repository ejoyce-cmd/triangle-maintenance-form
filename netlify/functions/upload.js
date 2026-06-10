// netlify/functions/upload.js
// Uploads PDF report and photos/documents to Monday.com Files columns

const MONDAY_API_KEY = process.env.MONDAY_API_KEY;
const BOARD_ID = '5979872405';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // Netlify provides multipart body as base64
  const contentType = event.headers['content-type'] || '';
  if (!contentType.includes('multipart/form-data')) {
    return { statusCode: 400, body: 'Expected multipart/form-data' };
  }

  // Parse multipart manually using busboy
  const busboy = require('busboy');
  const bb = busboy({ headers: { 'content-type': contentType } });

  const fields = {};
  const files = [];

  await new Promise((resolve, reject) => {
    bb.on('field', (name, value) => { fields[name] = value; });
    bb.on('file', (name, stream, info) => {
      const chunks = [];
      stream.on('data', chunk => chunks.push(chunk));
      stream.on('end', () => {
        files.push({
          fieldname: name,
          filename: info.filename,
          mimetype: info.mimeType,
          buffer: Buffer.concat(chunks),
        });
      });
    });
    bb.on('close', resolve);
    bb.on('error', reject);

    const body = event.isBase64Encoded
      ? Buffer.from(event.body, 'base64')
      : Buffer.from(event.body);
    bb.write(body);
    bb.end();
  });

  const { itemId, type } = fields;

  if (!itemId) {
    return { statusCode: 400, body: 'Missing itemId' };
  }

  // Determine which column to upload to
  // type === 'pdf'    → use the Files column just right of Total Cost (user will set this)
  // type === 'photos' → use the Photos column
  let columnId;
  try {
    const colResp = await fetch('https://api.monday.com/v2', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': MONDAY_API_KEY,
        'API-Version': '2024-01',
      },
      body: JSON.stringify({
        query: `{ boards(ids: [${BOARD_ID}]) { columns { id title type } } }`
      }),
    });
    const colData = await colResp.json();
    const columns = colData?.data?.boards?.[0]?.columns || [];

    if (type === 'pdf') {
      // Find the files column just right of Total Cost
      // User will rename it to something like "WO Report" or "Client Doc"
      // We look for a file-type column that matches likely names
      const pdfCol = columns.find(c =>
        c.type === 'file' && c.title.toLowerCase().includes('pdf import')
      );
      // Fallback: first file column that isn't Photos or Vendor Docs
      const fallback = columns.find(c =>
        c.type === 'file' &&
        !c.title.toLowerCase().includes('photo') &&
        !c.title.toLowerCase().includes('vendor')
      );
      columnId = pdfCol?.id || fallback?.id;
    } else {
      // Photos column
      const photoCol = columns.find(c =>
        c.type === 'file' && c.title.toLowerCase().includes('photo')
      );
      columnId = photoCol?.id;
    }
  } catch (err) {
    return { statusCode: 500, body: `Column lookup failed: ${err.message}` };
  }

  if (!columnId) {
    return { statusCode: 500, body: `Could not find target column for type: ${type}` };
  }

  // Upload each file to Monday
  const results = [];
  for (const f of files) {
    try {
      const mutation = `mutation ($file: File!) {
        add_file_to_column(item_id: ${itemId}, column_id: "${columnId}", file: $file) {
          id
        }
      }`;

      const formData = new FormData();
      formData.append('query', mutation);
      formData.append(
        'variables[file]',
        new Blob([f.buffer], { type: f.mimetype }),
        f.filename
      );

      const resp = await fetch('https://api.monday.com/v2/file', {
        method: 'POST',
        headers: {
          'Authorization': MONDAY_API_KEY,
          'API-Version': '2024-01',
        },
        body: formData,
      });

      const result = await resp.json();
      results.push({ filename: f.filename, result });
    } catch (err) {
      results.push({ filename: f.filename, error: err.message });
    }
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uploaded: results.length, results }),
  };
};
