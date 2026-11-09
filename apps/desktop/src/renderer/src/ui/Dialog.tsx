// Modal confirmation. Says only what is being confirmed (no explanations).
import { useEffect, useId, useRef } from 'react';

export interface ConfirmDialogProps {
  title: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm(): void;
  onCancel(): void;
}

export function ConfirmDialog({ title, confirmLabel, danger, onConfirm, onCancel }: ConfirmDialogProps) {
  const id = useId();
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    confirmRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onCancel]);
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="dialog" role="alertdialog" aria-modal="true" aria-labelledby={id}>
        <p className="dialog-title" id={id}>
          {title}
        </p>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onCancel}>
            取消
          </button>
          <button type="button" ref={confirmRef} className={danger ? 'btn btn-danger' : 'btn btn-primary'} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
