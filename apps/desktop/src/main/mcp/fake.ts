// The demo backend's MCP services (SPICA_BACKEND=fake: screenshots, a look without the core): three sample services
// saved on first start (nothing real in them), each in a fixed state; nothing runs. A service added in the demo is
// 'running' with no tools; 下载 makes a waiting one 'downloading', then 'running'.
import type { McpServerDraft } from '../../shared/mcp-servers';
import type { McpBackend, McpState } from './service';
import type { McpServerStore } from './store';

const SAMPLES: (McpServerDraft & { enabled: boolean })[] = [
  { name: 'files', command: 'npx', args: '-y\n@example/files-server\nD:\\Shared Files', env: [], cwd: '', approval: 'ask', enabled: true },
  { name: 'notes', command: 'uvx', args: 'example-notes\n--db\nD:\\Notes\\notes.db', env: [{ name: 'NOTES_TOKEN', value: 'nt-demo-0000-0000-0000-8f2c' }], cwd: '', approval: 'ask', enabled: true },
  { name: 'docs', command: 'npx', args: '-y\n@example/docs-server', env: [], cwd: '', approval: 'ask', enabled: true },
  { name: 'weather', command: 'node', args: 'D:\\Tools\\weather\\server.js', env: [{ name: 'WEATHER_KEY', value: 'wk-demo-0000-0000-0000-31ad' }], cwd: 'D:\\Tools\\weather', approval: 'auto', enabled: false },
];

const STATES: Record<string, Omit<McpState, 'name'>> = {
  files: { status: 'running', tools: ['files__read_file', 'files__list_directory', 'files__search_files', 'files__get_file_info'], logTail: [] },
  notes: {
    status: 'failed',
    tools: [],
    lastError: 'MCP server "notes" exited (code 1)',
    problem: { kind: 'exited', code: 1 },
    logTail: ['Traceback (most recent call last):', '  File "server.py", line 12, in <module>', '    db = open_database(args.db)', 'FileNotFoundError: D:\\Notes\\notes.db'],
  },
  docs: { status: 'needs-download', tools: [], logTail: [], download: { runner: 'npx', package: '@example/docs-server', python: false, version: '2.1.0', bytes: 1_843_200 } },
  weather: { status: 'running', tools: ['weather__get_forecast', 'weather__get_alerts'], logTail: [] },
};

/** Saves the samples when the demo's list is empty (a fresh settings folder). */
export function seedDemoMcp(store: McpServerStore): void {
  if (store.list().length) return;
  for (const s of SAMPLES) {
    store.save(null, s, []);
    if (!s.enabled) store.update(s.name, { enabled: false });
  }
}

export class FakeMcpBackend implements McpBackend {
  #names: string[] = [];
  readonly #downloaded = new Set<string>();
  readonly #downloading = new Set<string>();
  readonly #changed: () => void;

  constructor(changed: () => void) {
    this.#changed = changed;
  }

  #states(): McpState[] {
    return this.#names.map((name) => {
      const s = STATES[name];
      if (s?.status === 'needs-download' && this.#downloaded.has(name)) return { name, status: 'running', tools: [`${name}__fetch`], logTail: [] };
      if (s?.status === 'needs-download' && this.#downloading.has(name)) return { name, status: 'downloading', tools: [], logTail: [] };
      return { name, ...(s ?? { status: 'running', tools: [], logTail: [] }) };
    });
  }

  async set(list: { name: string }[]): Promise<McpState[]> {
    this.#names = list.map((s) => s.name);
    return this.#states();
  }

  async states(): Promise<McpState[]> {
    return this.#states();
  }

  async download(name: string): Promise<McpState[]> {
    this.#downloading.add(name);
    setTimeout(() => {
      this.#downloading.delete(name);
      this.#downloaded.add(name);
      this.#changed();
    }, 1500);
    return this.#states();
  }
}
