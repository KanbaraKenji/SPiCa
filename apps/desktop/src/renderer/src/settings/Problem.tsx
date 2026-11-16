// A field's problem said without moving its box (problem-layout.ts): beside the field's name, or inside the box.
import type { ReactNode } from 'react';
import { PROBLEM_LAYOUT } from './problem-layout';

/** After the field's name. `always`: also in the in-box layout (a field with no single box to write in). */
export function ProblemBeside({ problem, always = false }: { problem: string | null | undefined; always?: boolean }) {
  if (!problem || (PROBLEM_LAYOUT !== 'beside-label' && !always)) return null;
  return <span className="field-error problem-beside">{problem}</span>;
}

/** Around a box: in the in-box layout the problem sits inside it, at its right end. */
export function ProblemBox({ problem, children }: { problem: string | null | undefined; children: ReactNode }) {
  if (!problem || PROBLEM_LAYOUT !== 'in-box') return <>{children}</>;
  return (
    <span className="has-problem-in-box">
      {children}
      <span className="field-error problem-in-box">{problem}</span>
    </span>
  );
}
