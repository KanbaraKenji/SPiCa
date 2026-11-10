/**
 * Something new here (mail for a project, a progress report nobody has seen):
 * one small dot, the same on a project row, on the tab not shown and on the
 * icon column; what it is shows on hover and is read out.
 */
export function NewDot({ text }: { text: string }) {
  return <span className="new-dot" role="img" aria-label={text} title={text} />;
}

/** Several notes as one: 「有新来信」 and 「有新回报」 together read 「有新来信 · 有新回报」 (each once). */
export function joinNotes(notes: Iterable<string>): string {
  const parts: string[] = [];
  for (const n of notes) for (const p of n.split(' · ')) if (p && !parts.includes(p)) parts.push(p);
  return parts.join(' · ');
}
