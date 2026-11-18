// The MCP services the person adds (not the ones plugins bring). A list, a row a service (its letter, its name,
// its command under it, its state at the end); a press opens its page in place of the list (← back): its switch
// and 「…」 (编辑 / 删除), what is wrong and the last lines it wrote, its command, its tools, and whether its tools
// ask before they run. 添加 opens the form in place of the list: 名称, 命令, 参数 (one a line), 环境变量 (values
// kept sealed), 工作文件夹, 工具执行; 粘贴配置 fills it from another app's `mcpServers`. 保存 asks first, showing
// the whole command that will run.
import { useEffect, useState, type ReactNode } from 'react';
import {
  commandLine,
  quoteArg,
  draftArgs,
  draftOf,
  emptyMcpDraft,
  MCP_STATUS,
  mcpDraftErrors,
  parseMcpPaste,
  type McpApproval,
  type McpEnvDraft,
  type McpFieldErrors,
  type McpServerDraft,
  type McpServerView,
} from '../../../shared/mcp-servers';
import { SpicaStatusIcon } from '@spica/brand/react';
import { ConfirmDialog } from '../ui/Dialog';
import { ContextMenu } from '../ui/ContextMenu';
import { Icon } from '../ui/Icon';
import { letterBadge } from '../ui/badge';
import { FormRow } from './FormRow';
import { ProblemBeside, ProblemBox } from './Problem';
import { Group, Row } from './Group';
import { SaveRow } from './save-layout';
import { Switch } from './Switch';
import { N_, t } from '../../../shared/i18n';

export interface McpApi {
  list(): Promise<McpList>;
  /** Saves a new service (`was` null) or the one called `was`; resolves with what is wrong by field (empty: saved). */
  save(was: string | null, draft: McpServerDraft): Promise<McpFieldErrors & { ''?: string }>;
  remove(name: string): Promise<void>;
  setEnabled(name: string, on: boolean): Promise<void>;
  setApproval(name: string, approval: McpApproval): Promise<void>;
  onChanged(listener: () => void): () => void;
  pickFolder?: () => Promise<string | null>;
}

export interface McpList {
  servers: McpServerView[];
  /** Names a new service cannot take (plugins' servers). */
  taken: string[];
}

const APPROVALS: readonly { value: McpApproval; label: string }[] = [
  { value: 'ask', label: N_('每次询问') },
  { value: 'auto', label: N_('直接执行') },
];

function Badge({ name }: { name: string }) {
  const b = letterBadge(name, `mcp:${name}`);
  return (
    <span className="plugin-badge" style={{ background: b.colour }} aria-hidden>
      {b.letter}
    </span>
  );
}

/** The state at a row's end: nothing while it runs; 错误 with its mark; the others in quiet words. */
function RowState({ s }: { s: McpServerView }) {
  if (s.status === 'running') return null;
  if (s.status === 'failed') return <SpicaStatusIcon name="error" size={14} title={s.lastError ?? t(MCP_STATUS.failed)} />;
  return <span className="provider-default plugin-row-state">{t(MCP_STATUS[s.status])}</span>;
}

/** The whole command as it will run, in the code font, wrapped (never cut). */
export function CommandBox({ command, args }: { command: string; args: readonly string[] }) {
  return (
    <div className="tool-command mcp-command">
      <div className="tool-command-box">
        <pre>
          <code>
            {[command, ...args].map((a, i) => (
              <span key={i}>
                {i ? ' ' : ''}
                <span className="mcp-arg">{quoteArg(a)}</span>
              </span>
            ))}
          </code>
        </pre>
      </div>
    </div>
  );
}

function Back({ label, onBack }: { label: string; onBack(): void }) {
  return (
    <button type="button" className="back-link plugin-back" onClick={onBack}>
      <Icon name="arrowLeft" size={16} />
      {label}
    </button>
  );
}

function ApprovalField({ value, onChange, disabled }: { value: McpApproval; onChange(v: McpApproval): void; disabled?: boolean }) {
  return (
    <div className="segmented" role="radiogroup" aria-label={t('工具执行')}>
      {APPROVALS.map((c) => (
        <button key={c.value} type="button" role="radio" disabled={disabled} aria-checked={value === c.value} className={value === c.value ? 'segment is-on' : 'segment'} onClick={() => onChange(c.value)}>
          {t(c.label)}
        </button>
      ))}
    </div>
  );
}

/** A service's page. */
function Detail({ s, busy, api, onBack, onEdit, onRemove }: { s: McpServerView; busy: boolean; api: McpApi; onBack(): void; onEdit(): void; onRemove(): void }) {
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const status = t(MCP_STATUS[s.status]);
  return (
    <section className={s.enabled ? 'plugin-detail mcp-detail' : 'plugin-detail mcp-detail is-off'} aria-label={s.name}>
      <Back label={t('MCP 服务')} onBack={onBack} />
      <header className="plugin-head">
        <div className="plugin-title">
          <Badge name={s.name} />
          <span className="plugin-title-text">
            <span className="plugin-name">{s.name}</span>
            <span className="settings-hint plugin-sub">{status}</span>
          </span>
        </div>
        <div className="plugin-head-actions">
          <Switch on={s.enabled} label={s.enabled ? t('停用「{name}」', { name: s.name }) : t('启用「{name}」', { name: s.name })} disabled={busy} onChange={(on) => void api.setEnabled(s.name, on)} />
          <button
            type="button"
            className="icon-btn"
            aria-label={t('更多操作')}
            title={t('更多操作')}
            aria-haspopup="menu"
            disabled={busy}
            onClick={(e) => {
              const el = e.currentTarget;
              setMenu((m) => (m ? null : el));
            }}
          >
            <Icon name="more" size={16} />
          </button>
        </div>
      </header>
      {menu ? (
        <ContextMenu
          x={0}
          y={0}
          anchor={menu}
          items={[
            { label: t('编辑'), onSelect: onEdit },
            { label: t('删除'), danger: true, onSelect: onRemove },
          ]}
          onClose={() => setMenu(null)}
        />
      ) : null}
      <div className="plugin-detail-body">
        {s.status === 'failed' && s.lastError ? (
          <p className="plugin-problem status-with-icon">
            <SpicaStatusIcon name="error" size={14} />
            {s.lastError}
          </p>
        ) : null}
        {s.status === 'failed' && s.logTail?.length ? (
          <div className="tool-command mcp-log">
            <div className="tool-command-box">
              <pre>
                <code>{s.logTail.join('\n')}</code>
              </pre>
            </div>
          </div>
        ) : null}
        <dl className="detail-facts plugin-facts mcp-facts">
          <dt>{t('命令')}</dt>
          <dd className="mcp-mono">{commandLine(s.command, s.args)}</dd>
          {s.cwd ? (
            <>
              <dt>{t('工作文件夹')}</dt>
              <dd className="path-text" title={s.cwd} data-tip-clipped="">
                {s.cwd}
              </dd>
            </>
          ) : null}
          <dt>{t('环境变量')}</dt>
          <dd>{s.env.length ? s.env.map((e) => e.name).join(t('、')) : '—'}</dd>
          <dt>{t('工具')}</dt>
          <dd>{s.tools.length ? s.tools.join(t('、')) : '—'}</dd>
        </dl>
        <Group className="mcp-approval">
          <Row title={t('工具执行')}>
            <ApprovalField value={s.approval} disabled={busy} onChange={(v) => void api.setApproval(s.name, v)} />
          </Row>
        </Group>
      </div>
    </section>
  );
}

/** 环境变量: a row each, 名称 and 值 side by side; values are sealed (a saved one shows its mask, empty keeps it). */
function EnvField({ rows, saved, onChange, error }: { rows: McpEnvDraft[]; saved: McpServerView['env']; onChange(rows: McpEnvDraft[]): void; error?: string | undefined }) {
  const edit = (i: number, patch: Partial<McpEnvDraft>) =>
    onChange(
      rows.map((r, j) => {
        if (j !== i) return r;
        const next = { ...r, ...patch };
        if (patch.name !== undefined && r.saved && patch.name.trim() !== r.name.trim()) delete next.saved;
        return next;
      }),
    );
  return (
    <FormRow
      stack
      title={
        <>
          {t('环境变量')}
          <ProblemBeside problem={error} />
        </>
      }
    >
      {rows.length ? (
        <span className="header-rows">
          {rows.map((r, i) => {
            const mask = r.saved ? saved.find((e) => e.name === r.name.trim())?.mask : undefined;
            return (
              <span key={i} className="header-row">
                <span className="header-cell header-name">
                  <input className="input" value={r.name} placeholder="API_TOKEN" aria-label={t('变量名')} spellCheck={false} autoComplete="off" onChange={(e) => edit(i, { name: e.target.value })} />
                </span>
                <span className="header-cell header-value">
                  <input
                    className="input"
                    type="password"
                    value={r.value ?? ''}
                    placeholder={mask ? t('{mask}（留空不修改）', { mask }) : t('值')}
                    aria-label={t('{name} 的值', { name: r.name.trim() || t('环境变量') })}
                    spellCheck={false}
                    autoComplete="off"
                    onChange={(e) => edit(i, { value: e.target.value })}
                  />
                </span>
                <button type="button" className="icon-btn" onClick={() => onChange(rows.filter((_, j) => j !== i))} aria-label={t('删除 {name}', { name: r.name.trim() || t('环境变量') })} title={t('删除')}>
                  <Icon name="trash" size={14} />
                </button>
              </span>
            );
          })}
        </span>
      ) : null}
      <span className="model-pills">
        <button type="button" className="model-pill is-action" onClick={() => onChange([...rows, { name: '' }])}>
          <Icon name="plus" size={12} />
          {t('添加')}
        </button>
      </span>
    </FormRow>
  );
}

/** 粘贴配置: another app's `mcpServers` (or one service of it) fills the form. */
function PasteMcp({ open, setOpen, onApply }: { open: boolean; setOpen(open: boolean): void; onApply(d: Partial<McpServerDraft>, note: string): void }) {
  const [text, setText] = useState('');
  const [bad, setBad] = useState(false);
  const apply = () => {
    const r = parseMcpPaste(text);
    if (!r || !r.servers.length) {
      setBad(true);
      return;
    }
    const s = r.servers[0]!;
    const rest = r.servers.length - 1 + r.skipped.length;
    onApply(
      { ...(s.name ? { name: s.name } : {}), command: s.command, args: s.args.join('\n'), env: s.env.map((e) => ({ name: e.name, value: e.value })), cwd: s.cwd ?? '' },
      rest ? t('另有 {n} 项未填入：{names}', { n: rest, names: [...r.servers.slice(1).map((x) => x.name), ...r.skipped].join(t('、')) }) : '',
    );
    setText('');
    setOpen(false);
  };
  return open ? (
    <div className="paste-config-box mcp-paste">
      <textarea
        className={bad ? 'input paste-config-input is-invalid' : 'input paste-config-input'}
        rows={8}
        spellCheck={false}
        autoFocus
        value={text}
        aria-label={t('配置文本')}
        placeholder={'{\n  "mcpServers": {\n    "files": { "command": "npx", "args": ["-y", "@example/files"] }\n  }\n}'}
        onChange={(e) => {
          setText(e.target.value);
          setBad(false);
        }}
      />
      {bad ? <span className="field-error">{t('未识别到 MCP 服务配置')}</span> : null}
      <div className="paste-config-actions">
        <button type="button" className="btn" onClick={() => setOpen(false)}>
          {t('取消')}
        </button>
        <button type="button" className="btn btn-primary" disabled={!text.trim()} onClick={apply}>
          {t('识别并填入')}
        </button>
      </div>
    </div>
  ) : null;
}

function TextField({ label, value, onChange, error, placeholder, mono, after }: { label: string; value: string; onChange(v: string): void; error?: string | undefined; placeholder?: string; mono?: boolean; after?: ReactNode }) {
  const input = (
    <ProblemBox problem={error}>
      <input className={[error ? 'input is-invalid' : 'input', mono ? 'mcp-mono' : ''].filter(Boolean).join(' ')} value={value} placeholder={placeholder} aria-label={label} aria-invalid={error ? true : undefined} spellCheck={false} autoComplete="off" onChange={(e) => onChange(e.target.value)} />
    </ProblemBox>
  );
  return (
    <FormRow title={label} controlClassName={after ? 'mcp-with-button' : undefined}>
      {input}
      {after}
    </FormRow>
  );
}

/** 添加 / 编辑: the form, in place of the list. */
function Editor({ was, saved, taken, api, onBack, onSaved }: { was: McpServerView | null; saved: McpServerView[]; taken: string[]; api: McpApi; onBack(): void; onSaved(name: string): void }) {
  const [draft, setDraft] = useState<McpServerDraft>(() => (was ? draftOf(was) : emptyMcpDraft()));
  const [errors, setErrors] = useState<McpFieldErrors & { ''?: string }>({});
  const [shown, setShown] = useState(false);
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState('');
  const [pasting, setPasting] = useState(false);
  const set = (patch: Partial<McpServerDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const others = [...taken, ...saved.filter((s) => s.name !== was?.name).map((s) => s.name)];
  const live = shown ? mcpDraftErrors(draft, others) : {};
  const shownErrors = { ...live, ...errors };
  const submit = () => {
    setShown(true);
    const e = mcpDraftErrors(draft, others);
    if (Object.keys(e).length) return;
    setAsking(true);
  };
  const confirm = async () => {
    setAsking(false);
    const r = await api.save(was?.name ?? null, draft);
    if (Object.keys(r).length) setErrors(r);
    else onSaved(draft.name.trim());
  };
  const args = draftArgs(draft);
  const envNames = draft.env.map((e) => e.name.trim()).filter(Boolean);
  return (
    <section className="plugin-detail mcp-editor" aria-label={was ? t('编辑「{name}」', { name: was.name }) : t('添加 MCP 服务')}>
      <Back label={t('MCP 服务')} onBack={onBack} />
      <header className="plugin-head">
        <div className="plugin-title">
          <span className="plugin-name">{was ? t('编辑「{name}」', { name: was.name }) : t('添加 MCP 服务')}</span>
        </div>
        <div className="plugin-head-actions">
          <button type="button" className={pasting ? 'btn btn-small is-on' : 'btn btn-small'} aria-expanded={pasting} onClick={() => setPasting(!pasting)}>
            <Icon name="paste" size={14} />
            {t('粘贴配置')}
          </button>
        </div>
      </header>
      <PasteMcp
        open={pasting}
        setOpen={setPasting}
        onApply={(d, n) => {
          set(d);
          setNote(n);
        }}
      />
      {note ? <p className="settings-hint mcp-paste-note">{note}</p> : null}
      <form
        className="provider-editor group-box mcp-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <TextField label={t('名称')} value={draft.name} onChange={(name) => set({ name })} error={shownErrors.name} placeholder="files" />
        <TextField label={t('命令')} value={draft.command} onChange={(command) => set({ command })} error={shownErrors.command} placeholder="npx" mono />
        <FormRow stack title={t('参数')}>
          <textarea className="input mcp-args mcp-mono" wrap="off" rows={Math.min(8, Math.max(3, args.length + 1))} value={draft.args} placeholder={'-y\n@example/files\nD:\\Shared Files'} aria-label={t('参数')} spellCheck={false} onChange={(e) => set({ args: e.target.value })} />
        </FormRow>
        <EnvField rows={draft.env} saved={was?.env ?? []} onChange={(env) => set({ env })} error={shownErrors.env} />
        <TextField
          label={t('工作文件夹')}
          value={draft.cwd}
          onChange={(cwd) => set({ cwd })}
          placeholder="D:\Projects"
          after={
            api.pickFolder ? (
              <button type="button" className="btn btn-square" aria-label={t('选择文件夹')} title={t('选择文件夹')} onClick={() => void api.pickFolder?.().then((dir) => dir && set({ cwd: dir }))}>
                <Icon name="folder" size={16} />
              </button>
            ) : undefined
          }
        />
        <FormRow title={t('工具执行')}>
          <ApprovalField value={draft.approval} onChange={(approval) => set({ approval })} />
        </FormRow>
        <SaveRow className="provider-actions">
          <span className="provider-actions-gap" />
          {shownErrors[''] ? (
            <span className="provider-result is-bad" role="status">
              <SpicaStatusIcon name="error" size={15} />
              {shownErrors['']}
            </span>
          ) : null}
          <button type="button" className="btn" onClick={onBack}>
            {t('取消')}
          </button>
          <button type="button" className="btn btn-primary" onClick={submit}>
            {t('保存')}
          </button>
        </SaveRow>
      </form>
      {asking ? (
        <ConfirmDialog
          title={was ? t('保存「{name}」？', { name: draft.name.trim() }) : t('添加「{name}」？', { name: draft.name.trim() })}
          detail={
            <>
              <CommandBox command={draft.command.trim()} args={args} />
              {draft.cwd.trim() || envNames.length ? (
                <dl className="detail-facts mcp-confirm-facts">
                  {draft.cwd.trim() ? (
                    <>
                      <dt>{t('工作文件夹')}</dt>
                      <dd>{draft.cwd.trim()}</dd>
                    </>
                  ) : null}
                  {envNames.length ? (
                    <>
                      <dt>{t('环境变量')}</dt>
                      <dd>{envNames.join(t('、'))}</dd>
                    </>
                  ) : null}
                </dl>
              ) : null}
            </>
          }
          confirmLabel={was ? t('保存') : t('添加')}
          onConfirm={() => void confirm()}
          onCancel={() => setAsking(false)}
        />
      ) : null}
    </section>
  );
}

type View = { at: 'list' } | { at: 'detail'; name: string } | { at: 'edit'; name: string | null };

export interface McpServersProps {
  api: McpApi;
  /** The list is a settings section of its own (named 「MCP 服务」 above it): no title of its own. */
  ownPage?: boolean;
  /** Which of list / page / form shows, when the caller keeps it. */
  view?: View;
  onView?: (v: View) => void;
}

export type McpView = View;

/** The list, a service's page, or the form. */
export function McpServers({ api, view: viewProp, onView, ownPage }: McpServersProps) {
  const [list, setList] = useState<McpList | null>(null);
  const [ownView, setOwnView] = useState<View>({ at: 'list' });
  const [removing, setRemoving] = useState<McpServerView | null>(null);
  const view = viewProp ?? ownView;
  const go = (v: View) => {
    setOwnView(v);
    onView?.(v);
  };
  useEffect(() => {
    let live = true;
    const load = () => void api.list().then((l) => live && setList(l));
    load();
    const off = api.onChanged(load);
    return () => {
      live = false;
      off();
    };
  }, [api]);
  const servers = list?.servers ?? [];
  const current = view.at !== 'list' && view.name ? servers.find((s) => s.name === view.name) : undefined;

  if (view.at === 'edit' && list) {
    return <Editor key={view.name ?? ''} was={current ?? null} saved={servers} taken={list.taken} api={api} onBack={() => go(current ? { at: 'detail', name: current.name } : { at: 'list' })} onSaved={(name) => go({ at: 'detail', name })} />;
  }
  const rows = (
    <ul className="group-box group-list plugin-items mcp-items">
      {servers.map((s) => (
        <li key={s.name}>
          <button type="button" className={s.enabled ? 'plugin-item' : 'plugin-item is-off'} onClick={() => go({ at: 'detail', name: s.name })}>
            <Badge name={s.name} />
            <span className="plugin-item-text">
              <span className="plugin-item-title">
                <span className="plugin-row-name">{s.name}</span>
              </span>
              <span className="settings-hint plugin-item-desc mcp-mono">{commandLine(s.command, s.args)}</span>
            </span>
            <RowState s={s} />
            <Icon name="chevronRight" size={14} className="plugin-item-go" />
          </button>
        </li>
      ))}
    </ul>
  );
  const add = (
    <button type="button" className="btn btn-small" onClick={() => go({ at: 'edit', name: null })}>
      <Icon name="plus" size={14} />
      {t('添加')}
    </button>
  );
  return (
    <>
      {view.at === 'detail' && current ? (
        <Detail s={current} busy={false} api={api} onBack={() => go({ at: 'list' })} onEdit={() => go({ at: 'edit', name: current.name })} onRemove={() => setRemoving(current)} />
      ) : (
        <section className="plugins-part mcp-part" aria-label={t('MCP 服务')}>
          <div className="plugins-part-head">
            {ownPage ? (
              <span />
            ) : (
              <h3 className="plugins-part-title">
                {t('MCP 服务')}
                {servers.length ? <span className="tab-count">{servers.length}</span> : null}
              </h3>
            )}
            <div className="plugins-part-actions">{add}</div>
          </div>
          {servers.length ? rows : list ? <p className="settings-hint plugins-none">{t('未添加 MCP 服务')}</p> : null}
        </section>
      )}
      {removing ? (
        <ConfirmDialog
          title={t('删除「{name}」？', { name: removing.name })}
          confirmLabel={t('删除')}
          danger
          onConfirm={() => {
            const s = removing;
            setRemoving(null);
            go({ at: 'list' });
            void api.remove(s.name);
          }}
          onCancel={() => setRemoving(null)}
        />
      ) : null}
    </>
  );
}
