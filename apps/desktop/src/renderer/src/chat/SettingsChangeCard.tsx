// A model setting changed by a script connected to the app (the core's MCP
// tools), shown in the conversation so it cannot go unnoticed. Drawn from the note's
// meta.settingsChange, never from its text; it stays in the history.
import type { SettingsChangeMeta } from '@spica/protocol';
import { Icon } from '../ui/Icon';
import { timeOf } from './format';

const KIND: Record<SettingsChangeMeta['kind'], string> = { 'openai-compatible': 'OpenAI 兼容', anthropic: 'Anthropic', wso2: '公司网关（WSO2）' };

/** Field names the core reports, as the settings page labels them. */
function fieldLabel(field: string, kind: SettingsChangeMeta['kind']): string | null {
  switch (field) {
    case 'name':
      return '名称';
    case 'kind':
      return '类型';
    case 'baseUrl':
      return kind === 'wso2' ? '网关地址' : '接口地址';
    case 'tokenUrl':
      return '取 token 地址';
    case 'clientId':
    case 'consumerKey':
      return 'Consumer Key';
    case 'secret':
    case 'consumerSecret':
    case 'apiKey':
      return kind === 'wso2' ? 'Consumer Secret' : 'API Key';
    case 'scope':
      return 'Scope';
    case 'model':
      return '模型';
    case 'strongModel':
      return '强模型';
    case 'contextWindow':
      return '上下文上限';
    case 'maxConcurrent':
      return '同时请求';
    case 'requestsPerMinute':
      return '每分钟请求';
    case 'default':
      return '默认模型';
    default:
      return null;
  }
}

export function settingsChangeTitle(c: SettingsChangeMeta): string {
  if (c.action === 'set_default_model') return `本机脚本将默认模型设为「${c.name} · ${c.model ?? ''}」`;
  if (c.action === 'set_strong_model') return c.model ? `本机脚本将强模型设为「${c.name} · ${c.model}」` : '本机脚本清除了强模型';
  if (c.action === 'add_connection') return `本机脚本添加了服务商「${c.name}」`;
  return `本机脚本修改了服务商「${c.name}」`;
}

type Pointer = { connectionId: string; model: string } | null;

/** A pointer as people read it: the model, and the connection when it is another one. */
function pointerText(p: Pointer, c: SettingsChangeMeta): string {
  if (!p) return '无';
  return p.connectionId === c.id ? `「${c.name} · ${p.model}」` : `「${p.model}」（其他服务商）`;
}

const windowText = (m: { contextWindow: number | null; contextFrom: string }) =>
  `${m.contextWindow ? `${m.contextWindow.toLocaleString('en-US')} token` : '未设置'}${m.contextFrom === 'name-match' ? '（按名称匹配）' : ''}`;

/** The rows the card lists: everything for a new connection, only what changed otherwise; moved pointers always. */
export function settingsChangeRows(c: SettingsChangeMeta): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = [];
  const all = c.action === 'add_connection';
  const changed = new Set(c.changes);
  const add = (field: string, value: string | null | undefined, show = all || changed.has(field)) => {
    const label = fieldLabel(field, c.kind);
    if (label && show && value !== undefined && value !== null && value !== '') rows.push({ label, value });
  };
  if (c.action === 'add_connection' || c.action === 'change_connection') {
    add('kind', KIND[c.kind]);
    add('baseUrl', c.baseUrl);
    add('tokenUrl', c.tokenUrl);
    // Masked by the core (keyMaskText, e.g. fa8x****8c21); records from before carry 「…8c21」.
    add('consumerKey', c.consumerKey ? c.consumerKey.replace(/^…/, '****') : undefined, all || changed.has('consumerKey') || changed.has('clientId'));
    add('scope', c.scope ?? undefined);
    if (c.addedModels?.length && !all) rows.push({ label: '新增模型', value: c.addedModels.join('、') });
    if (c.enabledModels?.length) rows.push({ label: '启用模型', value: c.enabledModels.join('、') });
    if (c.disabledModels?.length) rows.push({ label: '停用模型', value: c.disabledModels.join('、') });
    if (c.removedModels?.length) rows.push({ label: '移除模型', value: c.removedModels.join('、') });
    if (c.models?.length && (all || changed.has('models') || c.addedModels?.length)) {
      const shown = all ? c.models : c.models.filter((m) => c.addedModels?.includes(m.id) || changed.has('models'));
      for (const m of shown) rows.push({ label: m.id, value: `上下文上限 ${windowText(m)}` });
    }
    if (c.secret && (all || changed.has('secret'))) rows.push({ label: c.kind === 'wso2' ? 'Consumer Secret' : 'API Key', value: c.secret === 'new' ? '已更新' : '未更改' });
    for (const f of c.changes) {
      if (['new', 'kind', 'baseUrl', 'tokenUrl', 'clientId', 'consumerKey', 'scope', 'models', 'secret', 'default', 'strong'].includes(f)) continue;
      const label = fieldLabel(f, c.kind);
      if (label) rows.push({ label, value: '已更改' });
    }
    if (c.makeDefault) rows.push({ label: '默认模型', value: `「${c.name} · ${c.makeDefault}」` });
    if (c.makeStrong) rows.push({ label: '强模型', value: `「${c.name} · ${c.makeStrong}」` });
  }
  if (c.defaultMoved) rows.push({ label: '默认模型', value: `${pointerText(c.defaultMoved.from, c)} → ${pointerText(c.defaultMoved.to, c)}` });
  if (c.strongMoved) rows.push({ label: '强模型', value: `${pointerText(c.strongMoved.from, c)} → ${pointerText(c.strongMoved.to, c)}` });
  return rows;
}

export function SettingsChangeCard({ change, onOpenSettings }: { change: SettingsChangeMeta; onOpenSettings?: (() => void) | undefined }) {
  const rows = settingsChangeRows(change);
  const test = change.test;
  return (
    <section className="settings-change" role="note" aria-label={settingsChangeTitle(change)}>
      <header className="settings-change-head">
        <Icon name="settings" size={16} />
        <span className="settings-change-title">{settingsChangeTitle(change)}</span>
        <time className="settings-change-time" dateTime={change.at}>
          {timeOf(change.at)}
        </time>
      </header>
      <dl className="settings-change-facts">
        {rows.map((r) => (
          <div key={r.label} className="settings-change-row">
            <dt>{r.label}</dt>
            <dd>{r.value}</dd>
          </div>
        ))}
      </dl>
      {test ? (
        <p className={test.ok ? 'settings-change-test is-ok' : 'settings-change-test is-bad'}>
          {test.ok ? `连接测试${test.model ? `（${test.model}）` : ''}：通过` : '连接测试：未通过'}
        </p>
      ) : null}
      <footer className="settings-change-foot">
        <span className="settings-change-note">{change.confirmed ? '已确认' : '未经确认，已生效'}</span>
        {onOpenSettings ? (
          <button type="button" className="btn btn-small" onClick={onOpenSettings}>
            查看设置
          </button>
        ) : null}
      </footer>
    </section>
  );
}
