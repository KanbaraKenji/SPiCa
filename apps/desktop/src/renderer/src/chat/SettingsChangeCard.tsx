// A model setting changed by a script connected to the app (the core's MCP
// tools), shown in the conversation so it cannot go unnoticed (他 2026-11-10:
// 「改了以后在对话里要比较明显的展示出该改动」). Drawn from the note's
// meta.settingsChange, never from its text; it stays in the history.
import type { SettingsChangeMeta } from '@spica/protocol';
import { APP_NAME } from '../../../shared/app-identity';
import { Icon } from '../ui/Icon';

const KIND: Record<SettingsChangeMeta['kind'], string> = { 'openai-compatible': 'OpenAI 兼容', anthropic: 'Anthropic', wso2: 'WSO2 网关' };

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
  const who = `连接到 ${APP_NAME} 的脚本`;
  if (c.action === 'set_default_model') return `${who}把新对话默认用的模型换成了「${c.name} · ${c.model ?? ''}」`;
  if (c.action === 'set_strong_model') return c.model ? `${who}把重活用的模型换成了「${c.name} · ${c.model}」` : `${who}取消了重活用的模型`;
  if (c.action === 'add_connection') return `${who}新增了服务商连接「${c.name}」`;
  return `${who}改了服务商连接「${c.name}」`;
}

type Pointer = { connectionId: string; model: string } | null;

/** A pointer as people read it: the model, and the connection when it is another one. */
function pointerText(p: Pointer, c: SettingsChangeMeta): string {
  if (!p) return '没有';
  return p.connectionId === c.id ? `「${c.name} · ${p.model}」` : `「${p.model}」（另一条连接）`;
}

const windowText = (m: { contextWindow: number; contextFrom: string }) =>
  `${m.contextWindow ? `${m.contextWindow.toLocaleString('en-US')} token` : '还没填上限'}${m.contextFrom === 'name-match' ? '（按名字对出来的）' : ''}`;

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
    add('consumerKey', c.consumerKey ? `末 4 位 ${c.consumerKey.replace(/^…/, '')}` : undefined, all || changed.has('consumerKey') || changed.has('clientId'));
    add('scope', c.scope ?? undefined);
    if (c.addedModels?.length && !all) rows.push({ label: '加了模型', value: c.addedModels.join('、') });
    if (c.removedModels?.length) rows.push({ label: '去了模型', value: c.removedModels.join('、') });
    if (c.models?.length && (all || changed.has('models') || c.addedModels?.length)) {
      const shown = all ? c.models : c.models.filter((m) => c.addedModels?.includes(m.id) || changed.has('models'));
      for (const m of shown) rows.push({ label: m.id, value: `上下文上限 ${windowText(m)}` });
    }
    if (c.secret && (all || changed.has('secret'))) rows.push({ label: c.kind === 'wso2' ? 'Consumer Secret' : 'API Key', value: c.secret === 'new' ? '新填（已加密保存）' : '未改动' });
    for (const f of c.changes) {
      if (['new', 'kind', 'baseUrl', 'tokenUrl', 'clientId', 'consumerKey', 'scope', 'models', 'secret', 'default', 'strong'].includes(f)) continue;
      const label = fieldLabel(f, c.kind);
      if (label) rows.push({ label, value: '已改' });
    }
    if (c.makeDefault) rows.push({ label: '新对话默认用', value: `「${c.name} · ${c.makeDefault}」` });
    if (c.makeStrong) rows.push({ label: '重活用', value: `「${c.name} · ${c.makeStrong}」` });
  }
  if (c.defaultMoved) rows.push({ label: '默认模型', value: `从 ${pointerText(c.defaultMoved.from, c)} 挪到了 ${pointerText(c.defaultMoved.to, c)}` });
  if (c.strongMoved) rows.push({ label: '重活用', value: `从 ${pointerText(c.strongMoved.from, c)} 挪到了 ${pointerText(c.strongMoved.to, c)}` });
  return rows;
}

function timeOf(at: string): string {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
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
          {test.ok ? `保存前测试连接${test.model ? `（${test.model}）` : ''}：通过` : '保存前测试连接没通过，脚本要求照样保存。可以到 设置 › 模型 里再测一次。'}
        </p>
      ) : null}
      <footer className="settings-change-foot">
        <span className="settings-change-note">{change.confirmed ? '你在窗口里确认过' : '没有经过你确认，已经生效'}</span>
        {onOpenSettings ? (
          <button type="button" className="btn btn-small" onClick={onOpenSettings}>
            在设置里查看
          </button>
        ) : null}
      </footer>
    </section>
  );
}
