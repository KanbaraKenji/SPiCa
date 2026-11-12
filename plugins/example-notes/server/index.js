// Example MCP server for the Notes plugin. Speaks MCP over stdio
// (newline-delimited JSON-RPC 2.0) with no dependencies, so the package needs
// no node_modules. Real plugins may use the official MCP SDK instead.
//
// Environment set by Spica:
//   SPICA_PLUGIN_DATA  folder this plugin may write to (notes live in notes/ unless the user chose a folder)
//   SPICA_PLUGIN_DIR   the installed plugin folder (read-only)
//   SPICA_MOCK         "1" when global mock mode is on
//   SPICA_USER_ACCOUNT the user's account (e.g. ALEX.CHEN): signs each entry. Read it, never work it out
// Settings live in <SPICA_PLUGIN_DATA>/config.json (installed plugins get no
// environment variables of their own):
//   { "catalogUrl": "https://catalog.example.test/search" }  real catalog service (GET ?q=...)
//   { "notesFolder": "D:\\Notes" }  where the notes are kept (chosen on the settings page)
// The settings page (views/settings.json) saves this file through the plugin's
// settings service (server/settings.js); it is read again on every call.
//
// summarize_note uses the model the user has set up in Spica (MCP sampling,
// manifest permissions.model): the plugin needs no key, and Spica counts the
// cost against the plugin's daily limit.
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';

const dataDir = process.env.SPICA_PLUGIN_DATA || join(process.cwd(), '.data');
const pluginDir = process.env.SPICA_PLUGIN_DIR || process.cwd();
const mock = process.env.SPICA_MOCK === '1';
const account = process.env.SPICA_USER_ACCOUNT || '';

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
    name: 'summarize_note',
    description: 'Summarize one note in two or three sentences, using the model set up in Spica.',
    inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'search_catalog',
    description: 'Search the sample catalog of books by title, author or shelf.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    annotations: { readOnlyHint: true },
  },
];

const readConfig = () => readFile(join(dataDir, 'config.json'), 'utf8').then(JSON.parse, () => ({}));

/** The folder the user chose on the settings page, else notes/ in the plugin's data folder. */
async function notesDir() {
  const f = (await readConfig()).notesFolder;
  return typeof f === 'string' && isAbsolute(f) ? f : join(dataDir, 'notes');
}

/** Note titles become file names: keep them plain. */
async function noteFile(title) {
  const t = String(title ?? '').trim();
  if (!t || t.length > 80 || !/^[\p{L}\p{N} _.,()-]+$/u.test(t) || t.startsWith('.')) {
    throw new Error('A note title may use letters, digits, spaces and _ . , ( ) - (up to 80 characters).');
  }
  return join(await notesDir(), `${t}.md`);
}

async function listNotes() {
  const dir = await notesDir();
  await mkdir(dir, { recursive: true });
  const files = (await readdir(dir)).filter((f) => f.endsWith('.md')).sort();
  if (files.length === 0) return 'The notebook is empty.';
  const lines = [];
  for (const f of files) {
    const text = await readFile(join(dir, f), 'utf8');
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
  const base = (await readConfig()).catalogUrl;
  if (!base) {
    return {
      text: 'The catalog service is not configured on this computer (catalogUrl in config.json). Turn on mock mode in Spica to use the sample data.',
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
        return { text: await readFile(await noteFile(args.title), 'utf8') };
      } catch (err) {
        if (err.code === 'ENOENT') return { text: `No note titled "${args.title}".`, isError: true };
        throw err;
      }
    }
    case 'write_note': {
      const file = await noteFile(args.title);
      await mkdir(await notesDir(), { recursive: true });
      let before = '';
      if (!args.replace) before = await readFile(file, 'utf8').catch(() => '');
      // Each entry signed with the user's account (none when Spica has none).
      const entry = account ? `${args.text}\n\n— ${account}` : args.text;
      const text = before ? `${before.trimEnd()}\n\n${entry}\n` : `${entry}\n`;
      await writeFile(file, text);
      return { text: `${before ? 'Appended to' : 'Saved'} note "${args.title}".` };
    }
    case 'delete_note': {
      const file = await noteFile(args.title);
      try {
        await readFile(file);
      } catch {
        return { text: `No note titled "${args.title}".`, isError: true };
      }
      await rm(file);
      return { text: `Deleted note "${args.title}".` };
    }
    case 'summarize_note':
      return summarizeNote(args.title);
    case 'search_catalog':
      return searchCatalog(args.query);
    default:
      return null;
  }
}

const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);

// ---- asking Spica for a model answer (MCP sampling) ----
// Spica offers capabilities.sampling in initialize only to plugins whose
// manifest has permissions.model. A refusal is a JSON-RPC error -32000 whose
// data.code says why.
let canSample = false;
let nextId = 1;
const pending = new Map();

function createMessage(params) {
  const id = `s${nextId++}`;
  send({ id, method: 'sampling/createMessage', params });
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

const REFUSALS = {
  no_model: 'No model is set up in Spica yet. Add one under Settings › Models.',
  model_not_configured: 'The model this plugin asked for is not set up in Spica.',
  budget: "This plugin has used up today's model budget. Raise its limit on the plugin page, or try tomorrow.",
  rate_limited: 'Too many model requests at once. Try again in a minute.',
};

async function summarizeNote(title) {
  let text;
  try {
    text = await readFile(await noteFile(title), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { text: `No note titled "${title}".`, isError: true };
    throw err;
  }
  if (!canSample) return { text: 'This Spica does not let the plugin use a model.', isError: true };
  try {
    const r = await createMessage({
      systemPrompt: 'You summarize notes. Answer with the summary only.',
      messages: [{ role: 'user', content: { type: 'text', text: `Summarize this note in two or three sentences:\n\n${text.slice(0, 8000)}` } }],
      maxTokens: 300,
      modelPreferences: { intelligencePriority: 0.2 },
    });
    const summary = Array.isArray(r.content) ? r.content.map((c) => c.text ?? '').join('') : (r.content?.text ?? '');
    return { text: `${summary.trim()}\n\n(model: ${r.model})` };
  } catch (err) {
    return { text: REFUSALS[err.data?.code] ?? `The model did not answer: ${err.message}`, isError: true };
  }
}

createInterface({ input: process.stdin }).on('line', async (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id === undefined) return; // notifications need no answer
  if (msg.method === undefined) {
    // an answer to one of our requests (sampling/createMessage)
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (p && msg.error) p.reject(Object.assign(new Error(msg.error.message), { data: msg.error.data }));
    else p?.resolve(msg.result);
    return;
  }
  try {
    switch (msg.method) {
      case 'initialize':
        canSample = Boolean(msg.params?.capabilities?.sampling);
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
