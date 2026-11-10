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
  if (c.action === 'set_default_model') return `${who}把「${c.name}」设成了默认模型`;
  if (c.action === 'add_model') return `${who}新增了模型连接「${c.name}」`;
  return `${who}改了模型连接「${c.name}」`;
}

/** The rows the card lists: everything for a new connection, only what changed otherwise. */
export function settingsChangeRows(c: SettingsChangeMeta): { label: string; value: string }[] {
  const all = c.action === 'add_model';
  const changed = new Set(c.changes);
  const show = (field: string) => all || changed.has(field) || (field === 'consumerKey' && changed.has('clientId'));
  const rows: { label: string; value: string }[] = [];
  const add = (field: string, value: string | null | undefined) => {
    const label = fieldLabel(field, c.kind);
    if (label && show(field) && value !== undefined && value !== null && value !== '') rows.push({ label, value });
  };
  if (c.action === 'set_default_model') return [{ label: '模型', value: `${KIND[c.kind]} · ${c.model}` }];
  add('kind', KIND[c.kind]);
  add('baseUrl', c.baseUrl);
  add('tokenUrl', c.tokenUrl);
  add('consumerKey', c.consumerKey ? `末 4 位 ${c.consumerKey.replace(/^…/, '')}` : undefined);
  add('scope', c.scope ?? undefined);
  add('model', c.model);
  add('contextWindow', typeof c.contextWindow === 'number' ? `${c.contextWindow.toLocaleString('en-US')} token` : undefined);
  if (c.secret && (all || changed.has('secret'))) rows.push({ label: c.kind === 'wso2' ? 'Consumer Secret' : 'API Key', value: c.secret === 'new' ? '新填（已加密保存）' : '未改动' });
  // Any other changed field the core named, so nothing it changed goes unmentioned.
  for (const f of c.changes) {
    if (['new', 'kind', 'baseUrl', 'tokenUrl', 'clientId', 'consumerKey', 'scope', 'model', 'contextWindow', 'secret', 'default'].includes(f)) continue;
    const label = fieldLabel(f, c.kind);
    if (label) rows.push({ label, value: '已改' });
  }
  if (c.makeDefault || changed.has('default')) rows.push({ label: '默认模型', value: '设成了默认' });
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
          {test.ok ? '保存前测试连接：通过' : '保存前测试连接没通过，脚本要求照样保存。可以到 设置 › 模型 里再测一次。'}
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
