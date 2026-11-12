// The question the window's × asks while 设置 › 常规 › 关闭窗口时 is 每次询问 (main/tray.ts): the title, 记住我的选择
// (unticked) and 退出 / 最小化到托盘, nothing explained (he asked for no explanations).
// One line only while a conversation runs: 退出 stops it. Built like ConfirmDialog (ui/Dialog.tsx): the same scrim,
// box, title and buttons; the check under the title, the buttons at the right under it. Closing it the ways every dialog closes
// (Esc through useModal, a click outside, the × at the top right) is no choice: the window stays as it was and the next ×
// asks again; a ticked 记住我的选择 is not kept. No 取消 button (he asked for none). The × is the settings dialog's close
// button (icon-btn, close icon); it comes last in the markup so Tab reaches it after the two choices.
import { useEffect, useId, useRef, useState } from 'react';
import type { DesktopBridge } from '../../../shared/bridge';
import { APP_NAME } from '../../../shared/app-identity';
import { useModal } from './useModal';
import { Icon } from './Icon';
import { CLOSE_RUNNING } from '../../../shared/close-words';

type Answer = { choice: 'tray' | 'quit' | null; remember: boolean };

export interface CloseDialogProps {
  onAnswer(answer: Answer): void;
  /** A conversation is running: one line says 退出 stops it. */
  running?: boolean;
}

export function CloseDialog({ onAnswer, running = false }: CloseDialogProps) {
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  const trayRef = useRef<HTMLButtonElement>(null);
  const [remember, setRemember] = useState(false);
  const done = useRef(false);
  const answer = (choice: Answer['choice']) => {
    if (done.current) return;
    done.current = true;
    onAnswer({ choice, remember: choice !== null && remember });
  };
  useModal(box, () => answer(null), trayRef);
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && answer(null)}>
      <div className="dialog close-dialog" role="dialog" aria-modal="true" aria-labelledby={id} ref={box}>
        <p className="dialog-title" id={id}>
          关闭窗口时要怎么做？
        </p>
        {running ? <p className="dialog-detail">{CLOSE_RUNNING}</p> : null}
        <div className="close-dialog-foot">
          <label className="dialog-check">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            记住我的选择
          </label>
          <div className="dialog-actions">
            <button type="button" className="btn" onClick={() => answer('quit')}>
              退出 {APP_NAME}
            </button>
            <button type="button" ref={trayRef} className="btn btn-primary" onClick={() => answer('tray')}>
              最小化到托盘
            </button>
          </div>
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
