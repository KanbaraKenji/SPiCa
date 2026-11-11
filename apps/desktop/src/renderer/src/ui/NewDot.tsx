/**
 * Something new (mail for a project, a progress report nobody has seen): one small dot on the
 * sidebar toggle while the sidebar is collapsed; what it is shows on hover and is read out.
 * In the open sidebar the rows say it themselves, in their status place.
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
