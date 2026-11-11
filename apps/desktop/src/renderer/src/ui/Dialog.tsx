// Modal confirmation. Says only what is being confirmed (no explanations).
// The keyboard stays inside it (useModal); confirming fires once.
import { useId, useRef, type ReactNode } from 'react';
import { useModal } from './useModal';

export interface ConfirmDialogProps {
  title: string;
  /** One plain line under the title, when what happens is not obvious (e.g. what is not deleted); or what exactly would run. */
  detail?: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm(): void;
  onCancel(): void;
}

export function ConfirmDialog({ title, detail, confirmLabel, danger, onConfirm, onCancel }: ConfirmDialogProps) {
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const done = useRef(false);
  useModal(box, onCancel, confirmRef);
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="dialog" role="alertdialog" aria-modal="true" aria-labelledby={id} ref={box}>
        <p className="dialog-title" id={id}>
          {title}
        </p>
        {detail ? typeof detail === 'string' ? <p className="dialog-detail">{detail}</p> : <div className="dialog-detail">{detail}</div> : null}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onCancel}>
            取消
          </button>
          <button
            type="button"
            ref={confirmRef}
            className={danger ? 'btn btn-danger' : 'btn btn-primary'}
            onClick={() => {
              if (done.current) return;
              done.current = true;
              onConfirm();
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
