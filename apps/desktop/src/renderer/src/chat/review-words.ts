// How the window says a sub-agent's confirmation went through the review first (a model call of its own, not the
// upper agent): while it waits, once allowed, handed back, or with no result; and the project's switch for it.
// Candidates shown for a choice: `data-review-name`, `data-review-switch` and `data-review-row` on the root pick one;
// the one chosen stays and the rest go.
import type { ConfirmHandover } from '@spica/protocol';
import { N_, t } from '../../../shared/i18n';

interface Words {
  /** The call's row while the review has it. */
  waiting: string;
  /** Where Auto would be on the row once it ran. */
  by: string;
  /** The first line of the row's detail once it ran: {reason}. */
  allowed: string;
  /** The card's last line when it was handed back: {reason}. */
  returned: string;
  /** The card's last line when the review gave nothing: {why}. */
  noResult: string;
}

const NAMES: Record<string, Words> = {
  auto: { waiting: N_('等待自动审查'), by: N_('自动审查'), allowed: N_('自动审查已放行：{reason}'), returned: N_('自动审查未放行：{reason}'), noResult: N_('自动审查无结果：{why}') },
  review: { waiting: N_('等待审查'), by: N_('审查'), allowed: N_('审查已放行：{reason}'), returned: N_('审查未放行：{reason}'), noResult: N_('审查无结果：{why}') },
  // names no one: the words say what happens to the step only
  plain: { waiting: N_('等待批准'), by: N_('自动放行'), allowed: N_('已自动放行：{reason}'), returned: N_('未自动放行：{reason}'), noResult: N_('未能自动放行：{why}') },
};

function words(): Words {
  return NAMES[document.documentElement.dataset.reviewName ?? 'auto'] ?? NAMES.auto!;
}

const FAILURE: Record<NonNullable<ConfirmHandover['failure']>, string> = { error: N_('出错'), spend_limit: N_('已到花费上限'), timeout: N_('超时') };

export const reviewWaiting = (): string => t(words().waiting);
export const reviewBy = (): string => t(words().by);
export const reviewAllowed = (reason: string): string => t(words().allowed, { reason });
export const reviewReturned = (reason: string): string => t(words().returned, { reason });
export const reviewNoResult = (failure: ConfirmHandover['failure']): string => t(words().noResult, { why: t(FAILURE[failure ?? 'error']) });

const SWITCHES = [N_('子任务的确认先自动审查'), N_('自动审查子任务要确认的操作'), N_('子任务的操作先由模型审查')];

/** The switch in the project conversation's 详情. */
export function reviewSwitchName(): string {
  const n = Number(document.documentElement.dataset.reviewSwitch ?? '1');
  return t(SWITCHES[n - 1] ?? SWITCHES[0]!);
}

/**
 * How a call's row looks while the review has it: 'ring' its own row, the waiting words and the turning ring after
 * them; 'live' the row as the step the run is on (the mark in front, the clock after); 'status' no row, the status
 * line under the answer says it (the row comes once it ran).
 */
export function reviewRow(): 'ring' | 'live' | 'status' {
  const v = document.documentElement.dataset.reviewRow;
  return v === 'live' || v === 'status' ? v : 'ring';
}
