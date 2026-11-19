// 操作电脑's approval card: every program the task needs that is not allowed yet, on one card, allowed with one
// click. Waiting: 操作 N 个程序, 拒绝 and 始终允许 (允许一次 in its menu), then one row per program (its icon,
// name, 只看 / 只能点 / 高风险, and where it is). Answered: one line, as an answered question card (the mark, 已始终允许
// N 个程序), as wide as its words; pressing it shows the programs under it.
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { SpicaStatusIcon } from '@spica/brand/react';
import { N_, t } from '../../../shared/i18n';
import type { ComputerBlock, ComputerCardApp } from '../store/computer-card';
import { ContextMenu } from '../ui/ContextMenu';
import { Icon } from '../ui/Icon';

const CARD_STOPPED = N_('已中断');

/**
 * 始终允许, with 允许一次 in the menu beside it. A stand-in until the confirmation card's own button is chosen (its
 * redo is decided elsewhere); it takes the same props as the card's 允许 (HoldToAllow), so it can be swapped for it.
 */
export function AllowChoice({ disabled, onAllow }: { disabled: boolean; onAllow(always: boolean): void }) {
  // the pair of buttons while the menu is open (it sits under them)
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const open = anchor !== null;
  return (
    <span className="allow-choice">
      <button type="button" className="btn btn-primary" disabled={disabled} onClick={() => onAllow(true)}>
        {t('始终允许')}
      </button>
      <button
        type="button"
        className="btn btn-primary allow-choice-more"
        disabled={disabled}
        aria-label={t('其他允许方式')}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => setAnchor(open ? null : e.currentTarget.parentElement)}
      >
        <Icon name="chevronDown" size={14} />
      </button>
      {/* on the page itself: inside the conversation a fixed menu would be placed from the card, not the window */}
      {anchor
        ? createPortal(
            <ContextMenu x={0} y={0} anchor={anchor} minWidth={anchor.offsetWidth} items={[{ label: t('允许一次'), onSelect: () => onAllow(false) }]} onClose={() => setAnchor(null)} />,
            document.body,
          )
        : null}
    </span>
  );
}

/** What a program may do, after its name: 只看, 只能点 (grey), 高风险 (red, as 无法撤销). */
function Tag({ app }: { app: ComputerCardApp }) {
  if (app.highRisk) return <span className="confirm-undo">{t('高风险')}</span>;
  if (app.tier === 'view') return <span className="computer-tag">{t('只看')}</span>;
  if (app.tier === 'click') return <span className="computer-tag">{t('只能点')}</span>;
  return null;
}

/** The programs, one a row: icon, name and tag, then where it is (and a shared program's window). */
function AppList({ apps }: { apps: ComputerCardApp[] }) {
  return (
    <div className="computer-apps">
      {apps.map((a) => {
        const where = [a.title, a.exe].filter(Boolean).join(' · ');
        return (
          <div key={a.exe || a.name} className="computer-app">
            {a.icon ? <img className="computer-app-icon" src={a.icon} alt="" width={16} height={16} /> : <span className="computer-app-icon" aria-hidden="true" />}
            <div className="computer-app-text">
              <div className="computer-app-name">
                <span>{a.name}</span>
                <Tag app={a} />
              </div>
              {where ? (
                <p className="card-sub" title={where}>
                  {where}
                </p>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function ComputerCard({ block, onDecide }: { block: ComputerBlock; onDecide(approved: boolean, always: boolean): void }) {
  const [sent, setSent] = useState(false);
  // live: what was chosen here (the result says it once the call ran; after a restart only the result)
  const [chosen, setChosen] = useState<boolean | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const n = block.apps.length;
  const decide = (approved: boolean, always = false) => {
    if (sent) return;
    setSent(true);
    if (approved) setChosen(always);
    onDecide(approved, always);
  };
  if (block.approved === undefined && !block.cancelled) {
    return (
      <section className="card confirm-card computer-card" aria-label={t('确认')}>
        <header className="card-head">
          <span className="card-title">{t('操作 {n} 个程序', { n })}</span>
          <span className="confirm-spacer" />
          <div className="card-actions">
            <button type="button" className="btn" disabled={sent} onClick={() => decide(false)}>
              {t('拒绝')}
            </button>
            <AllowChoice disabled={sent} onAllow={(always) => decide(true, always)} />
          </div>
        </header>
        <AppList apps={block.apps} />
      </section>
    );
  }
  const always = block.always ?? chosen;
  const words = block.cancelled ? t(CARD_STOPPED) : block.approved ? (always ? t('已始终允许 {n} 个程序', { n }) : t('已允许一次 {n} 个程序', { n })) : t('已拒绝 {n} 个程序', { n });
  const ok = block.approved === true;
  return (
    <section className={['card', 'confirm-card', 'is-done', 'computer-card', 'is-line', block.cancelled ? 'is-stopped' : ''].filter(Boolean).join(' ')} aria-label={t('确认')}>
      <button type="button" className="computer-line" aria-expanded={open} title={block.apps.map((a) => a.name).join(t('、'))} onClick={() => setOpen((o) => !o)}>
        <SpicaStatusIcon name={ok ? 'done' : 'stopped'} size={15} />
        <span>{words}</span>
        <Icon className={open ? 'computer-line-chevron is-open' : 'computer-line-chevron'} name="chevronRight" size={14} />
      </button>
      {open ? <AppList apps={block.apps} /> : null}
    </section>
  );
}
