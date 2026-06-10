// netlify/functions/upload.js
// Uploads PDF and photos/documents to Monday.com — no external dependencies

const MONDAY_API_KEY = process.env.MONDAY_API_KEY;
const BOARD_ID = '5979872405';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const contentType = event.headers['content-type'] || '';
  if (!contentType.includes('multipart/form-data')) {
    return { statusCode: 400, body: 'Expected multipart/form-data' };
  }

  // Parse multipart manually — no busboy needed
  const boundary = contentType.split('boundary=')[1];
  if (!boundary) {
    return { statusCode: 400, body: 'Missing boundary in content-type' };
  }

  const bodyBuffer = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64')
    : Buffer.from(event.body, 'binary');

  const parts = parseMultipart(bodyBuffer, boundary);

  const fields = {};
  const files = [];

  for (const part of parts) {
    if (!part.filename) {
      fields[part.name] = part.data.toString('utf8');
    } else {
      files.push({
        fieldname: part.name,
        filename: part.filename,
        mimetype: part.contentType || 'application/octet-stream',
        buffer: part.data,
      });
    }
  }

  const { itemId, type } = fields;

  if (!itemId) {
    return { statusCode: 400, body: 'Missing itemId' };
  }

  // Look up board columns to find target column
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

// ─── Multipart parser (no dependencies) ──────────────────────────────
function parseMultipart(buffer, boundary) {
  const parts = [];
  const boundaryBuf = Buffer.from('--' + boundary);
  const nl = Buffer.from('\r\n');
  const eof = Buffer.from('--' + boundary + '--');

  let pos = 0;

  while (pos < buffer.length) {
    // Find boundary
    const boundaryPos = indexOf(buffer, boundaryBuf, pos);
    if (boundaryPos === -1) break;

    pos = boundaryPos + boundaryBuf.length;

    // Check for end boundary
    if (buffer.slice(pos, pos + 2).toString() === '--') break;

    // Skip \r\n after boundary
    if (buffer.slice(pos, pos + 2).toString() === '\r\n') pos += 2;

    // Parse headers
    const headers = {};
    while (pos < buffer.length) {
      const lineEnd = indexOf(buffer, nl, pos);
      if (lineEnd === -1) break;
      const line = buffer.slice(pos, lineEnd).toString('utf8');
      pos = lineEnd + 2;
      if (line === '') break; // blank line = end of headers
      const colonIdx = line.indexOf(':');
      if (colonIdx !== -1) {
        const key = line.slice(0, colonIdx).trim().toLowerCase();
        const val = line.slice(colonIdx + 1).trim();
        headers[key] = val;
      }
    }

    // Find next boundary to get data end
    const nextBoundary = indexOf(buffer, boundaryBuf, pos);
    if (nextBoundary === -1) break;

    // Data is between pos and nextBoundary - 2 (strip trailing \r\n)
    const data = buffer.slice(pos, nextBoundary - 2);
    pos = nextBoundary;

    // Parse content-disposition
    const disp = headers['content-disposition'] || '';
    const nameMatch = disp.match(/name="([^"]+)"/);
    const fileMatch = disp.match(/filename="([^"]+)"/);
    const contentType = headers['content-type'] || null;

    parts.push({
      name: nameMatch ? nameMatch[1] : '',
      filename: fileMatch ? fileMatch[1] : null,
      contentType,
      data,
    });
  }

  return parts;
}

function indexOf(buf, search, start = 0) {
  for (let i = start; i <= buf.length - search.length; i++) {
    let found = true;
    for (let j = 0; j < search.length; j++) {
      if (buf[i + j] !== search[j]) { found = false; break; }
    }
    if (found) return i;
  }
  return -1;
}
