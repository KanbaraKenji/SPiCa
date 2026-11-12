// The question the window's × asks while 设置 › 常规 › 关闭窗口时 is 每次询问 (main/tray.ts): 最小化到托盘 or
// 退出, each with a line on what happens, and 记住我的选择 (unticked). Built like ConfirmDialog (ui/Dialog.tsx):
// the same scrim, box, title, detail and buttons. Closing it the ways every dialog closes (Esc through useModal,
// a click outside) is no choice: the window stays as it was. No 取消 button (he asked for none).
import { useEffect, useId, useRef, useState } from 'react';
import type { DesktopBridge } from '../../../shared/bridge';
import { APP_NAME } from '../../../shared/app-identity';
import { useModal } from './useModal';

type Answer = { choice: 'tray' | 'quit' | null; remember: boolean };

export interface CloseDialogProps {
  onAnswer(answer: Answer): void;
}

export function CloseDialog({ onAnswer }: CloseDialogProps) {
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
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby={id} ref={box}>
        <p className="dialog-title" id={id}>
          关闭窗口时要怎么做？
        </p>
        <p className="dialog-detail">最小化到托盘：窗口收起，{APP_NAME} 继续运行，从托盘图标再打开。</p>
        <p className="dialog-detail">退出 {APP_NAME}：结束 {APP_NAME} 和正在进行的任务。</p>
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
    </div>
  );
}

/** Listens for the question while mounted (one at a time) and sends the answer back. */
export function CloseAsk({ bridge }: { bridge: Pick<DesktopBridge, 'closeAsk'> }) {
  const [open, setOpen] = useState(0);
  useEffect(() => bridge.closeAsk.listen(() => setOpen((n) => n || Date.now())), [bridge]);
  if (!open) return null;
  return (
    <CloseDialog
      key={open}
      onAnswer={(a) => {
        setOpen(0);
        bridge.closeAsk.answer(a);
      }}
    />
  );
}
