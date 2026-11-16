// A model setting changed by a script connected to the app (the core's MCP
// tools), shown in the conversation so it cannot go unnoticed. Drawn from the note's
// meta.settingsChange, never from its text; it stays in the history.
import type { SettingsChangeMeta } from '@spica/protocol';
import { Icon } from '../ui/Icon';
import { timeOf } from './format';
import { intlLocale, N_, t, tc } from '../../../shared/i18n';

const KIND: Record<SettingsChangeMeta['kind'], string> = { 'openai-compatible': N_('OpenAI 兼容'), anthropic: 'Anthropic', wso2: N_('公司网关（WSO2）') };

/** Field names the core reports, as the settings page labels them. */
function fieldLabel(field: string, kind: SettingsChangeMeta['kind']): string | null {
  switch (field) {
    case 'name':
      return t('名称');
    case 'kind':
      return t('类型');
    case 'baseUrl':
      return kind === 'wso2' ? t('网关地址') : t('接口地址');
    case 'tokenUrl':
      return t('取 token 地址');
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
      return tc('field', '模型');
    case 'strongModel':
      return t('强模型');
    case 'contextWindow':
      return t('上下文上限');
    case 'maxConcurrent':
      return t('同时请求');
    case 'requestsPerMinute':
      return t('每分钟请求');
    case 'default':
      return t('默认模型');
    default:
      return null;
  }
}

export function settingsChangeTitle(c: SettingsChangeMeta): string {
  if (c.action === 'set_default_model') return t('本机脚本将默认模型设为「{name} · {model}」', { name: c.name, model: c.model ?? '' });
  if (c.action === 'set_strong_model') return c.model ? t('本机脚本将强模型设为「{name} · {model}」', { name: c.name, model: c.model }) : t('本机脚本清除了强模型');
  if (c.action === 'add_connection') return t('本机脚本添加了服务商「{name}」', { name: c.name });
  return t('本机脚本修改了服务商「{name}」', { name: c.name });
}

type Pointer = { connectionId: string; model: string } | null;

/** A pointer as people read it: the model, and the connection when it is another one. */
function pointerText(p: Pointer, c: SettingsChangeMeta): string {
  if (!p) return t('无');
  return p.connectionId === c.id ? t('「{name}」', { name: `${c.name} · ${p.model}` }) : t('「{model}」（其他服务商）', { model: p.model });
}

const windowText = (m: { contextWindow: number | null; contextFrom: string }) => {
  const size = m.contextWindow ? `${m.contextWindow.toLocaleString(intlLocale())} token` : t('未设置');
  return m.contextFrom === 'name-match' ? t('{size}（按名称匹配）', { size }) : size;
};

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
    add('kind', t(KIND[c.kind]));
    add('baseUrl', c.baseUrl);
    add('tokenUrl', c.tokenUrl);
    // Masked by the core (keyMaskText, e.g. fa8x****8c21); records from before carry 「…8c21」.
    add('consumerKey', c.consumerKey ? c.consumerKey.replace(/^…/, '****') : undefined, all || changed.has('consumerKey') || changed.has('clientId'));
    add('scope', c.scope ?? undefined);
    const list = (ids: string[]) => ids.join(t('、'));
    if (c.addedModels?.length && !all) rows.push({ label: t('新增模型'), value: list(c.addedModels) });
    if (c.enabledModels?.length) rows.push({ label: t('启用模型'), value: list(c.enabledModels) });
    if (c.disabledModels?.length) rows.push({ label: t('停用模型'), value: list(c.disabledModels) });
    if (c.removedModels?.length) rows.push({ label: t('移除模型'), value: list(c.removedModels) });
    if (c.models?.length && (all || changed.has('models') || c.addedModels?.length)) {
      const shown = all ? c.models : c.models.filter((m) => c.addedModels?.includes(m.id) || changed.has('models'));
      for (const m of shown) rows.push({ label: m.id, value: t('上下文上限 {value}', { value: windowText(m) }) });
    }
    if (c.secret && (all || changed.has('secret'))) rows.push({ label: c.kind === 'wso2' ? 'Consumer Secret' : 'API Key', value: c.secret === 'new' ? t('已更新') : t('未更改') });
    for (const f of c.changes) {
      if (['new', 'kind', 'baseUrl', 'tokenUrl', 'clientId', 'consumerKey', 'scope', 'models', 'secret', 'default', 'strong'].includes(f)) continue;
      const label = fieldLabel(f, c.kind);
      if (label) rows.push({ label, value: t('已更改') });
    }
    if (c.makeDefault) rows.push({ label: t('默认模型'), value: t('「{name}」', { name: `${c.name} · ${c.makeDefault}` }) });
    if (c.makeStrong) rows.push({ label: t('强模型'), value: t('「{name}」', { name: `${c.name} · ${c.makeStrong}` }) });
  }
  if (c.defaultMoved) rows.push({ label: t('默认模型'), value: `${pointerText(c.defaultMoved.from, c)} → ${pointerText(c.defaultMoved.to, c)}` });
  if (c.strongMoved) rows.push({ label: t('强模型'), value: `${pointerText(c.strongMoved.from, c)} → ${pointerText(c.strongMoved.to, c)}` });
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
          {test.ok ? (test.model ? t('连接测试（{model}）：通过', { model: test.model }) : t('连接测试：通过')) : t('连接测试：未通过')}
        </p>
      ) : null}
      <footer className="settings-change-foot">
        <span className="settings-change-note">{change.confirmed ? t('已确认') : t('未经确认，已生效')}</span>
        {onOpenSettings ? (
          <button type="button" className="btn btn-small" onClick={onOpenSettings}>
            {t('查看设置')}
          </button>
        ) : null}
      </footer>
    </section>
  );
}
