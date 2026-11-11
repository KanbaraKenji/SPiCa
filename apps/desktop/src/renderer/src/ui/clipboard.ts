// The one place the page writes the clipboard (tests replace these). `writeRich` puts plain text and HTML on it
// together, so a table pastes into Excel as cells and into a text box as tab-separated lines.
export const clipboard = {
  write: (text: string): Promise<void> => navigator.clipboard.writeText(text),
  writeRich: (text: string, html: string): Promise<void> =>
    navigator.clipboard.write([new ClipboardItem({ 'text/plain': new Blob([text], { type: 'text/plain' }), 'text/html': new Blob([html], { type: 'text/html' }) })]),
};
