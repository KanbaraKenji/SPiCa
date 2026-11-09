// Example MCP server for the Notes plugin. Speaks MCP over stdio
// (newline-delimited JSON-RPC 2.0) with no dependencies, so the package needs
// no node_modules. Real plugins may use the official MCP SDK instead.
//
// Environment set by Spica:
//   SPICA_PLUGIN_DATA  folder this plugin may write to (notes live in notes/)
//   SPICA_PLUGIN_DIR   the installed plugin folder (read-only)
//   SPICA_MOCK         "1" when global mock mode is on
// Optional:
//   CATALOG_URL        base URL of a real catalog service (GET ?q=...)
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const dataDir = process.env.SPICA_PLUGIN_DATA || join(process.cwd(), '.data');
const pluginDir = process.env.SPICA_PLUGIN_DIR || process.cwd();
const notesDir = join(dataDir, 'notes');
const mock = process.env.SPICA_MOCK === '1';

const tools = [
  {
    name: 'list_notes',
    description: 'List the notes in the local notebook (title and size).',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'read_note',
    description: 'Read one note by title.',
    inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'write_note',
    description: 'Create a note, or append to it when it exists (set replace to overwrite).',
    inputSchema: {
      type: 'object',
      properties: { title: { type: 'string' }, text: { type: 'string' }, replace: { type: 'boolean' } },
      required: ['title', 'text'],
    },
  },
  {
    name: 'delete_note',
    description: 'Delete a note by title. Cannot be undone.',
    inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
  },
  {
    name: 'search_catalog',
    description: 'Search the sample catalog of books by title, author or shelf.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    annotations: { readOnlyHint: true },
  },
];

/** Note titles become file names: keep them plain. */
function noteFile(title) {
  const t = String(title ?? '').trim();
  if (!t || t.length > 80 || !/^[\p{L}\p{N} _.,()-]+$/u.test(t) || t.startsWith('.')) {
    throw new Error('A note title may use letters, digits, spaces and _ . , ( ) - (up to 80 characters).');
  }
  return join(notesDir, `${t}.md`);
}

async function listNotes() {
  await mkdir(notesDir, { recursive: true });
  const files = (await readdir(notesDir)).filter((f) => f.endsWith('.md')).sort();
  if (files.length === 0) return 'The notebook is empty.';
  const lines = [];
  for (const f of files) {
    const text = await readFile(join(notesDir, f), 'utf8');
    lines.push(`- ${f.slice(0, -3)} (${text.length} characters)`);
  }
  return lines.join('\n');
}

async function searchCatalog(query) {
  const q = String(query ?? '').toLowerCase().trim();
  if (mock) {
    const rows = JSON.parse(await readFile(join(pluginDir, 'mock', 'catalog.json'), 'utf8'));
    const hits = rows.filter((r) => [r.title, r.author, r.shelf].some((v) => v.toLowerCase().includes(q)));
    const body = hits.length
      ? hits.map((r) => `${r.id} · ${r.title} — ${r.author} (${r.year}, ${r.shelf}) ${r.available ? 'available' : 'on loan'}`).join('\n')
      : `No sample entries match "${query}".`;
    return { text: `[sample data — mock mode]\n${body}` };
  }
  const base = process.env.CATALOG_URL;
  if (!base) {
    return {
      text: 'The catalog service is not configured on this computer. Turn on mock mode in Spica to use the sample data.',
      isError: true,
    };
  }
  const res = await fetch(`${base}?q=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return { text: `The catalog service answered HTTP ${res.status}.`, isError: true };
  return { text: await res.text() };
}

async function call(name, args) {
  switch (name) {
    case 'list_notes':
      return { text: await listNotes() };
    case 'read_note': {
      try {
        return { text: await readFile(noteFile(args.title), 'utf8') };
      } catch (err) {
        if (err.code === 'ENOENT') return { text: `No note titled "${args.title}".`, isError: true };
        throw err;
      }
    }
    case 'write_note': {
      const file = noteFile(args.title);
      await mkdir(notesDir, { recursive: true });
      let before = '';
      if (!args.replace) before = await readFile(file, 'utf8').catch(() => '');
      const text = before ? `${before.trimEnd()}\n\n${args.text}\n` : `${args.text}\n`;
      await writeFile(file, text);
      return { text: `${before ? 'Appended to' : 'Saved'} note "${args.title}".` };
    }
    case 'delete_note': {
      const file = noteFile(args.title);
      try {
        await readFile(file);
      } catch {
        return { text: `No note titled "${args.title}".`, isError: true };
      }
      await rm(file);
      return { text: `Deleted note "${args.title}".` };
    }
    case 'search_catalog':
      return searchCatalog(args.query);
    default:
      return null;
  }
}

const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);

createInterface({ input: process.stdin }).on('line', async (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id === undefined) return; // notifications need no answer
  try {
    switch (msg.method) {
      case 'initialize':
        return send({
          id: msg.id,
          result: {
            protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'spica-example-notes', version: '0.1.0' },
          },
        });
      case 'ping':
        return send({ id: msg.id, result: {} });
      case 'tools/list':
        return send({ id: msg.id, result: { tools } });
      case 'tools/call': {
        const r = await call(msg.params?.name, msg.params?.arguments ?? {});
        if (!r) return send({ id: msg.id, error: { code: -32602, message: `Unknown tool: ${msg.params?.name}` } });
        return send({ id: msg.id, result: { content: [{ type: 'text', text: r.text }], isError: !!r.isError } });
      }
      default:
        return send({ id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
    }
  } catch (err) {
    // Tool failures go back to the model as error results, not protocol errors.
    return send({ id: msg.id, result: { content: [{ type: 'text', text: String(err?.message ?? err) }], isError: true } });
  }
});

process.stderr.write(`notes server ready (mock ${mock ? 'on' : 'off'})\n`);
