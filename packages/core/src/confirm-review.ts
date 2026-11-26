// The review a sub-agent's confirmation goes through before the user (delegate-confirm.ts says which ones): one model
// call of its own. What it is given is put together here by the app, from three things only: what the user wrote in the
// project, the task the sub-agent was given, and the step as the app reads it (the command, the path; never the
// sub-agent's own description of it). The sub-agent's reports and what its tools read are never in it. What it is
// given is still written in part by agents: the command or an MCP tool's arguments by the sub-agent (a comment in a
// command can speak to the review), the task by the upper agent. It answers 放行 (allow once) or 交回给用户 (hand
// back), with one sentence why.
import type { ConfirmAnswer, ConfirmHandover } from '@spica/protocol';
import type { RuntimeInternals } from './runtime.ts';
import { isoNow } from './events.ts';
import { ProviderError } from './providers/types.ts';
import { isAbortError } from './util.ts';

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
  'user and the task ask for, or HAND BACK if the user should decide (these two words exactly, in English); on the ' +
  "second line one sentence why, in the user's language. The user sees that sentence.";

/** The review's one message. */
export function reviewPrompt(input: ReviewInput): string {
  const step = input.step.command !== undefined ? `command: ${input.step.command}` : input.step.path !== undefined ? `path: ${input.step.path}` : `arguments: ${input.step.args ?? '{}'}`;
  const words = input.userWords.length ? input.userWords.map((w) => `- ${w}`) : ['(none)'];
  return ['<user_words>', ...words, '</user_words>', '<task>', input.task, '</task>', '<step>', `tool: ${input.step.tool}`, step, '</step>'].join('\n');
}

const VERDICT = /^[\s*_#>`"'“【[]*(ALLOW|HAND[\s_-]*BACK|放行|交回(?:给用户)?)(?![A-Za-z])[\s*_`"'”】\].:：,，;；-]*(.*)$/i;

/**
 * Its answer, or null when it said neither (that counts as no result: the card is the user's). The word starts a line
 * (the first that has one), alone or with the reason after it (ALLOW: …, **HAND BACK** - …); 放行 / 交回 are taken too.
 * Allowing needs a reason.
 */
export function readVerdict(text: string): { allow: boolean; reason: string } | null {
  const lines = text
    .trim()
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const at = lines.findIndex((l) => VERDICT.test(l));
  if (at < 0) return null;
  const m = VERDICT.exec(lines[at]!)!;
  const reason = [m[2] ?? '', ...lines.slice(at + 1)].join(' ').replace(/\s+/g, ' ').trim();
  if (/^(allow|放行)$/i.test(m[1]!)) return reason ? { allow: true, reason } : null;
  return { allow: false, reason };
}

/** Why the review gave nothing, as ConfirmHandover['failure']. */
export class ReviewFailed extends Error {
  readonly failure: NonNullable<ConfirmHandover['failure']>;
  constructor(failure: NonNullable<ConfirmHandover['failure']>, message: string) {
    super(message);
    this.failure = failure;
  }
}

/** How long the review may take once a slot with its connection is free. */
export const REVIEW_TIMEOUT_MS = 60_000;

/**
 * The review's one model call, as a conversation's call is made: held against the spending limits and recorded under
 * the sub-agent's conversation (so it is the project's spending), through the connection's rate limiter, traced.
 * Throws ReviewFailed (spend_limit, timeout, error); a stop of the run throws the abort as it is.
 */
export async function runReview(
  rt: Pick<RuntimeInternals, 'provider' | 'limiter' | 'ledger' | 'tracer'>,
  opts: { providerId: string; model: string; sessionId: string; parentChain: string[]; prompt: string; signal: AbortSignal; timeoutMs?: number },
): Promise<string> {
  let provider;
  try {
    provider = rt.provider(opts.providerId);
  } catch (err) {
    throw new ReviewFailed('error', err instanceof Error ? err.message : String(err));
  }
  // room for a model that thinks before it answers (the answer itself is two lines)
  const maxTokens = 2000;
  const scope = { providerId: provider.id, providerKind: provider.kind, model: opts.model, sessionId: opts.sessionId, runId: `review-${Date.now()}` };
  const lease = await rt.limiter(provider.id).acquire({ signal: opts.signal });
  try {
    const hold = rt.ledger.reserve(scope, Math.ceil((REVIEW_SYSTEM.length + opts.prompt.length) / 1.5), maxTokens);
    if (!hold.ok) throw new ReviewFailed('spend_limit', hold.message);
    const timer = AbortSignal.timeout(opts.timeoutMs ?? REVIEW_TIMEOUT_MS);
    const signal = AbortSignal.any([opts.signal, timer]);
    const trace = rt.tracer.start({ kind: 'model', sessionId: opts.sessionId, parentChain: opts.parentChain, initiator: 'runtime:confirm-review', target: provider.traceTarget, providerId: provider.id, model: opts.model });
    const info = trace.watch({ attempts: 0 });
    let text = '';
    try {
      let response: { usage: import('./types.ts').Usage; model: string } | undefined;
      for await (const ev of provider.stream(
        {
          model: opts.model,
          system: REVIEW_SYSTEM,
          messages: [{ id: 'confirm-review', sessionId: opts.sessionId, seq: 1, role: 'user', kind: 'user', content: [{ type: 'text', text: opts.prompt }], createdAt: isoNow() }],
          tools: [],
          maxTokens,
        },
        { signal, info },
      )) {
        if (ev.type === 'text') text += ev.delta;
        else if (ev.type === 'response') response = ev.response;
      }
      if (!response) throw new Error('the model gave no answer');
      const cost = rt.ledger.record(scope, response.usage);
      trace.finish({ status: 'ok', attempts: info.attempts, inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens, ...(cost.unpriced ? { unpriced: true as const } : { costUsd: cost.costUsd }), model: response.model });
      return text;
    } catch (err) {
      hold.release();
      const stopped = opts.signal.aborted;
      trace.finish({ status: stopped || isAbortError(err) ? 'aborted' : 'error', attempts: info.attempts, error: err instanceof Error ? err.message : String(err), ...(err instanceof ProviderError && err.code ? { errorCode: err.code } : {}) });
      if (stopped) throw err;
      if (timer.aborted) throw new ReviewFailed('timeout', 'no answer in time');
      throw new ReviewFailed('error', err instanceof Error ? err.message : String(err));
    }
  } finally {
    lease.release();
  }
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
