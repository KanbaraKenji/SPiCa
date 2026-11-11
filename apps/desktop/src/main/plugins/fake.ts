// A plugin service with a fixed example, for screenshots, tests and
// SPICA_BACKEND=fake. No Node imports, so renderer tests can use it.
import { svgDataUrl, type PluginsCommand, type PluginsResult, type PluginsState, type PluginView } from '../../shared/plugins';
import type { PluginService } from './types';

/** plugins/example-notes/icon.svg: the demo's example has its own icon, the others the letter badge. */
const EXAMPLE_ICON = svgDataUrl(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="6" fill="#f2b632"/><path d="M7 3.5h8l3 3V20H7z" fill="#fff8e6"/><path d="M15 3.5v3h3" fill="none" stroke="#c98a12" stroke-width="1.2" stroke-linejoin="round"/><path d="M9.5 11h6M9.5 14h6M9.5 17h4" fill="none" stroke="#a36f0a" stroke-width="1.4" stroke-linecap="round"/></svg>',
);

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
  model: { reason: '把一篇长笔记缩成几句话时，要用模型。', maxUsdPerDay: 0.2, declaredMaxUsdPerDay: 0.2, spentTodayUsd: 0.03 },
  icon: EXAMPLE_ICON,
};

/** The example without what is its own (model use, icon): the base of the other demo plugins. */
function asOtherDemo(p: PluginView): PluginView {
  const { model: _model, icon: _icon, ...rest } = p;
  void _model;
  void _icon;
  return rest;
}

/** Ten more made-up plugins (SPICA_DEMO_PLUGINS=many): a page of twelve for screenshots, some off, one with an update, one with a problem. */
const MORE: [string, string, string, boolean][] = [
  ['quote-check', '报价单核对', '按供应商价目表核对报价单。', true],
  ['contract-review', '合同审阅', '标出合同里的付款与违约条款。', true],
  ['minutes', '会议纪要', '从录音文字整理纪要。', true],
  ['drawing-diff', '图纸比对', '比较两版图纸的尺寸差异。', true],
  ['erp', 'ERP 查询', '查库存、订单和物料。', true],
  ['calendar', '日程', 'Outlook 日历。', false],
  ['translate', '翻译', '中英日互译。', true],
  ['web-fetch', '网页抓取', '抓取网页正文。', false],
  ['file-search', '文件检索', '在共享盘里按内容找文件。', true],
  ['expenses', '报销助手', '整理发票，填报销单。', true],
];

function morePlugins(): PluginView[] {
  return MORE.map(([name, displayName, description, enabled]) => {
    const tools = enabled ? ['search', 'read'] : [];
    return {
      ...asOtherDemo(structuredClone(EXAMPLE)),
      name,
      displayName,
      description,
      version: '1.0.0',
      previousVersion: undefined,
      enabled,
      tools,
      skills: [],
      commands: [],
      servers: [{ id: name, status: name === 'drawing-diff' ? 'failed' : enabled ? 'running' : 'stopped', tools, ...(name === 'drawing-diff' ? { lastError: '「drawing-diff」启动失败：找不到 dwgread.exe' } : {}) }],
      ...(name === 'quote-check' ? { update: '1.1.0' } : {}),
    } as PluginView;
  });
}

export class FakePluginService implements PluginService {
  #plugins: PluginView[] = [structuredClone(EXAMPLE), { ...asOtherDemo(structuredClone(EXAMPLE)), name: 'mail-digest', displayName: '来信摘要（示例）', description: '把收件箱里的新邮件整理成摘要，按项目归类。', version: '1.0.0', enabled: true, mail: true, tools: ['list_messages', 'read_message'], skills: [], commands: [], servers: [{ id: 'mail', status: 'running', tools: ['list_messages', 'read_message'] }], previousVersion: undefined, update: '1.1.0' } as PluginView];
  #mock = false;
  readonly #root: string;

  /** `many`: twelve plugins instead of two (screenshots of a full page). */
  constructor(root: string, opts: { many?: boolean } = {}) {
    this.#root = root;
    if (opts.many) this.#plugins.push(...morePlugins());
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
          // The demo's mail plugin is a mail source only while it is on.
          if (p.name === 'mail-digest') p.mail = p.enabled;
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
      case 'modelLimit':
        if (p?.model) {
          const v = cmd.maxUsdPerDay;
          if (v === null) {
            delete p.model.userMaxUsdPerDay;
            p.model.maxUsdPerDay = p.model.declaredMaxUsdPerDay;
          } else {
            p.model.userMaxUsdPerDay = v;
            p.model.maxUsdPerDay = Math.min(v, p.model.declaredMaxUsdPerDay);
          }
        }
        break;
      default:
        break;
    }
    return { ok: true, state: this.#state() };
  }
}
