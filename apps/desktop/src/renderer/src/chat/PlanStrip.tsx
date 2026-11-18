// The conversation's plan (update_plan) above the message box: one line (how far, the step being worked on) that
// opens to all the steps. The list opens above the line, so the line stays where it was clicked.
import { useState } from 'react';
import { planProgress, type PlanStep } from '@spica/protocol';
import { SpicaStatusIcon } from '@spica/brand/react';
import { Icon } from '../ui/Icon';
import { t } from '../../../shared/i18n';

/** A step's mark: done, being worked on (turning while the run goes), not started. */
function StepMark({ status, running }: { status: PlanStep['status']; running: boolean }) {
  if (status === 'completed') return <SpicaStatusIcon name="done" size={14} />;
  if (status === 'in_progress' && running) return <SpicaStatusIcon name="running" size={14} />;
  return <span className={`plan-dot${status === 'in_progress' ? ' is-current' : ''}`} aria-hidden="true" />;
}

const STATUS_WORDS: Record<PlanStep['status'], string> = { completed: '已完成', in_progress: '进行中', pending: '未开始' };

/** `running`: the run is going (the step in progress turns). `record`: a finished plan back in the conversation. */
export function PlanStrip({ steps, running, record = false }: { steps: PlanStep[]; running: boolean; record?: boolean }) {
  const [open, setOpen] = useState(false);
  const { done, total, current, currentIndex } = planProgress(steps);
  const all = done === total;
  const line = all ? t('已完成') : (current?.step ?? '');
  return (
    <section className={`plan-strip${open ? ' is-open' : ''}${record ? ' is-record' : ''}`} aria-label={t('清单')}>
      {open ? (
        <ol className="plan-steps">
          {steps.map((s, i) => (
            <li key={i} className={`plan-step is-${s.status}`} aria-label={`${s.step}（${t(STATUS_WORDS[s.status])}）`}>
              <span className="plan-mark">
                <StepMark status={s.status} running={running} />
              </span>
              <span className="plan-step-text">{s.step}</span>
            </li>
          ))}
        </ol>
      ) : null}
      <button type="button" className="plan-line" aria-expanded={open} onClick={() => setOpen((v) => !v)} title={open ? t('收起') : t('展开')}>
        <span className="plan-mark">{all ? <SpicaStatusIcon name="done" size={14} /> : <StepMark status={current?.status ?? 'pending'} running={running} />}</span>
        <span className="plan-count">{`${all ? total : currentIndex + 1} / ${total}`}</span>
        <span className="plan-current">{line}</span>
        <Icon name="chevronDown" size={14} className="plan-chevron" />
      </button>
    </section>
  );
}
