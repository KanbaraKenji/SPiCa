// The page's MCP commands (DesktopChannel.Mcp): the list is saved here, where values can be sealed, then handed to
// the backend in the clear (userMcpSet); what the page sees is the saved list (values masked) with how each service
// is doing in the backend (status, its tools, why it stopped, its last lines, what it would download).
import { downloadPreview, type McpProblemView, type McpCommand, type McpListView, type McpResult, type McpServerView } from '../../shared/mcp-servers';
import { McpServerStore, type McpServerConfig, type SavedMcpServer } from './store';

/** How a service is doing, as the backend says (UserMcpState of @spica/plugins). */
export interface McpState {
  name: string;
  status: McpServerView['status'];
  tools: string[];
  lastError?: string;
  logTail: string[];
  download?: { runner: 'npx' | 'uvx'; package: string; python: boolean; version?: string; bytes?: number };
  problem?: McpProblemView;
}

/** The backend's side (desktop-host userMcp* methods); the demo has its own. */
export interface McpBackend {
  set(list: McpServerConfig[]): Promise<McpState[]>;
  states(): Promise<McpState[]>;
  download(name: string): Promise<McpState[]>;
}

/** The saved list and how each is doing, for the page. Tools without the `<name>__` the model sees. */
export function mcpListView(saved: readonly SavedMcpServer[], states: readonly McpState[], taken: readonly string[]): McpListView {
  return {
    taken: [...taken],
    servers: saved.map((s) => {
      const st = states.find((x) => x.name === s.name);
      const status: McpServerView['status'] = !s.enabled ? 'off' : (st?.status ?? 'starting');
      return {
        name: s.name,
        ...(s.url ? { url: s.url, headers: (s.headers ?? []).map((h) => ({ name: h.name, mask: McpServerStore.mask(h) })), ...(s.key ? { key: McpServerStore.mask(s.key) } : {}) } : {}),
        command: s.command,
        args: [...s.args],
        env: s.env.map((e) => ({ name: e.name, mask: McpServerStore.mask(e) })),
        ...(s.cwd ? { cwd: s.cwd } : {}),
        enabled: s.enabled,
        approval: s.approval,
        status,
        tools: s.enabled ? (st?.tools ?? []).map((n) => (n.startsWith(`${s.name}__`) ? n.slice(s.name.length + 2) : n)) : [],
        ...(s.enabled && st?.lastError ? { lastError: st.lastError } : {}),
        ...(status === 'failed' && st?.problem ? { problem: st.problem } : {}),
        ...(s.enabled && st?.logTail.length ? { logTail: [...st.logTail] } : {}),
        ...(status === 'needs-download' && st?.download ? { download: downloadPreview(st.download) } : {}),
      };
    }),
  };
}

export interface McpServiceDeps {
  store: McpServerStore;
  backend: McpBackend;
  /** Names a new service cannot take: the plugins' servers. */
  taken(): Promise<string[]>;
}

export async function runMcp(cmd: McpCommand, d: McpServiceDeps): Promise<McpResult> {
  const push = () => d.backend.set(d.store.configs());
  let states: McpState[];
  let errors: McpResult['errors'];
  switch (cmd.op) {
    case 'save': {
      errors = d.store.save(cmd.was, cmd.draft, await d.taken());
      states = Object.keys(errors).length ? await d.backend.states() : await push();
      break;
    }
    case 'remove':
      d.store.remove(cmd.name);
      states = await push();
      break;
    case 'setEnabled':
      d.store.update(cmd.name, { enabled: cmd.on });
      states = await push();
      break;
    case 'setApproval':
      d.store.update(cmd.name, { approval: cmd.approval });
      states = await push();
      break;
    case 'download':
      states = await d.backend.download(cmd.name);
      break;
    default:
      states = await d.backend.states();
  }
  const list = mcpListView(d.store.list(), states, await d.taken());
  return errors && Object.keys(errors).length ? { list, errors } : { list };
}
