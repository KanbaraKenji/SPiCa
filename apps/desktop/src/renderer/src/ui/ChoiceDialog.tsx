// A question with a few answers as radio buttons, a checkbox to keep the answer (不再提醒, 记住我的选择), and 确定 — the
// way he drew the window's × question (ui/CloseDialog.tsx), shared by every question with two or more places to go
// (where a web address opens, shell/links.tsx). Built like ConfirmDialog (ui/Dialog.tsx): the same scrim, box, title
// and button. The first answer is selected at first, the checkbox unticked; Enter is 确定. Closing it the ways every
// dialog closes (Esc through useModal, a click outside, the × at the top right) is no answer, and a ticked box is not
// kept. No 取消 button (he asked for none for the close question). The × comes last in the markup so Tab reaches it
// after 确定.
import { useId, useRef, useState, type ReactNode } from 'react';
import { useModal } from './useModal';
import { Icon } from './Icon';
import { t } from '../../../shared/i18n';

export interface ChoiceAnswer<T extends string> {
  /** null: closed without an answer. */
  choice: T | null;
  /** The box was ticked (always false without an answer). */
  remember: boolean;
}

export interface ChoiceDialogProps<T extends string> {
  title: string;
  /** One line under the title, only when something must be said (a running conversation). */
  detail?: ReactNode;
  choices: readonly (readonly [T, string])[];
  /** The checkbox's label. */
  rememberLabel: string;
  onAnswer(answer: ChoiceAnswer<T>): void;
}

export function ChoiceDialog<T extends string>({ title, detail, choices, rememberLabel, onAnswer }: ChoiceDialogProps<T>) {
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  const okRef = useRef<HTMLButtonElement>(null);
  const [choice, setChoice] = useState<T>(choices[0]![0]);
  const [remember, setRemember] = useState(false);
  const done = useRef(false);
  const answer = (picked: T | null) => {
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
          {title}
        </p>
        {detail ? <p className="dialog-detail">{detail}</p> : null}
        <div className="close-dialog-choices" role="radiogroup" aria-labelledby={id}>
          {choices.map(([value, label]) => (
            <label key={value} className="dialog-check">
              <input type="radio" name={`${id}-choice`} checked={choice === value} onChange={() => setChoice(value)} />
              {label}
            </label>
          ))}
        </div>
        <div className="close-dialog-foot">
          <label className="dialog-check">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            {rememberLabel}
          </label>
          <button type="button" ref={okRef} className="btn btn-primary" onClick={() => answer(choice)}>
            {t('确定')}
          </button>
        </div>
        <button type="button" className="icon-btn close-dialog-x" aria-label={t('关闭')} title={t('关闭（Esc）')} onClick={() => answer(null)}>
          <Icon name="close" size={16} />
        </button>
      </div>
    </div>
  );
}
