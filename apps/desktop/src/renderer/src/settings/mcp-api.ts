// The page's McpApi over the bridge (DesktopChannel.Mcp). The list is read again after each change the page makes,
// and whenever the main process says a service changed state on its own (started, crashed, downloaded).
import type { DesktopBridge } from '../../../shared/bridge';
import type { McpApi } from './McpServers';

export function mcpApiOf(mcp: DesktopBridge['mcp'], pickFolder?: () => Promise<string | null>): McpApi {
  const listeners = new Set<() => void>();
  const changed = () => listeners.forEach((l) => l());
  const done = async (p: Promise<unknown>) => {
    await p;
    changed();
  };
  return {
    list: async () => (await mcp.run({ op: 'list' })).list,
    save: async (was, draft) => {
      const r = await mcp.run({ op: 'save', was, draft });
      if (!r.errors) changed();
      return r.errors ?? {};
    },
    remove: (name) => done(mcp.run({ op: 'remove', name })),
    setEnabled: (name, on) => done(mcp.run({ op: 'setEnabled', name, on })),
    setApproval: (name, approval) => done(mcp.run({ op: 'setApproval', name, approval })),
    download: (name) => done(mcp.run({ op: 'download', name })),
    onChanged(listener) {
      listeners.add(listener);
      const off = mcp.onChanged(listener);
      return () => {
        listeners.delete(listener);
        off();
      };
    },
    ...(pickFolder ? { pickFolder } : {}),
  };
}
