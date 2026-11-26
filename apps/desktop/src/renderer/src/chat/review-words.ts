// How the window says a sub-agent's confirmation went through the review first (子任务的操作先由模型审查): while it
// waits, once allowed, handed back, or with no result. The words say what happened to the step, not who decided (his
// choice); the switch's name says 模型审查.
import type { ConfirmHandover } from '@spica/protocol';
import { N_, t } from '../../../shared/i18n';

const FAILURE: Record<NonNullable<ConfirmHandover['failure']>, string> = { error: N_('出错'), spend_limit: N_('已到花费上限'), timeout: N_('超时') };

/** The call's row while the review has it. */
export const reviewWaiting = (): string => t('等待批准');
/** Where Auto would be on the row once it ran. */
export const reviewBy = (): string => t('自动放行');
/** The first line of the row's detail once it ran. */
export const reviewAllowed = (reason: string): string => t('已自动放行：{reason}', { reason });
/** The card's last line when it was handed back. */
export const reviewReturned = (reason: string): string => (reason ? t('未自动放行：{reason}', { reason }) : t('未自动放行'));
/** The card's last line when the review gave nothing. */
export const reviewNoResult = (failure: ConfirmHandover['failure']): string => t('未能自动放行：{why}', { why: t(FAILURE[failure ?? 'error']) });

/** The switch in the project conversation's 详情. */
export const reviewSwitchName = (): string => t('子任务的操作先由模型审查');
