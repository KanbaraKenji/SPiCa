// A field's problem said without moving its box (he found red text under a box moved it; he picked this way):
// the box turns red and the words sit inside it, at its right end. A field with no single box to write in (the
// model list, 花费上限, a switch, a list to pick from) says it after its name, on its line.
import type { ReactNode } from 'react';

/** After the field's name, on its line (fields with no single box). */
export function ProblemBeside({ problem }: { problem: string | null | undefined }) {
  if (!problem) return null;
  return <span className="field-error problem-beside">{problem}</span>;
}

/** Around a box: the problem inside it, at its right end. */
export function ProblemBox({ problem, children }: { problem: string | null | undefined; children: ReactNode }) {
  if (!problem) return <>{children}</>;
  return (
    <span className="has-problem-in-box">
      {children}
      <span className="field-error problem-in-box">{problem}</span>
    </span>
  );
}
