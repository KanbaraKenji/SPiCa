// An MCP tool that hands files over inside its result (EmbeddedResource with a blob), for tests and trying it out
// with no real data: export_documents returns a made-up spec as a PDF and a parts list as an xlsx; with `bytes`, one
// file of that many bytes instead (the size limit). Served over a local program (node fake-mcp-files.mjs) or at a web
// address (fake-mcp-http.mjs with { files: true }, or node fake-mcp-http.mjs <era> <port> [key] --files).
import { createInterface } from 'node:readline';

export const FILES_TOOL = {
  name: 'export_documents',
  description: 'Export the spec sheet (PDF) and the parts list (Excel) of a product.',
  inputSchema: { type: 'object', properties: { product: { type: 'string' }, bytes: { type: 'integer' } }, required: ['product'] },
};

/** The tool's result for `args`. */
export async function exportDocuments(args) {
  const product = String(args?.product ?? 'DEMO-100').replace(/[^\w.-]/g, '_').slice(0, 40) || 'DEMO-100';
  if (Number.isInteger(args?.bytes) && args.bytes > 0) {
    const blob = Buffer.alloc(args.bytes, 0x20).toString('base64');
    return { content: [{ type: 'resource', resource: { uri: `file:///exports/${product}-archive.bin`, mimeType: 'application/octet-stream', blob } }] };
  }
  const [pdf, xlsx] = await Promise.all([specPdf(product), partsXlsx(product)]);
  return {
    content: [
      { type: 'text', text: `Exported 2 files for ${product}.` },
      { type: 'resource', resource: { uri: `file:///exports/${product}-spec.pdf`, mimeType: 'application/pdf', blob: pdf.toString('base64') } },
      {
        type: 'resource',
        resource: { uri: `file:///exports/${product}-BOM.xlsx`, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', blob: xlsx.toString('base64') },
      },
    ],
  };
}

async function specPdf(product) {
  const { PDFDocument, StandardFonts } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  const lines = [`${product} specification`, '', 'Input: 100-240 V AC, 50/60 Hz', 'Output: 12 V DC, 5 A', 'Size: 120 x 60 x 35 mm', 'Contact: alex.chen@example.com'];
  lines.forEach((l, i) => page.drawText(l, { x: 56, y: 770 - i * 22, size: i === 0 ? 18 : 12, font }));
  return Buffer.from(await doc.save());
}

async function partsXlsx(product) {
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('BOM');
  ws.addRow(['Part', 'Description', 'Qty']);
  ws.addRow([`${product}-C1`, 'Capacitor 100 uF', 2]);
  ws.addRow([`${product}-R1`, 'Resistor 10 kΩ', 4]);
  ws.addRow([`${product}-T1`, 'Transformer', 1]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// a local program: MCP over stdio (initialize, tools/list, tools/call)
if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/').replace(/^\//, '')}`) {
  const send = (m) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
  createInterface({ input: process.stdin }).on('line', async (line) => {
    const m = JSON.parse(line);
    if (m.id === undefined) return;
    if (m.method === 'initialize') return send({ id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake-files', version: '1.0.0' } } });
    if (m.method === 'tools/list') return send({ id: m.id, result: { tools: [FILES_TOOL] } });
    if (m.method === 'tools/call' && m.params?.name === FILES_TOOL.name) return send({ id: m.id, result: await exportDocuments(m.params.arguments) });
    return send({ id: m.id, error: { code: -32601, message: 'Method not found' } });
  });
}
