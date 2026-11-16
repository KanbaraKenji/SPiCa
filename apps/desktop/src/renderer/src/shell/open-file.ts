// A press on a file (its card in the conversation, a path in an answer, a file in the details, a plugin page's
// openFile): the preview panel, or for a kind the panel does not show (shared/previewers.ts
// SYSTEM_PROGRAM_KINDS) the file's system program straight away, with its error in the notice bar.
import type { PluginView } from '../../../shared/plugin-view';
import { opensInSystemProgram } from '../../../shared/previewers';
import { friendlyError } from '../store/agent';

export interface FilePress {
  /** Preview pages there are (one for the kind keeps it in the panel). */
  pages: readonly PluginView[];
  /** The system program: null when it opened, else what went wrong (in words). */
  open(path: string): Promise<string | null>;
  preview(path: string): void;
  notice(text: string): void;
}

/** Opens `path` where a press on it goes; 'system' when that was its system program. */
export function pressFile(path: string, how: FilePress): 'system' | 'preview' {
  if (!opensInSystemProgram(path, how.pages)) {
    how.preview(path);
    return 'preview';
  }
  how.open(path).then(
    (err) => {
      if (err) how.notice(err);
    },
    (err: unknown) => how.notice(friendlyError(err)),
  );
  return 'system';
}
