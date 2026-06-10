// netlify/functions/upload.js
// Accepts a single base64-encoded file as JSON, uploads to Monday.com
// Called once per file from the browser

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
    payload = JSON.parse(raw.trim());
  } catch (err) {
    return { statusCode: 400, body: 'Invalid JSON: ' + err.message };
  }

  const { itemId, type, name, mimetype, data } = payload;

  if (!itemId) return { statusCode: 400, body: 'Missing itemId' };
  if (!data)   return { statusCode: 400, body: 'Missing file data' };

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
      const col = columns.find(c => c.type === 'file' && c.title.toLowerCase().includes('pdf import'))
                || columns.find(c => c.type === 'file' && !c.title.toLowerCase().includes('photo') && !c.title.toLowerCase().includes('vendor'));
      columnId = col?.id;
    } else {
      const col = columns.find(c => c.type === 'file' && c.title.toLowerCase().includes('photo'))
                || columns.find(c => c.type === 'file');
      columnId = col?.id;
    }
  } catch (err) {
    return { statusCode: 500, body: 'Column lookup failed: ' + err.message };
  }

  if (!columnId) {
    return { statusCode: 500, body: 'No suitable file column found for type: ' + type };
  }

  // Upload to Monday
  try {
    const fileBuffer = Buffer.from(data, 'base64');
    const fileName = name || 'upload';
    const fileMime = mimetype || 'application/octet-stream';

    const mutation = `mutation ($file: File!) {
      add_file_to_column(item_id: ${itemId}, column_id: "${columnId}", file: $file) {
        id
      }
    }`;

    const boundary = '----MondayBoundary' + Date.now();
    const nl = '\r\n';

    const metaPart = `--${boundary}${nl}Content-Disposition: form-data; name="query"${nl}${nl}${mutation}${nl}`;
    const filePart = `--${boundary}${nl}Content-Disposition: form-data; name="variables[file]"; filename="${fileName}"${nl}Content-Type: ${fileMime}${nl}${nl}`;
    const closing  = `${nl}--${boundary}--${nl}`;

    const bodyBuffer = Buffer.concat([
      Buffer.from(metaPart, 'utf8'),
      Buffer.from(filePart, 'utf8'),
      fileBuffer,
      Buffer.from(closing, 'utf8'),
    ]);

    const resp = await fetch('https://api.monday.com/v2/file', {
      method: 'POST',
      headers: {
        'Authorization': MONDAY_API_KEY,
        'API-Version': '2024-01',
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body: bodyBuffer,
    });

    const result = await resp.json();
    if (result.errors) {
      return { statusCode: 500, body: JSON.stringify(result.errors) };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, result }),
    };
  } catch (err) {
    return { statusCode: 500, body: 'Upload failed: ' + err.message };
  }
};
