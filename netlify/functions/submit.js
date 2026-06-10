// netlify/functions/submit.js
const MONDAY_API_KEY = process.env.MONDAY_API_KEY;
const BOARD_ID = '5979872405';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let data;
  try {
    data = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  const {
    address, techName, visitType, date,
    diagnosticActions, proposedSolution,
    materialsText, materialsTotal, laborHours, grandTotal,
    completionNotes,
  } = data;

  const itemName = `${address} - ${techName}`;

  // Fetch board columns to get IDs and types
  let boardColumns;
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
    boardColumns = colData?.data?.boards?.[0]?.columns || [];
  } catch (err) {
    return { statusCode: 500, body: `Failed to fetch board columns: ${err.message}` };
  }

  const columnValues = {};

  // Set a column value based on its type
  function setCol(titleFragment, value) {
    if (value == null || value === '' || value === undefined) return;
    const col = boardColumns.find(c =>
      c.title.toLowerCase().includes(titleFragment.toLowerCase())
    );
    if (!col) return;

    if (col.type === 'numeric') {
      columnValues[col.id] = String(value);
    } else if (col.type === 'long_text') {
      columnValues[col.id] = { text: String(value) };
    } else if (col.type === 'text') {
      columnValues[col.id] = String(value);
    } else if (col.type === 'color') {
      columnValues[col.id] = { label: String(value) };
    } else if (col.type === 'dropdown') {
      columnValues[col.id] = { labels: [String(value)] };
    } else if (col.type === 'date') {
      const d = new Date(value);
      columnValues[col.id] = { date: d.toISOString().split('T')[0] };
    } else {
      columnValues[col.id] = String(value);
    }
  }

  setCol('visit type', visitType);
  setCol('diagnostic', diagnosticActions);
  setCol('proposed solution', proposedSolution);
  setCol('materials list', materialsText);
  setCol('materials (dollar', materialsTotal);
  setCol('labor (hour', laborHours);
  setCol('total cost', grandTotal);
  setCol('completion note', completionNotes);
  // Maintenance Item is a board-relation column — skipped (manual)

  // Date Received
  const dateCol = boardColumns.find(c =>
    c.title.toLowerCase().includes('date received') || c.title.toLowerCase() === 'date'
  );
  if (dateCol && date) {
    const d = new Date(date);
    columnValues[dateCol.id] = { date: d.toISOString().split('T')[0] };
  }

  const colValStr = JSON.stringify(JSON.stringify(columnValues));

  const mutation = `
    mutation {
      create_item(
        board_id: ${BOARD_ID},
        item_name: ${JSON.stringify(itemName)},
        column_values: ${colValStr}
      ) {
        id
        name
      }
    }
  `;

  try {
    const resp = await fetch('https://api.monday.com/v2', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': MONDAY_API_KEY,
        'API-Version': '2024-01',
      },
      body: JSON.stringify({ query: mutation }),
    });

    const result = await resp.json();

    if (result.errors) {
      return { statusCode: 500, body: JSON.stringify(result.errors) };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(result),
    };
  } catch (err) {
    return { statusCode: 500, body: `Monday.com error: ${err.message}` };
  }
};
