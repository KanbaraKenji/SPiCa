// Ask before a note is overwritten (write_note with replace: true): the old text is gone afterwards, so the
// confirmation is marked irreversible and the card shows 无法撤销. Appending to a note asks nothing.
// (delete_note needs no hook: it is listed in the manifest's permissions.irreversible, which asks and marks
// the card by itself.)

/** @type {import('@spica/plugins/types').HookModule} */
export default {
  beforeTool(call) {
    // Hooks see every tool call; this plugin's tools are named <server>__<tool> (mcp/notes.json: notes).
    if (call.name !== 'notes__write_note') return;
    const input = /** @type {{ title?: unknown, replace?: unknown }} */ (call.input ?? {});
    if (input.replace !== true) return;
    return { action: 'confirm', reason: `覆盖笔记「${String(input.title ?? '')}」`, irreversible: true };
  },
};
