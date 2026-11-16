// A press on a file (its card in the conversation, a path in an answer, a file in the details, a plugin page's
// openFile): a picture big over the window (shared/previewers.ts PICTURE_KINDS), a kind the panel does not
// show in its system program straight away (SYSTEM_PROGRAM_KINDS), anything else in the preview panel; what
// goes wrong in the notice bar. A preview page a plugin has for the kind keeps it in the panel.
import type { PluginView } from '../../../shared/plugin-view';
import { fileExtension, opensInSystemProgram, PICTURE_KINDS, previewPagesFor } from '../../../shared/previewers';
import { friendlyError } from '../store/agent';

export interface FilePress {
  /** Preview pages there are (one for the kind keeps it in the panel). */
  pages: readonly PluginView[];
  /** The system program: null when it opened, else what went wrong (in words). */
  open(path: string): Promise<string | null>;
  /** A picture big over the window: its URL, or what went wrong (in words). */
  picture(path: string): Promise<{ url: string; name: string } | string>;
  /** Shows the picture over the window. */
  showPicture(p: { url: string; name: string }): void;
  preview(path: string): void;
  notice(text: string): void;
}

export type PressedAs = 'system' | 'picture' | 'preview';

/** Opens `path` where a press on it goes, and says where. */
export function pressFile(path: string, how: FilePress): PressedAs {
  const ext = fileExtension(path);
  const failed = (err: unknown) => how.notice(friendlyError(err));
  if (PICTURE_KINDS.has(ext) && previewPagesFor(ext, how.pages).length === 0) {
    how.picture(path).then((p) => (typeof p === 'string' ? how.notice(p) : how.showPicture(p)), failed);
    return 'picture';
  }
  if (opensInSystemProgram(path, how.pages)) {
    how.open(path).then((err) => {
      if (err) how.notice(err);
    }, failed);
    return 'system';
  }
  how.preview(path);
  return 'preview';
}
