// netlify/functions/submit.js
// Creates a new item on the TReno maintenance Monday.com board

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
    materialsText, materialsTotal, laborHours, laborCost, grandTotal,
    completionNotes,
  } = data;

  // Item name: address + technician
  const itemName = `${address} - ${techName}`;

  // Build column values
  // Query the board columns first to get IDs, then map by title
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

  // Helper: find column ID by partial title match
  function colId(titleFragment) {
    const col = boardColumns.find(c =>
      c.title.toLowerCase().includes(titleFragment.toLowerCase())
    );
    return col ? col.id : null;
  }

  // Build column values JSON
  const columnValues = {};

  // Visit Type (status or dropdown column)
  const visitTypeCol = colId('visit type');
  if (visitTypeCol && visitType) {
    columnValues[visitTypeCol] = { label: visitType };
  }

  // Diagnostic Actions (long text)
  const diagCol = colId('diagnostic');
  if (diagCol && diagnosticActions) {
    columnValues[diagCol] = { text: diagnosticActions };
  }

  // Proposed Solution (long text)
  const propCol = colId('proposed solution');
  if (propCol && proposedSolution) {
    columnValues[propCol] = { text: proposedSolution };
  }

  // Materials List and Cost (long text)
  const matListCol = colId('materials list');
  if (matListCol && materialsText) {
    columnValues[matListCol] = { text: materialsText };
  }

  // Materials (Dollars) — numeric
  const matDollarCol = colId('materials (dollar') || colId('materials (dollar');
  if (matDollarCol && materialsTotal != null) {
    columnValues[matDollarCol] = { number: materialsTotal };
  }

  // Labor (Hours) — numeric
  const laborHoursCol = colId('labor (hour') || colId('labor');
  if (laborHoursCol && laborHours != null) {
    columnValues[laborHoursCol] = { number: laborHours };
  }

  // Total Cost
  const totalCostCol = colId('total cost');
  if (totalCostCol && grandTotal != null) {
    columnValues[totalCostCol] = { number: grandTotal };
  }

  // Completion Notes
  const completionCol = colId('completion note');
  if (completionCol && completionNotes) {
    columnValues[completionCol] = { text: completionNotes };
  }

  // Date Received — use submission date
  const dateReceivedCol = colId('date received') || colId('date');
  if (dateReceivedCol && date) {
    const d = new Date(date);
    const dateStr = d.toISOString().split('T')[0]; // YYYY-MM-DD
    columnValues[dateReceivedCol] = { date: dateStr };
  }

  // Technician — put in Maintenance Item or a text column if available
  const maintItemCol = colId('maintenance item');
  if (maintItemCol) {
    columnValues[maintItemCol] = { text: `${address} - ${techName}` };
  }

  // Escape column values for GraphQL
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
