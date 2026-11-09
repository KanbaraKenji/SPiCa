// A plugin service with a fixed example, for screenshots, tests and
// SPICA_BACKEND=fake. No Node imports, so renderer tests can use it.
import type { PluginsCommand, PluginsResult, PluginsState, PluginView } from '../../shared/plugins';
import type { PluginService } from './types';

const EXAMPLE: PluginView = {
  name: 'notes',
  displayName: '笔记（示例）',
  description: '在本地笔记本里记笔记，并从一个虚构的样例目录里查东西。展示插件的每个部分。',
  version: '0.2.0',
  previousVersion: '0.1.0',
  enabled: true,
  source: { kind: 'share', location: '\\\\fileserver\\spica-plugins' },
  mockSupported: true,
  skills: [{ id: 'note-taking', name: '记笔记', description: '把对话里的要点整理成笔记' }],
  commands: [{ id: 'note', description: '把一句话记进笔记本' }],
  tools: ['add_note', 'list_notes', 'delete_note', 'catalog_lookup'],
  servers: [{ id: 'notes-server', status: 'running', tools: ['add_note', 'list_notes', 'delete_note', 'catalog_lookup'] }],
  issues: [],
};

export class FakePluginService implements PluginService {
  #plugins: PluginView[] = [structuredClone(EXAMPLE), { ...structuredClone(EXAMPLE), name: 'mail-digest', displayName: '来信摘要（示例）', description: '把收件箱里的新邮件整理成摘要，按项目归类。', version: '1.0.0', enabled: false, tools: [], skills: [], commands: [], servers: [{ id: 'mail', status: 'stopped', tools: [] }], previousVersion: undefined, update: '1.1.0' } as PluginView];
  #mock = false;
  readonly #root: string;

  constructor(root: string) {
    this.#root = root;
  }

  onChange(): () => void {
    return () => {};
  }

  async start(): Promise<void> {}

  async dispose(): Promise<void> {}

  #state(): PluginsState {
    return { plugins: structuredClone(this.#plugins), mock: this.#mock, root: this.#root };
  }

  async run(cmd: PluginsCommand): Promise<PluginsResult> {
    const p = 'name' in cmd ? this.#plugins.find((x) => x.name === cmd.name) : undefined;
    switch (cmd.op) {
      case 'enable':
      case 'disable':
        if (p) {
          p.enabled = cmd.op === 'enable';
          p.tools = p.enabled ? p.servers.flatMap((s) => s.tools) : [];
          for (const s of p.servers) s.status = p.enabled ? 'running' : 'stopped';
        }
        break;
      case 'mock':
        this.#mock = cmd.on;
        break;
      case 'uninstall':
        this.#plugins = this.#plugins.filter((x) => x.name !== cmd.name);
        break;
      case 'install':
        return { ok: false, message: '演示数据里不能安装插件。', state: this.#state() };
      default:
        break;
    }
    return { ok: true, state: this.#state() };
  }
}
