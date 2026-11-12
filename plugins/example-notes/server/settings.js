// The Notes plugin's settings, for its settings page (views/settings.json,
// placement "settings": shown in Spica under 设置 › 插件 › Notes). A service
// (services/settings.json): its tools are not offered to the model, only to the
// plugin's own pages, so the model cannot change where notes are kept.
//
// <SPICA_PLUGIN_DATA>/config.json
//   { "notesFolder": "D:\\Notes", "catalogUrl": "https://catalog.example.test/search" }
// server/index.js reads the same file on every call.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';

const dataDir = process.env.SPICA_PLUGIN_DATA || join(process.cwd(), '.data');
const file = join(dataDir, 'config.json');
const read = () => readFile(file, 'utf8').then(JSON.parse, () => ({}));

const tools = [
  {
    name: 'get_settings',
    description: 'The settings as saved: notes folder (empty: the default one) and catalog address.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'save_settings',
    description: 'Save the notes folder (an absolute path, or empty for the default) and the catalog address.',
    inputSchema: { type: 'object', properties: { notesFolder: { type: 'string' }, catalogUrl: { type: 'string' } } },
  },
];

async function getSettings() {
  const c = await read();
  return { notesFolder: c.notesFolder ?? '', defaultFolder: join(dataDir, 'notes'), catalogUrl: c.catalogUrl ?? '' };
}

async function saveSettings({ notesFolder, catalogUrl }) {
  const c = await read();
  if (typeof notesFolder === 'string') {
    const f = notesFolder.trim();
    if (f && !isAbsolute(f)) return { error: 'The notes folder must be a full path, such as D:\\Notes.' };
    if (f) c.notesFolder = f;
    else delete c.notesFolder;
  }
  if (typeof catalogUrl === 'string') {
    const u = catalogUrl.trim();
    if (u && !/^https?:\/\//i.test(u)) return { error: 'The catalog address must start with http:// or https://.' };
    if (u) c.catalogUrl = u;
    else delete c.catalogUrl;
  }
  await mkdir(dataDir, { recursive: true });
  await writeFile(`${file}.tmp`, JSON.stringify(c, null, 1));
  await rename(`${file}.tmp`, file);
  return getSettings();
}

const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
const result = (id, value) => {
  const isError = Boolean(value?.error);
  send({ id, result: { content: [{ type: 'text', text: isError ? value.error : JSON.stringify(value) }], isError } });
};

createInterface({ input: process.stdin }).on('line', async (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id === undefined || msg.method === undefined) return;
  try {
    switch (msg.method) {
      case 'initialize':
        return send({
          id: msg.id,
          result: { protocolVersion: msg.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'spica-example-notes-settings', version: '0.1.0' } },
        });
      case 'ping':
        return send({ id: msg.id, result: {} });
      case 'tools/list':
        return send({ id: msg.id, result: { tools } });
      case 'tools/call': {
        const name = msg.params?.name;
        const args = msg.params?.arguments ?? {};
        if (name === 'get_settings') return result(msg.id, await getSettings());
        if (name === 'save_settings') return result(msg.id, await saveSettings(args));
        return send({ id: msg.id, error: { code: -32602, message: `Unknown tool: ${name}` } });
      }
      default:
        return send({ id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
    }
  } catch (err) {
    return send({ id: msg.id, result: { content: [{ type: 'text', text: String(err?.message ?? err) }], isError: true } });
  }
});

process.stderr.write('notes settings service ready\n');
