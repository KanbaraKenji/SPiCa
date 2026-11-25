// How the cards, rows and 详情 call the agent a sub-agent's confirmation is asked of first (its upper agent), and the
// name of the project's switch for it. Candidates shown for a choice: `data-coord-name` and `data-coord-switch` on the
// root pick one; the one chosen stays and the rest go.
import { getLocale, N_, t } from '../../../shared/i18n';

const NAMES: Record<string, string> = { agent: N_('上级 Agent'), conversation: N_('上级对话') };

/**
 * 上级 Agent (default), 上级对话, or the upper conversation's own name in 「」. `inText`: it goes into a Chinese sentence,
 * so a name ending in a Latin letter gets a space before the words after it (等上级 Agent 确认).
 */
export function upperName(d?: { title?: string }, inText = false): string {
  const pick = document.documentElement.dataset.coordName ?? 'agent';
  const name = pick === 'title' && d?.title ? `「${d.title}」` : t(NAMES[pick] ?? NAMES.agent!);
  return inText && getLocale() !== 'en' && /[A-Za-z]$/.test(name) ? `${name} ` : name;
}

const SWITCHES = [N_('子任务的确认先问上级 Agent'), N_('上级 Agent 可放行子任务的操作'), N_('上级 Agent 替你放行子任务的操作')];

/** The switch in the project conversation's 详情. */
export function upperSwitchName(): string {
  const n = Number(document.documentElement.dataset.coordSwitch ?? '1');
  return t(SWITCHES[n - 1] ?? SWITCHES[0]!);
}
