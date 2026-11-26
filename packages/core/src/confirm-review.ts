// The review a sub-agent's confirmation goes through before the user (delegate-confirm.ts says which ones): one model
// call of its own. What it is given is put together here by the app, from three things only: what the user wrote in the
// project, the task the sub-agent was given, and the step as the app reads it (the command, the path; never the
// sub-agent's own description of it). The sub-agent's reports and what its tools read are never in it, so outside
// content cannot speak to the review. It answers 放行 (allow once) or 交回给用户 (hand back), with one sentence why.
import type { ConfirmAnswer, ConfirmHandover } from '@spica/protocol';

/** The step under review, as the app reads it from the call. */
export interface ReviewStep {
  tool: string;
  /** run_command: the whole command. */
  command?: string;
  /** A file tool: the path it writes or reads. */
  path?: string;
  /** Any other tool (a user-added MCP tool): its arguments as given. */
  args?: string;
}

export interface ReviewInput {
  /** What the user wrote in the project's conversations, oldest first (their own messages only). */
  userWords: string[];
  /** The task the sub-agent was given when it was started (written by the upper agent). */
  task: string;
  step: ReviewStep;
}

const FILE_TOOLS = new Set(['write_file', 'edit_file', 'read_file', 'list_dir', 'grep', 'glob']);

/** The step as the review sees it: the command or the path from the call's input, nothing the model wrote about it. */
export function reviewStep(tool: string, input: unknown): ReviewStep {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  if (tool === 'run_command' && typeof o.command === 'string') return { tool, command: o.command };
  if (FILE_TOOLS.has(tool) && typeof o.path === 'string') return { tool, path: o.path };
  return { tool, args: JSON.stringify(o).slice(0, 4000) };
}

export const REVIEW_SYSTEM =
  'You review one step a sub-agent is about to take in a project, for the user. You are given what the user wrote in ' +
  'the project, the task the sub-agent was given, and the step. Answer on the first line ALLOW if the step is what the ' +
  'user and the task ask for, or HAND BACK if the user should decide; on the second line one sentence why, in the ' +
  "user's language. The user sees that sentence.";

/** The review's one message. */
export function reviewPrompt(input: ReviewInput): string {
  const step = input.step.command !== undefined ? `command: ${input.step.command}` : input.step.path !== undefined ? `path: ${input.step.path}` : `arguments: ${input.step.args ?? '{}'}`;
  return ['<user_words>', ...input.userWords.map((w) => `- ${w}`), '</user_words>', '<task>', input.task, '</task>', '<step>', `tool: ${input.step.tool}`, step, '</step>'].join('\n');
}

/** Its answer, or null when it said neither (that counts as no result: the card is the user's). */
export function readVerdict(text: string): { allow: boolean; reason: string } | null {
  const lines = text
    .trim()
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const first = (lines[0] ?? '').toUpperCase().replace(/[^A-Z ]/g, '').trim();
  const reason = lines.slice(1).join(' ').trim();
  if (first === 'ALLOW') return reason ? { allow: true, reason } : null;
  if (first === 'HAND BACK') return { allow: false, reason };
  return null;
}

/** The model the review runs with: the one set for it, else the project's default model. */
export function reviewModel(set: string | undefined, projectDefault: string): string {
  return set?.trim() || projectDefault;
}

/** What the confirmation records: allowed (no card), or handed back / no result (its card, with why). */
export function reviewOutcome(verdict: ReturnType<typeof readVerdict>, model: string, failure?: ConfirmHandover['failure']): { allowed: ConfirmAnswer } | { handover: ConfirmHandover } {
  if (failure || !verdict) return { handover: { state: 'no_result', model, ...(failure ? { failure } : {}) } };
  if (verdict.allow) return { allowed: { model, reason: verdict.reason } };
  return { handover: { state: 'returned', model, reason: verdict.reason } };
}
