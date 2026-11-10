// "新项目": name, folder (typed or picked), and optionally the first task for
// the project manager. Creating it opens the project manager's conversation.
import { useId, useRef, useState } from "react";
import { useModal } from "../ui/useModal";
import { useGuard } from "../ui/guard";
import { APP_NAME } from "../../../shared/app-identity";

export interface NewProjectInput {
  name: string;
  folder?: string;
  brief?: string;
}

export interface NewProjectDialogProps {
  onPickFolder(): Promise<string | null>;
  onCreate(input: NewProjectInput): Promise<string | null>;
  onClose(): void;
  /** Prefilled name (e.g. what the mail sorting suggested). */
  initialName?: string;
}

export function NewProjectDialog({
  onPickFolder,
  onCreate,
  onClose,
  initialName = "",
}: NewProjectDialogProps) {
  const id = useId();
  const [name, setName] = useState(initialName);
  const [folder, setFolder] = useState("");
  const [brief, setBrief] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  const box = useRef<HTMLFormElement>(null);
  useModal(box, onClose, nameRef);
  const run = useGuard();

  const pick = async () => {
    const chosen = await onPickFolder();
    if (chosen) {
      setFolder(chosen);
      if (!name.trim())
        setName(chosen.split(/[\\/]/).filter(Boolean).pop() ?? "");
    }
  };

  const submit = () =>
    run(async () => {
      if (!name.trim()) {
        setError("请填写项目名称");
        nameRef.current?.focus();
        return;
      }
      setBusy(true);
      setError("");
      const problem = await onCreate({
        name: name.trim(),
        ...(folder.trim() ? { folder: folder.trim() } : {}),
        ...(brief.trim() ? { brief: brief.trim() } : {}),
      });
      setBusy(false);
      if (problem) setError(problem);
    });

  return (
    <div
      className="scrim"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <form
        className="dialog dialog-form"
        ref={box}
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <p className="dialog-title" id={id}>
          新项目
        </p>
        <label className="form-field">
          <span className="field-label">名称</span>
          <input
            ref={nameRef}
            className="input"
            value={name}
            maxLength={60}
            onChange={(e) => setName(e.target.value)}
            placeholder="样机评审"
          />
        </label>
        <label className="form-field">
          <span className="field-label">文件夹</span>
          <span className="form-inline">
            <input
              className="input"
              value={folder}
              spellCheck={false}
              onChange={(e) => setFolder(e.target.value)}
              placeholder={`默认：文档\\${APP_NAME}`}
            />
            <button type="button" className="btn" onClick={() => void pick()}>
              选择…
            </button>
          </span>
        </label>
        <label className="form-field">
          <span className="field-label">首个任务（可选）</span>
          <textarea
            className="input textarea"
            rows={3}
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            placeholder="首个任务"
          />
        </label>
        {error ? (
          <p className="field-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? <span className="spinner" aria-hidden /> : null}
            创建
          </button>
        </div>
      </form>
    </div>
  );
}
