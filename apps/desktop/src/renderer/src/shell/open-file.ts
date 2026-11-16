// A press on a file (its card in the conversation, a path in an answer, a file in the details, a plugin page's
// openFile): a kind the panel does not show in its system program straight away (shared/previewers.ts
// SYSTEM_PROGRAM_KINDS), with what goes wrong in the notice bar; anything else, pictures too, in the preview
// panel (as Claude does: a picture file opens beside the conversation; a press on it there shows it big).
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

export type PressedAs = 'system' | 'preview';

/** Opens `path` where a press on it goes, and says where. */
export function pressFile(path: string, how: FilePress): PressedAs {
  if (opensInSystemProgram(path, how.pages)) {
    how.open(path).then(
      (err) => {
        if (err) how.notice(err);
      },
      (err: unknown) => how.notice(friendlyError(err)),
    );
    return 'system';
  }
  how.preview(path);
  return 'preview';
}
