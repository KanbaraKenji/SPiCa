// The question the window's × asks while 设置 › 常规 › 关闭窗口时 is 每次询问 (main/tray.ts), laid out as he drew it:
// the title; two choices as radio buttons, 最小化到托盘 (selected at first) and 退出; under them 不再提醒 (unticked) at
// the left and 确定 (the main button, with the focus) at the right. Nothing explained (he asked for no explanations);
// one line between the title and the choices only while a conversation runs: 退出 stops it. Built like ConfirmDialog
// (ui/Dialog.tsx): the same scrim, box, title and button; drawn by ui/ChoiceDialog.tsx, which every such question
// shares. Enter is 确定. Closing it the ways every dialog closes (Esc
// through useModal, a click outside, the × at the top right) is no choice: the window stays as it was and the next ×
// asks again; a ticked 不再提醒 is not kept. Ticked and 确定: the selected choice becomes 关闭窗口时. No 取消 button
// (he asked for none). The × is the settings dialog's close button (icon-btn, close icon); it comes last in the markup
// so Tab reaches it after 确定.
import { useEffect, useState } from 'react';
import type { DesktopBridge } from '../../../shared/bridge';
import { APP_NAME } from '../../../shared/app-identity';
import { ChoiceDialog } from './ChoiceDialog';
import { CLOSE_QUESTION, CLOSE_REMEMBER, CLOSE_RUNNING } from '../../../shared/close-words';
import { t } from '../../../shared/i18n';
import { useLocale } from '../i18n';

const choices = () =>
  [
    ['tray', t('最小化到托盘')],
    ['quit', t('退出 {app}', { app: APP_NAME })],
  ] as const;

type Answer = { choice: 'tray' | 'quit' | null; remember: boolean };

export interface CloseDialogProps {
  onAnswer(answer: Answer): void;
  /** A conversation is running: one line says 退出 stops it. */
  running?: boolean;
}

export function CloseDialog({ onAnswer, running = false }: CloseDialogProps) {
  // Mounted beside App, not under it: redraws itself when the language changes.
  useLocale();
  return <ChoiceDialog title={t(CLOSE_QUESTION)} detail={running ? t(CLOSE_RUNNING) : undefined} choices={choices()} rememberLabel={t(CLOSE_REMEMBER)} onAnswer={onAnswer} />;
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
