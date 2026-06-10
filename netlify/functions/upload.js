// netlify/functions/upload.js
// Accepts base64-encoded files as JSON, uploads to Monday.com

const MONDAY_API_KEY = process.env.MONDAY_API_KEY;
const BOARD_ID = '5979872405';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let payload;
  try {
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body, 'base64').toString('utf8')
      : event.body;
    payload = JSON.parse(raw);
  } catch (err) {
    return { statusCode: 400, body: `Invalid JSON: ${err.message}` };
  }

  const { itemId, type, files } = payload;

  if (!itemId) return { statusCode: 400, body: 'Missing itemId' };
  if (!files || !files.length) return { statusCode: 200, body: JSON.stringify({ uploaded: 0 }) };

  // Look up board columns
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
      const pdfCol = columns.find(c =>
        c.type === 'file' && c.title.toLowerCase().includes('pdf import')
      );
      const fallback = columns.find(c =>
        c.type === 'file' &&
        !c.title.toLowerCase().includes('photo') &&
        !c.title.toLowerCase().includes('vendor')
      );
      columnId = pdfCol?.id || fallback?.id;
    } else {
      const photoCol = columns.find(c =>
        c.type === 'file' && c.title.toLowerCase().includes('photo')
      );
      // fallback to any file column
      const fallback = columns.find(c => c.type === 'file');
      columnId = photoCol?.id || fallback?.id;
    }
  } catch (err) {
    return { statusCode: 500, body: `Column lookup failed: ${err.message}` };
  }

  if (!columnId) {
    return { statusCode: 500, body: `No suitable file column found for type: ${type}` };
  }

  // Upload each file
  const results = [];
  for (const f of files) {
    try {
      const fileBuffer = Buffer.from(f.data, 'base64');

      const mutation = `mutation ($file: File!) {
        add_file_to_column(item_id: ${itemId}, column_id: "${columnId}", file: $file) {
          id
        }
      }`;

      // Build multipart form for Monday file upload
      const boundary = '----MondayFileBoundary' + Date.now();
      const nl = '\r\n';

      const metaPart =
        `--${boundary}${nl}` +
        `Content-Disposition: form-data; name="query"${nl}${nl}` +
        `${mutation}${nl}`;

      const filePart =
        `--${boundary}${nl}` +
        `Content-Disposition: form-data; name="variables[file]"; filename="${f.name}"${nl}` +
        `Content-Type: ${f.mimetype}${nl}${nl}`;

      const closing = `${nl}--${boundary}--${nl}`;

      const bodyParts = [
        Buffer.from(metaPart, 'utf8'),
        Buffer.from(filePart, 'utf8'),
        fileBuffer,
        Buffer.from(closing, 'utf8'),
      ];
      const bodyBuffer = Buffer.concat(bodyParts);

      const resp = await fetch('https://api.monday.com/v2/file', {
        method: 'POST',
        headers: {
          'Authorization': MONDAY_API_KEY,
          'API-Version': '2024-01',
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': bodyBuffer.length,
        },
        body: bodyBuffer,
      });

      const result = await resp.json();
      results.push({ name: f.name, success: !result.errors, result });
    } catch (err) {
      results.push({ name: f.name, success: false, error: err.message });
    }
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uploaded: results.filter(r => r.success).length, results }),
  };
};
