// 定时任务: the list page (the sidebar's 定时任务), the form to set one up or change it, the task's fields on the agent's
// card, the task in the details, and the runs that wait for the user in 收件箱.
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { ScheduleInfo, ScheduleInput, ScheduleRepeat, ScheduleRun } from '@spica/protocol';
import { SpicaStatusIcon } from '@spica/brand/react';
import { Icon } from '../ui/Icon';
import { Select, type SelectOption } from '../ui/Select';
import { Switch } from '../settings/Switch';
import { ContextMenu } from '../ui/ContextMenu';
import { ConfirmDialog } from '../ui/Dialog';
import { useModal } from '../ui/useModal';
import { N_, t } from '../../../shared/i18n';
import { repeatText, runReason, RUN_WORDS, scheduleLine, WEEK_ORDER, WEEKDAY_SHORT, whenText } from './model';

/** The last run as a mark and its word; a task turned off after failing says that instead (in the danger colour). */
function RunMark({ s, run }: { s?: ScheduleInfo; run: ScheduleRun | undefined }) {
  if (s?.pausedAfterFailures && !s.enabled)
    return (
      <span className="schedule-run is-failed" title={run ? runReason(run) : undefined}>
        <SpicaStatusIcon name="error" size={14} />
        {t('连续 {n} 次失败', { n: s.failures })}
      </span>
    );
  if (!run) return <span className="schedule-run">—</span>;
  const icon = run.status === 'done' ? 'done' : run.status === 'waiting' ? 'waiting' : run.status === 'running' ? 'running' : run.status === 'failed' ? 'error' : 'stopped';
  return (
    <span className={`schedule-run is-${run.status}`} title={run.status === 'failed' || run.status === 'skipped' ? runReason(run) : undefined}>
      <SpicaStatusIcon name={icon} size={14} />
      {t(RUN_WORDS[run.status])}
    </span>
  );
}

export interface ScheduleListProps {
  /** False until the list came back: nothing is drawn (no 「没有定时任务」 flash). */
  loaded: boolean;
  items: ScheduleInfo[];
  now: Date;
  onNew(): void;
  onEdit(s: ScheduleInfo): void;
  onToggle(id: string, on: boolean): void;
  onRunNow(id: string): void;
  onDelete(id: string): void;
  onOpenSession(id: string): void;
  problem?: string;
  onDismissProblem?: () => void;
}

/** The sidebar's 定时任务: every task, 新建 at the top right. A row opens its last run's conversation. */
export function SchedulePage(props: ScheduleListProps) {
  const [menu, setMenu] = useState<{ s: ScheduleInfo; anchor: HTMLElement } | null>(null);
  const [deleting, setDeleting] = useState<ScheduleInfo | null>(null);
  const runSession = (s: ScheduleInfo) => s.lastRun?.sessionId ?? s.sessionId;
  return (
    <div className="inbox schedule-page">
      <div className="inbox-column">
        <div className="inbox-head">
          <span />
          <div className="inbox-status">
            <button type="button" className="btn btn-primary" onClick={props.onNew}>
              <Icon name="plus" size={14} />
              {t('新建')}
            </button>
          </div>
        </div>
        {props.problem ? (
          <div className="inbox-problem" role="alert">
            <span>{props.problem}</span>
            <button type="button" className="icon-btn" onClick={props.onDismissProblem} aria-label={t('关闭提示')} title={t('关闭')}>
              <Icon name="close" size={14} />
            </button>
          </div>
        ) : null}
        {!props.loaded ? null : props.items.length === 0 ? (
          <div className="inbox-empty">
            <p className="inbox-empty-title">{t('没有定时任务')}</p>
          </div>
        ) : (
          <ul className="schedule-list">
            {props.items.map((s) => {
              const sid = runSession(s);
              return (
                <li key={s.id} className={s.enabled ? 'schedule-row' : 'schedule-row is-off'}>
                  <button type="button" className="schedule-main" disabled={!sid} onClick={() => sid && props.onOpenSession(sid)} title={s.prompt}>
                    <span className="schedule-name">{s.title}</span>
                    <span className="schedule-when">{scheduleLine(s, props.now)}</span>
                  </button>
                  <RunMark s={s} run={s.lastRun} />
                  <Switch on={s.enabled} label={s.enabled ? t('暂停') : t('开启')} onChange={(on) => props.onToggle(s.id, on)} />
                  <button type="button" className="icon-btn" aria-label={t('更多')} title={t('更多')} aria-haspopup="menu" onClick={(e) => { const anchor = e.currentTarget; setMenu((m) => (m?.anchor === anchor ? null : { s, anchor })); }}>
                    <Icon name="more" size={16} />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {menu ? (
        <ContextMenu
          x={0}
          y={0}
          anchor={menu.anchor}
          items={[
            { label: t('立即运行'), onSelect: () => props.onRunNow(menu.s.id) },
            { label: t('编辑'), onSelect: () => props.onEdit(menu.s) },
            ...(runSession(menu.s) ? [{ label: t('打开上次运行'), onSelect: () => props.onOpenSession(runSession(menu.s)!) }] : []),
            { label: t('删除'), danger: true, onSelect: () => setDeleting(menu.s) },
          ]}
          onClose={() => setMenu(null)}
        />
      ) : null}
      {deleting ? (
        <ConfirmDialog
          title={t('删除定时任务「{name}」？', { name: deleting.title })}
          confirmLabel={t('删除')}
          danger
          onConfirm={() => {
            props.onDelete(deleting.id);
            setDeleting(null);
          }}
          onCancel={() => setDeleting(null)}
        />
      ) : null}
    </div>
  );
}

type Kind = ScheduleRepeat['kind'];
const KINDS: { id: Kind; label: string }[] = [
  { id: 'daily', label: N_('每天') },
  { id: 'weekly', label: N_('每周') },
  { id: 'interval', label: N_('间隔') },
  { id: 'once', label: N_('一次') },
];

export interface FormValue {
  title: string;
  prompt: string;
  kind: Kind;
  time: string;
  days: number[];
  every: string;
  unit: 'minutes' | 'hours';
  date: string;
  cwd: string;
  /** providerId/model, or '' for the default model. */
  model: string;
}

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;

/** The form's fields for a task (a new one: 每天 09:00, tomorrow for 一次). */
export function formOf(s: ScheduleInfo | undefined, now: Date): FormValue {
  const tomorrow = new Date(now.getTime() + 86_400_000);
  const v: FormValue = { title: '', prompt: '', kind: 'daily', time: '09:00', days: [1], every: '1', unit: 'hours', date: ymd(tomorrow), cwd: '', model: '' };
  if (!s) return v;
  const r = s.trigger.repeat;
  const out: FormValue = { ...v, title: s.title, prompt: s.prompt, kind: r.kind, cwd: s.cwd ?? '', model: s.providerId && s.model ? `${s.providerId}/${s.model}` : '' };
  if (r.kind === 'daily') out.time = r.time;
  if (r.kind === 'weekly') Object.assign(out, { time: r.time, days: r.days });
  if (r.kind === 'interval') Object.assign(out, r.minutes % 60 === 0 ? { every: String(r.minutes / 60), unit: 'hours' } : { every: String(r.minutes), unit: 'minutes' });
  if (r.kind === 'once') {
    const at = new Date(r.at);
    Object.assign(out, { date: ymd(at), time: `${pad(at.getHours())}:${pad(at.getMinutes())}` });
  }
  return out;
}

/** The task the form describes, or the field that is not right. */
export function inputOf(v: FormValue): { input: ScheduleInput } | { problem: string } {
  if (!v.title.trim()) return { problem: N_('请填写名称') };
  if (!v.prompt.trim()) return { problem: N_('请填写内容') };
  const time = v.time.trim().replace('：', ':'); // i18n-skip: a full-width colon typed by mistake
  const hm = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(time);
  const hhmm = hm ? `${pad(Number(hm[1]))}:${hm[2]}` : '';
  let repeat: ScheduleRepeat;
  if (v.kind === 'interval') {
    const n = Number(v.every);
    const minutes = v.unit === 'hours' ? n * 60 : n;
    if (!Number.isInteger(n) || n < 1 || minutes > 7 * 24 * 60) return { problem: N_('间隔不对') };
    repeat = { kind: 'interval', minutes };
  } else {
    if (!hhmm) return { problem: N_('时间不对') };
    if (v.kind === 'daily') repeat = { kind: 'daily', time: hhmm };
    else if (v.kind === 'weekly') {
      if (!v.days.length) return { problem: N_('请选择星期') };
      repeat = { kind: 'weekly', days: [...v.days].sort(), time: hhmm };
    } else {
      const d = /^(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})$/.exec(v.date.trim());
      const at = d ? new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(hm![1]), Number(hm![2])) : null;
      if (!at || Number.isNaN(at.getTime()) || at.getMonth() !== Number(d![2]) - 1) return { problem: N_('日期不对') };
      repeat = { kind: 'once', at: at.toISOString() };
    }
  }
  const slash = v.model.indexOf('/');
  return {
    input: {
      title: v.title.trim(),
      prompt: v.prompt.trim(),
      trigger: { type: 'time', repeat },
      ...(v.cwd.trim() ? { cwd: v.cwd.trim() } : {}),
      ...(slash > 0 ? { providerId: v.model.slice(0, slash), model: v.model.slice(slash + 1) } : {}),
    },
  };
}

/** 每天 / 每周 / 间隔 / 一次, and 星期 for 每周. */
function RepeatFields({ v, set }: { v: FormValue; set(p: Partial<FormValue>): void }) {
  return (
    <div className="schedule-repeat">
      <div className="segmented" role="radiogroup" aria-label={t('重复')}>
        {KINDS.map((k) => (
          <button key={k.id} type="button" role="radio" aria-checked={v.kind === k.id} className={v.kind === k.id ? 'segment is-on' : 'segment'} onClick={() => set({ kind: k.id })}>
            {t(k.label)}
          </button>
        ))}
      </div>
      {v.kind === 'weekly' ? (
        <div className="segmented schedule-days" role="group" aria-label={t('星期')}>
          {WEEK_ORDER.map((d) => {
            const on = v.days.includes(d);
            return (
              <button key={d} type="button" aria-pressed={on} className={on ? 'segment is-on' : 'segment'} onClick={() => set({ days: on ? v.days.filter((x) => x !== d) : [...v.days, d] })}>
                {t(WEEKDAY_SHORT[d]!)}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function WhenFields({ v, set }: { v: FormValue; set(p: Partial<FormValue>): void }) {
  if (v.kind === 'interval')
    return (
      <span className="form-inline schedule-when-fields">
        <input className="input schedule-num" inputMode="numeric" value={v.every} aria-label={t('间隔')} onChange={(e) => set({ every: e.target.value })} />
        <Select
          className="schedule-unit"
          label={t('单位')}
          value={v.unit}
          options={[
            { value: 'minutes', label: t('分钟') },
            { value: 'hours', label: t('小时') },
          ]}
          onChange={(u) => set({ unit: u as FormValue['unit'] })}
        />
      </span>
    );
  return (
    <span className="form-inline schedule-when-fields">
      {v.kind === 'once' ? <input className="input schedule-date" value={v.date} aria-label={t('日期')} placeholder="2026/11/28" onChange={(e) => set({ date: e.target.value })} /> : null}
      <input className="input schedule-time" value={v.time} aria-label={t('时间')} placeholder="09:00" onChange={(e) => set({ time: e.target.value })} />
    </span>
  );
}

export interface ScheduleDialogProps {
  /** Changing this task; absent: a new one. */
  editing?: ScheduleInfo;
  now: Date;
  models: SelectOption[];
  onPickFolder(): Promise<string | null>;
  /** The problem in words when it could not be saved, else ''. */
  onSave(input: ScheduleInput & { id?: string }): Promise<string>;
  onClose(): void;
}

/** 新建定时任务 / 编辑定时任务: a dialog over the page. */
export function ScheduleDialog({ editing, now, models, onPickFolder, onSave, onClose }: ScheduleDialogProps) {
  const id = useId();
  const [v, setV] = useState(() => formOf(editing, now));
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<FormValue>) => setV((x) => ({ ...x, ...p }));
  const box = useRef<HTMLFormElement>(null);
  const first = useRef<HTMLInputElement>(null);
  useModal(box, onClose, first);
  const submit = async () => {
    if (busy) return;
    const out = inputOf(v);
    if ('problem' in out) {
      setProblem(t(out.problem));
      return;
    }
    setBusy(true);
    const err = await onSave({ ...out.input, ...(editing ? { id: editing.id, ...(editing.sessionId ? { sessionId: editing.sessionId } : {}) } : {}) });
    setBusy(false);
    if (err) setProblem(err);
    else onClose();
  };
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        className="dialog dialog-form schedule-dialog"
        ref={box}
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <p className="dialog-title" id={id}>
          {editing ? t('编辑定时任务') : t('新建定时任务')}
        </p>
        <label className="form-field">
          <span className="field-label">{t('名称')}</span>
          <input ref={first} className="input" value={v.title} maxLength={60} placeholder={t('每日报表')} onChange={(e) => set({ title: e.target.value })} />
        </label>
        <label className="form-field">
          <span className="field-label">{t('内容')}</span>
          <textarea className="input textarea" rows={3} value={v.prompt} placeholder={t('汇总昨天的来单，按客户列成表，存到 报表 文件夹')} onChange={(e) => set({ prompt: e.target.value })} />
        </label>
        <div className="form-field">
          <span className="field-label">{t('重复')}</span>
          <RepeatFields v={v} set={set} />
        </div>
        <div className="form-field">
          <span className="field-label">{v.kind === 'interval' ? t('间隔') : t('时间')}</span>
          <WhenFields v={v} set={set} />
        </div>
        <label className="form-field">
          <span className="field-label">{t('文件夹')}</span>
          <span className="form-inline">
            <input className="input" value={v.cwd} spellCheck={false} onChange={(e) => set({ cwd: e.target.value })} />
            <button
              type="button"
              className="btn btn-square"
              onClick={() => void onPickFolder().then((f) => f && set({ cwd: f }))}
              aria-label={t('选择文件夹')}
              title={t('选择文件夹')}
            >
              <Icon name="folder" size={16} />
            </button>
          </span>
        </label>
        <div className="form-field">
          <span className="field-label">{t('模型')}</span>
          <Select label={t('模型')} value={v.model} options={[{ value: '', label: t('默认模型') }, ...models]} onChange={(model) => set({ model })} />
        </div>
        {problem ? (
          <p className="field-error" role="alert">
            {problem}
          </p>
        ) : null}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            {t('取消')}
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {t('保存')}
          </button>
        </div>
      </form>
    </div>
  );
}

/** schedule_task's input on its confirmation card: the task's fields, read-only. */
export function ScheduleFacts({ input }: { input: unknown }) {
  const v = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const r = v.repeat as Partial<ScheduleRepeat> | undefined;
  const repeat = r && typeof r === 'object' && typeof r.kind === 'string' ? (r as ScheduleRepeat) : null;
  const str = (k: string) => (typeof v[k] === 'string' ? (v[k] as string) : '');
  let when = '—';
  try {
    if (repeat) when = repeatText(repeat);
  } catch {
    when = '—';
  }
  return (
    <dl className="schedule-facts">
      <dt>{t('名称')}</dt>
      <dd>{str('title') || '—'}</dd>
      <dt>{t('内容')}</dt>
      <dd className="schedule-prompt">{str('prompt') || '—'}</dd>
      <dt>{t('重复')}</dt>
      <dd>{when}</dd>
      <dt>{t('运行在')}</dt>
      <dd>{v.new_conversation === true ? t('新对话') : t('这个对话')}</dd>
      <dt>{t('文件夹')}</dt>
      <dd className="schedule-path" title={str('folder')}>
        {str('folder') || '—'}
      </dd>
      <dt>{t('模型')}</dt>
      <dd>{str('model') || t('默认模型')}</dd>
    </dl>
  );
}

/** The details' 定时任务: the task this conversation runs for, its switch and its last runs. */
export function ScheduleDetail({ s, now, loadRuns, onToggle, onOpenSession, current }: { s: ScheduleInfo; now: Date; loadRuns(id: string): Promise<ScheduleRun[]>; onToggle(on: boolean): void; onOpenSession(id: string): void; current: string }) {
  const [runs, setRuns] = useState<ScheduleRun[] | null>(null);
  const last = s.lastRun?.id ?? '';
  useEffect(() => {
    let alive = true;
    void loadRuns(s.id)
      .then((l) => alive && setRuns(l))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [loadRuns, s.id, last, s.lastRun?.status]);
  return (
    <section className="detail-section">
      <h3 className="detail-title">{t('定时任务')}</h3>
      <div className="schedule-detail-head">
        <span className="schedule-name" title={s.prompt}>
          {s.title}
        </span>
        <Switch on={s.enabled} label={s.enabled ? t('暂停') : t('开启')} onChange={onToggle} />
      </div>
      <dl className="detail-facts">
        <dt>{t('重复')}</dt>
        <dd>{repeatText(s.trigger.repeat)}</dd>
        <dt>{t('下次')}</dt>
        <dd>{s.enabled ? whenText(s.nextAt, now) : '—'}</dd>
      </dl>
      {runs?.length ? (
        <ul className="detail-list schedule-runs">
          {runs.map((r) => (
            <li key={r.id} className="detail-item">
              {r.sessionId && r.sessionId !== current ? (
                <button type="button" className="schedule-run-line" onClick={() => onOpenSession(r.sessionId!)}>
                  <span className="activity-time">{whenText(r.dueAt, now)}</span>
                  <RunMark run={r} />
                </button>
              ) : (
                <span className="schedule-run-line">
                  <span className="activity-time">{whenText(r.dueAt, now)}</span>
                  <RunMark run={r} />
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/** 收件箱's 定时任务 cards: a run waiting for a confirmation, a task turned off after failing. */
export function RunCards({ items, now, onOpen, onResume }: { items: ScheduleInfo[]; now: Date; onOpen(sessionId: string): void; onResume(id: string): void }) {
  return (
    <>
      {items.map((s) => {
        const run = s.lastRun;
        const paused = Boolean(s.pausedAfterFailures && !s.enabled);
        const sid = run?.sessionId;
        return (
          <article key={s.id} className="mail-card is-open run-card" aria-label={s.title}>
            <div className="mail-top">
              <span className="mail-from">
                <Icon name="clock" size={14} />
                {t('定时任务')}
              </span>
              <span className="mail-time">{run ? whenText(run.dueAt, now) : ''}</span>
            </div>
            <p className="mail-subject">{s.title}</p>
            <div className="mail-verdict">
              <span className={paused ? 'mail-tag is-run is-failed' : 'mail-tag is-run'}>
                <SpicaStatusIcon name={paused ? 'error' : 'waiting'} size={14} />
                {paused ? t('连续 {n} 次失败', { n: s.failures }) : t('等待确认')}
              </span>
              {paused && run ? (
                <span className="mail-reason" title={run.detail}>
                  {runReason(run)}
                </span>
              ) : null}
            </div>
            <div className="mail-actions">
              {paused ? (
                <button type="button" className="btn btn-small" onClick={() => onResume(s.id)}>
                  {t('重新开启')}
                </button>
              ) : null}
              {sid ? (
                <button type="button" className={paused ? 'btn btn-small' : 'btn btn-small btn-primary'} onClick={() => onOpen(sid)}>
                  {t('打开')}
                </button>
              ) : null}
            </div>
          </article>
        );
      })}
    </>
  );
}

/** After the first task is saved: once, the × of the window turns to 最小化到托盘 if the user wants (so tasks run on time). */
export function TrayAsk({ onYes, onNo }: { onYes(): void; onNo(): void }): ReactNode {
  return <ConfirmDialog title={t('关闭窗口时改为最小化到托盘？')} confirmLabel={t('最小化到托盘')} onConfirm={onYes} onCancel={onNo} />;
}
