// 定时任务 (mock-up): the pieces every placement shares, so the three placements differ only in where they sit.
// - ScheduleRows: the list (a row: name, when it repeats and the next run, the last run, on / off, more).
// - ScheduleForm: one task's fields (名称, 内容, 重复, 时间, 文件夹, 模型), as a dialog or as settings rows.
// - ScheduleFacts: the same fields read-only, on the agent's card and in the details.
// - RunCards: the runs that wait for the user, in 收件箱.
import { useRef, useState, type ReactNode } from 'react';
import { Icon } from '../ui/Icon';
import { Select } from '../ui/Select';
import { Switch } from '../settings/Switch';
import { Group, Row } from '../settings/Group';
import { useModal } from '../ui/useModal';
import { SpicaStatusIcon } from '@spica/brand/react';
import { N_, t, tx } from '../../../shared/i18n';
import { DEMO_FORM } from './demo';
import { repeatText, RUN_WORDS, WEEK_ORDER, WEEKDAY_SHORT, whenText, type Repeat, type ScheduleItem, type ScheduleRun } from './model';

const MODELS = [
  { value: 'deepseek-flash', label: 'deepseek-flash' },
  { value: 'deepseek-pro', label: 'deepseek-pro' },
];

function lastRun(item: ScheduleItem): ScheduleRun | undefined {
  return item.runs[0];
}

/** The last run's state, as a status mark and its word (failed ones in the danger colour). */
function RunMark({ run }: { run: ScheduleRun | undefined }) {
  if (!run) return <span className="schedule-run is-none">—</span>;
  const icon = run.status === 'done' ? 'done' : run.status === 'waiting' ? 'waiting' : run.status === 'running' ? 'running' : 'stopped';
  return (
    <span className={`schedule-run is-${run.status}`}>
      <SpicaStatusIcon name={icon} size={14} />
      {t(RUN_WORDS[run.status])}
    </span>
  );
}

/** 每天 09:00 · 下次 明天 09:00 (paused: 已暂停; after failures: 连续 3 次失败，已暂停). */
export function scheduleLine(item: ScheduleItem, now: Date): string {
  // 一次: the time is the next run, said once
  const when = item.trigger.repeat.kind === 'once' ? t('一次') : repeatText(item.trigger.repeat);
  if (!item.enabled) return item.pausedAfterFailures ? `${when} · ${t('连续 {n} 次失败，已暂停', { n: item.pausedAfterFailures })}` : `${when} · ${t('已暂停')}`;
  return `${when} · ${t('下次 {when}', { when: whenText(item.nextAt, now) })}`;
}

export interface RowsProps {
  items: ScheduleItem[];
  now: Date;
  onToggle?: (id: string, on: boolean) => void;
  onOpen?: (item: ScheduleItem) => void;
  onMore?: (item: ScheduleItem, button: HTMLElement) => void;
}

/** The list on its own page (the sidebar's 定时任务). */
export function ScheduleRows({ items, now, onToggle, onOpen, onMore }: RowsProps) {
  return (
    <ul className="schedule-list">
      {items.map((s) => (
        <li key={s.id} className={s.enabled ? 'schedule-row' : 'schedule-row is-off'}>
          <button type="button" className="schedule-main" onClick={() => onOpen?.(s)} title={s.prompt}>
            <span className="schedule-name">{s.title}</span>
            <span className={s.pausedAfterFailures && !s.enabled ? 'schedule-when is-failed' : 'schedule-when'}>{scheduleLine(s, now)}</span>
          </button>
          <RunMark run={lastRun(s)} />
          <Switch on={s.enabled} label={s.enabled ? t('暂停') : t('开启')} onChange={(on) => onToggle?.(s.id, on)} />
          <button type="button" className="icon-btn" aria-label={t('更多')} title={t('更多')} onClick={(e) => onMore?.(s, e.currentTarget)}>
            <Icon name="more" size={16} />
          </button>
        </li>
      ))}
    </ul>
  );
}

/** The same list as settings rows (设置 › 定时任务). */
export function ScheduleSettingsRows({ items, now, onToggle, onOpen, onMore }: RowsProps) {
  return (
    <>
      {items.map((s) => (
        <Row key={s.id} title={<button type="button" className="schedule-title-btn" onClick={() => onOpen?.(s)}>{s.title}</button>} hint={scheduleLine(s, now)} className={s.enabled ? 'schedule-setting' : 'schedule-setting is-off'}>
          <RunMark run={lastRun(s)} />
          <Switch on={s.enabled} label={s.enabled ? t('暂停') : t('开启')} onChange={(on) => onToggle?.(s.id, on)} />
          <button type="button" className="icon-btn" aria-label={t('更多')} title={t('更多')} onClick={(e) => onMore?.(s, e.currentTarget)}>
            <Icon name="more" size={16} />
          </button>
        </Row>
      ))}
    </>
  );
}

type Kind = Repeat['kind'];
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
  model: string;
}

export function emptyForm(now: Date): FormValue {
  const d = new Date(now.getTime() + 86_400_000);
  return { title: '', prompt: '', kind: 'daily', time: '09:00', days: [1], every: '2', unit: 'hours', date: `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`, cwd: '', model: 'deepseek-flash' };
}

/** 每天 / 每周 / 间隔 / 一次 and what each needs, in one control row. */
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

export interface FormProps {
  initial: FormValue;
  onPickFolder?: () => void;
  onCancel(): void;
  onSave(v: FormValue): void;
}

/** 新建定时任务 as a dialog (the sidebar's page). */
export function ScheduleDialog({ initial, onCancel, onSave, onPickFolder }: FormProps) {
  const [v, setV] = useState(initial);
  const set = (p: Partial<FormValue>) => setV((x) => ({ ...x, ...p }));
  const box = useRef<HTMLFormElement>(null);
  const first = useRef<HTMLInputElement>(null);
  useModal(box, onCancel, first);
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <form
        className="dialog dialog-form schedule-dialog"
        ref={box}
        role="dialog"
        aria-modal="true"
        aria-label={t('新建定时任务')}
        onSubmit={(e) => {
          e.preventDefault();
          onSave(v);
        }}
      >
        <p className="dialog-title">{t('新建定时任务')}</p>
        <label className="form-field">
          <span className="field-label">{t('名称')}</span>
          <input ref={first} className="input" value={v.title} placeholder={t('每日报表')} onChange={(e) => set({ title: e.target.value })} />
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
            <input className="input" value={v.cwd} spellCheck={false} placeholder={DEMO_FORM.cwd}onChange={(e) => set({ cwd: e.target.value })} />
            <button type="button" className="btn btn-square" onClick={onPickFolder} aria-label={t('选择文件夹')} title={t('选择文件夹')}>
              <Icon name="folder" size={16} />
            </button>
          </span>
        </label>
        <div className="form-field">
          <span className="field-label">{t('模型')}</span>
          <Select label={t('模型')} value={v.model} options={MODELS} onChange={(model) => set({ model })} />
        </div>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onCancel}>
            {t('取消')}
          </button>
          <button type="submit" className="btn btn-primary" disabled={!v.title.trim() || !v.prompt.trim()}>
            {t('保存')}
          </button>
        </div>
      </form>
    </div>
  );
}

/** The same fields as settings rows (设置 › 定时任务 › 新建). */
export function ScheduleSettingsForm({ initial, onCancel, onSave, onPickFolder }: FormProps) {
  const [v, setV] = useState(initial);
  const set = (p: Partial<FormValue>) => setV((x) => ({ ...x, ...p }));
  return (
    <>
      <button type="button" className="back-link" onClick={onCancel}>
        <Icon name="arrowLeft" size={14} />
        {t('定时任务')}
      </button>
      <Group
        className="schedule-form-group"
        title={t('新建定时任务')}
        actions={
          <button type="button" className="btn btn-primary" disabled={!v.title.trim() || !v.prompt.trim()} onClick={() => onSave(v)}>
            {t('保存')}
          </button>
        }
      >
        <Row title={t('名称')} stack>
          <input className="input" value={v.title} placeholder={t('每日报表')} onChange={(e) => set({ title: e.target.value })} />
        </Row>
        <Row title={t('内容')} stack>
          <textarea className="input textarea" rows={3} value={v.prompt} placeholder={t('汇总昨天的来单，按客户列成表，存到 报表 文件夹')} onChange={(e) => set({ prompt: e.target.value })} />
        </Row>
        <Row title={t('重复')}>
          <RepeatFields v={v} set={set} />
        </Row>
        <Row title={v.kind === 'interval' ? t('间隔') : t('时间')}>
          <WhenFields v={v} set={set} />
        </Row>
        <Row title={t('文件夹')} hint={v.cwd || '—'} path={{ hint: v.cwd }}>
          <button type="button" className="btn" onClick={onPickFolder}>
            {t('更改')}
          </button>
        </Row>
        <Row title={t('模型')}>
          <Select label={t('模型')} value={v.model} options={MODELS} onChange={(model) => set({ model })} />
        </Row>
      </Group>
    </>
  );
}

/** What the agent's schedule_task names (its input), read-only: on its card and in the details. */
export function repeatOf(input: Record<string, unknown>): Repeat | null {
  const r = input.repeat as Partial<Repeat> | undefined;
  if (!r || typeof r !== 'object') return null;
  if (r.kind === 'daily' && typeof r.time === 'string') return { kind: 'daily', time: r.time };
  if (r.kind === 'weekly' && typeof r.time === 'string' && Array.isArray(r.days)) return { kind: 'weekly', time: r.time, days: r.days.map(Number) };
  if (r.kind === 'interval' && typeof r.minutes === 'number') return { kind: 'interval', minutes: r.minutes };
  if (r.kind === 'once' && typeof r.at === 'string') return { kind: 'once', at: r.at };
  return null;
}

export function ScheduleFacts({ input, extra }: { input: unknown; extra?: ReactNode }) {
  const v = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const repeat = repeatOf(v);
  const str = (k: string) => (typeof v[k] === 'string' ? (v[k] as string) : '');
  return (
    <dl className="schedule-facts">
      <dt>{t('名称')}</dt>
      <dd>{str('title') || '—'}</dd>
      <dt>{t('内容')}</dt>
      <dd>{str('prompt') || '—'}</dd>
      <dt>{t('重复')}</dt>
      <dd>{repeat ? repeatText(repeat) : '—'}</dd>
      <dt>{t('文件夹')}</dt>
      <dd className="schedule-path" title={str('cwd')}>
        {str('cwd') || '—'}
      </dd>
      <dt>{t('模型')}</dt>
      <dd>{str('model') || '—'}</dd>
      {extra}
    </dl>
  );
}

/** The details' 定时任务: the task this conversation runs for (or set up), and its last runs. */
export function ScheduleDetail({ item, now, onToggle, onOpenRun }: { item: ScheduleItem; now: Date; onToggle?: (on: boolean) => void; onOpenRun?: (sessionId: string) => void }) {
  return (
    <section className="detail-section">
      <h3 className="detail-title">{t('定时任务')}</h3>
      <div className="schedule-detail-head">
        <span className="schedule-name">{item.title}</span>
        <Switch on={item.enabled} label={item.enabled ? t('暂停') : t('开启')} onChange={(on) => onToggle?.(on)} />
      </div>
      <dl className="detail-facts">
        <dt>{t('重复')}</dt>
        <dd>{repeatText(item.trigger.repeat)}</dd>
        <dt>{t('下次')}</dt>
        <dd>{item.enabled ? whenText(item.nextAt, now) : '—'}</dd>
      </dl>
      <ul className="detail-list schedule-runs">
        {item.runs.slice(0, 5).map((r) => (
          <li key={r.id} className="detail-item">
            {r.sessionId && r.sessionId !== item.sessionId ? (
              <button type="button" className="schedule-run-line" onClick={() => onOpenRun?.(r.sessionId!)}>
                <span className="activity-time">{whenText(r.at, now)}</span>
                <RunMark run={r} />
              </button>
            ) : (
              <span className="schedule-run-line">
                <span className="activity-time">{whenText(r.at, now)}</span>
                <RunMark run={r} />
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** A run that waits for the user (a confirmation) or a task paused after failures: 收件箱's 定时任务 cards. */
export interface RunCard {
  id: string;
  title: string;
  status: 'waiting' | 'failed';
  at: string;
  /** What it waits for / why it stopped. */
  what: string;
  sessionId?: string;
  scheduleId: string;
}

export function RunCards({ cards, now, onOpen, onResume }: { cards: RunCard[]; now: Date; onOpen(sessionId: string): void; onResume?: (scheduleId: string) => void }) {
  return (
    <>
      {cards.map((c) => (
        <article key={c.id} className="mail-card is-open run-card" aria-label={c.title}>
          <div className="mail-top">
            <span className="mail-from">
              <Icon name="clock" size={14} />
              {t('定时任务')}
            </span>
            <span className="mail-time">{whenText(c.at, now)}</span>
          </div>
          <p className="mail-subject">{c.title}</p>
          <div className="mail-verdict">
            <span className={c.status === 'failed' ? 'mail-tag is-run is-failed' : 'mail-tag is-run'}>
              <SpicaStatusIcon name={c.status === 'failed' ? 'stopped' : 'waiting'} size={14} />
              {c.status === 'failed' ? t('已暂停') : t('等待确认')}
            </span>
            <span className="mail-reason">{tx(c.what)}</span>
          </div>
          <div className="mail-actions">
            {c.status === 'failed' && onResume ? (
              <button type="button" className="btn btn-small" onClick={() => onResume(c.scheduleId)}>
                {t('重新开启')}
              </button>
            ) : null}
            {c.sessionId ? (
              <button type="button" className="btn btn-small btn-primary" onClick={() => onOpen(c.sessionId!)}>
                {t('打开')}
              </button>
            ) : null}
          </div>
        </article>
      ))}
    </>
  );
}
