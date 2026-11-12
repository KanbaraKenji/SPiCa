// The question the window's × asks while 设置 › 常规 › 关闭窗口时 is 每次询问 (main/tray.ts), laid out as he drew it:
// the title; two choices as radio buttons, 最小化到托盘 (selected at first) and 退出; under them 不再提醒 (unticked) at
// the left and 确定 (the main button, with the focus) at the right. Nothing explained (he asked for no explanations);
// one line between the title and the choices only while a conversation runs: 退出 stops it. Built like ConfirmDialog
// (ui/Dialog.tsx): the same scrim, box, title and button. Enter is 确定. Closing it the ways every dialog closes (Esc
// through useModal, a click outside, the × at the top right) is no choice: the window stays as it was and the next ×
// asks again; a ticked 不再提醒 is not kept. Ticked and 确定: the selected choice becomes 关闭窗口时. No 取消 button
// (he asked for none). The × is the settings dialog's close button (icon-btn, close icon); it comes last in the markup
// so Tab reaches it after 确定.
import { useEffect, useId, useRef, useState } from 'react';
import type { DesktopBridge } from '../../../shared/bridge';
import { APP_NAME } from '../../../shared/app-identity';
import { useModal } from './useModal';
import { Icon } from './Icon';
import { CLOSE_QUESTION, CLOSE_REMEMBER, CLOSE_RUNNING } from '../../../shared/close-words';

const CHOICES = [
  ['tray', '最小化到托盘'],
  ['quit', `退出 ${APP_NAME}`],
] as const;

type Answer = { choice: 'tray' | 'quit' | null; remember: boolean };

export interface CloseDialogProps {
  onAnswer(answer: Answer): void;
  /** A conversation is running: one line says 退出 stops it. */
  running?: boolean;
}

export function CloseDialog({ onAnswer, running = false }: CloseDialogProps) {
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  const okRef = useRef<HTMLButtonElement>(null);
  const [choice, setChoice] = useState<'tray' | 'quit'>('tray');
  const [remember, setRemember] = useState(false);
  const done = useRef(false);
  const answer = (picked: Answer['choice']) => {
    if (done.current) return;
    done.current = true;
    onAnswer({ choice: picked, remember: picked !== null && remember });
  };
  useModal(box, () => answer(null), okRef);
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && answer(null)}>
      <div
        className="dialog close-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
        ref={box}
        onKeyDown={(e) => {
          // Enter is 确定 (on a button, the button's own click)
          if (e.key !== 'Enter' || e.target instanceof HTMLButtonElement) return;
          e.preventDefault();
          answer(choice);
        }}
      >
        <p className="dialog-title" id={id}>
          {CLOSE_QUESTION}
        </p>
        {running ? <p className="dialog-detail">{CLOSE_RUNNING}</p> : null}
        <div className="close-dialog-choices" role="radiogroup" aria-labelledby={id}>
          {CHOICES.map(([value, label]) => (
            <label key={value} className="dialog-check">
              <input type="radio" name={`${id}-choice`} checked={choice === value} onChange={() => setChoice(value)} />
              {label}
            </label>
          ))}
        </div>
        <div className="close-dialog-foot">
          <label className="dialog-check">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            {CLOSE_REMEMBER}
          </label>
          <button type="button" ref={okRef} className="btn btn-primary" onClick={() => answer(choice)}>
            确定
          </button>
        </div>
        <button type="button" className="icon-btn close-dialog-x" aria-label="关闭" title="关闭（Esc）" onClick={() => answer(null)}>
          <Icon name="close" size={16} />
        </button>
      </div>
    </div>
  );
}

/** Listens for the question while mounted (one at a time) and sends the answer back. */
export function CloseAsk({ bridge }: { bridge: Pick<DesktopBridge, 'closeAsk'> }) {
  // one question at a time: a second × while it is open changes nothing (it keeps what it said)
  const [open, setOpen] = useState<{ key: number; running: boolean } | null>(null);
  useEffect(() => bridge.closeAsk.listen((ask) => setOpen((o) => o ?? { key: Date.now(), running: ask.running })), [bridge]);
  if (!open) return null;
  return (
    <CloseDialog
      key={open.key}
      running={open.running}
      onAnswer={(a) => {
        setOpen(null);
        bridge.closeAsk.answer(a);
      }}
    />
  );
}
