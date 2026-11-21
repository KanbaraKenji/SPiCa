// Sample MCP services for the fake backend (screenshots, layout drafts): kept in memory, nothing runs.
import { draftArgs, type McpServerView } from '../../../shared/mcp-servers';
import type { McpApi, McpList } from './McpServers';

export function demoMcpApi(start: 'some' | 'none' = 'some'): McpApi {
  let servers: McpServerView[] =
    start === 'none'
      ? []
      : [
          {
            name: 'files',
            command: 'npx',
            args: ['-y', '@example/files-server', 'D:\\Shared Files'],
            env: [],
            enabled: true,
            approval: 'ask',
            status: 'running',
            tools: ['read_file', 'list_directory', 'search_files', 'get_file_info'],
          },
          {
            name: 'notes',
            command: 'uvx',
            args: ['example-notes', '--db', 'D:\\Notes\\notes.db'],
            env: [{ name: 'NOTES_TOKEN', mask: 'nt-****-8f2c' }],
            enabled: true,
            approval: 'ask',
            status: 'failed',
            tools: [],
            lastError: 'MCP server "notes" exited (code 1)',
            problem: { kind: 'exited', code: 1 },
            logTail: ['Traceback (most recent call last):', '  File "server.py", line 12, in <module>', '    db = open_database(args.db)', 'FileNotFoundError: D:\\Notes\\notes.db'],
          },
          {
            name: 'docs',
            command: 'npx',
            args: ['-y', '@example/docs-server'],
            env: [],
            enabled: true,
            approval: 'ask',
            status: 'needs-download',
            tools: [],
            download: { packages: [{ name: '@example/docs-server' }], packageHost: 'registry.npmjs.org' },
          },
          {
            name: 'weather',
            command: 'node',
            args: ['D:\\Tools\\weather\\server.js'],
            env: [{ name: 'WEATHER_KEY', mask: 'wk-****-31ad' }],
            cwd: 'D:\\Tools\\weather',
            enabled: false,
            approval: 'auto',
            status: 'off',
            tools: ['get_forecast', 'get_alerts'],
          },
        ];
  const listeners = new Set<() => void>();
  const changed = () => listeners.forEach((l) => l());
  const list = async (): Promise<McpList> => ({ servers, taken: ['mail'] });
  return {
    list,
    async save(was, d) {
      const web = d.kind === 'url';
      const s: McpServerView = {
        name: d.name.trim(),
        ...(web ? { url: d.url.trim(), headers: d.headers.filter((h) => h.name.trim()).map((h) => ({ name: h.name.trim(), mask: '****' })), ...(d.key.trim() || d.keySaved ? { key: '****' } : {}) } : {}),
        command: web ? '' : d.command.trim(),
        args: web ? [] : draftArgs(d),
        env: web ? [] : d.env.filter((e) => e.name.trim()).map((e) => ({ name: e.name.trim(), mask: '****' })),
        ...(d.cwd.trim() && !web ? { cwd: d.cwd.trim() } : {}),
        enabled: true,
        approval: d.approval,
        status: 'starting',
        tools: [],
      };
      servers = was === null ? [...servers, s] : servers.map((x) => (x.name === was ? s : x));
      changed();
      return {};
    },
    async remove(name) {
      servers = servers.filter((s) => s.name !== name);
      changed();
    },
    async setEnabled(name, on) {
      servers = servers.map((s) => (s.name === name ? { ...s, enabled: on, status: on ? 'running' : 'off' } : s));
      changed();
    },
    async download(name) {
      servers = servers.map((s) => (s.name === name ? { ...s, status: 'downloading' } : s));
      changed();
    },
    async setApproval(name, approval) {
      servers = servers.map((s) => (s.name === name ? { ...s, approval } : s));
      changed();
    },
    onChanged(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    pickFolder: async () => 'D:\\Projects\\example',
  };
}
