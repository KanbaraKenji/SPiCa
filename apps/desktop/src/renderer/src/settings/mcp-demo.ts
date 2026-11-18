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
            lastError: '进程已退出（代码 1）',
            logTail: ['Traceback (most recent call last):', '  File "server.py", line 12, in <module>', '    db = open_database(args.db)', 'FileNotFoundError: D:\\Notes\\notes.db'],
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
      const s: McpServerView = {
        name: d.name.trim(),
        command: d.command.trim(),
        args: draftArgs(d),
        env: d.env.filter((e) => e.name.trim()).map((e) => ({ name: e.name.trim(), mask: '****' })),
        ...(d.cwd.trim() ? { cwd: d.cwd.trim() } : {}),
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
