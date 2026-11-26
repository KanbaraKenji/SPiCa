// Which confirmations of a sub-agent go through the review first (a project's switch, off by default). An allow-list:
// a confirmation is reviewed only when it comes from one of the sources below and nothing about it is human-only; any
// other source, including ones added later, gets its card at once, as without the switch. The review is one model call
// of its own (confirm-review.ts), in the background with no card: it allows the call once (with a reason, never
// 始终允许) or hands it back, and a handed-back one, or one it gave no result for, gets its card for the user. It
// cannot decline for the user. After a web page, mail, MCP / plugin data or a file outside the project the
// confirmation stays with the user: what came from outside may carry words that steer the sub-agent, and the command or
// an MCP tool's arguments the review sees are the sub-agent's. Files inside the project and history do not count; a
// file read not known to be inside the project counts as outside.
import type { GuardCause, UntrustedKind } from '@spica/protocol';

/** Why a confirmation is the user's alone; the first that applies. */
export type HumanOnly =
  /** A step inside a running call (browser_batch, computer_batch …): asked right then, not stored. */
  | 'step'
  /** The conversation is on a scheduled task's run: nobody started it, so nobody is watching what the review allows. */
  | 'scheduled'
  /** The sub-agent read a web page, mail, MCP / plugin data or a file outside the project since the user last wrote. */
  | 'outside_content'
  /** The guard asks about a link from outside content or a credential file. */
  | 'guard'
  /** The card says 无法撤销: a hook or plugin marked it, or the command deletes, overwrites, stops a program, edits the registry. */
  | 'irreversible'
  /** Installs or downloads (python_env, npm / pip / winget install, a download in a command). */
  | 'install'
  /** A write or read where only 允许 is offered: a drive's root, the user's home and the like. */
  | 'too_wide'
  /** A tool that declares its confirmation the user's (computer_request_access, scheduled tasks …). */
  | 'tool'
  /** A confirmation from a source not on the list (another irreversible tool, a plugin view, a settings change, a hook that did not say). */
  | 'source';

/** What is known about one confirmation when it is asked. */
export interface DelegateQuery {
  /** A step of a running call (askOutsideSession), not a call of its own. */
  step: boolean;
  /** The turn was started by a scheduled task (its message's meta.scheduleRun), in this conversation or one above it. */
  scheduledRun?: boolean;
  /** Every kind of outside content the sub-agent acts on since the user last wrote (Session.outsideRead). */
  outside?: UntrustedKind[];
  /** Every file read (kind 'file') was inside the project's folder (a read not known to be counts as outside). */
  filesInProject?: boolean;
  /** Why the guard asks, if it does. */
  cause?: GuardCause;
  /** The registry's default confirmation of an irreversible-by-declaration tool. Only run_command's may be handed over. */
  byDefault?: boolean;
  /** The tool's name. */
  toolName: string;
  /** A hook asked and said its confirmation may be reviewed (a user-added MCP server's tool, a plugin tool not marked irreversible). */
  hookDelegable?: boolean;
  /** Marked irreversible (无法撤销). */
  irreversible?: boolean;
  /** The folder is too wide to keep (盘符根、主目录): the card offers only 允许. */
  folderTooWide?: boolean;
  /** A python_env download. */
  install?: boolean;
  /** The tool declares that only the user answers its confirmation (Tool.confirmByUser). */
  toolHumanOnly?: boolean;
  /** For run_command: what it does, as the card reads it (command-plain's facts). Without it a command is not handed over. */
  command?: { danger: boolean; installs: boolean; downloads: boolean };
}

/** The guard's causes the review may answer: a write outside the conversation's folders, a read in another project's. */
const DELEGABLE_CAUSES: ReadonlySet<GuardCause> = new Set<GuardCause>(['outside_folder', 'other_project']);

/** What was read that keeps a confirmation with the user (a file: when outside the project; history never). */
const OUTSIDE: ReadonlySet<UntrustedKind> = new Set<UntrustedKind>(['web', 'mail', 'mcp']);

/** Undefined: it goes through the review first. Otherwise why only the user may answer it. */
export function humanOnly(q: DelegateQuery): HumanOnly | undefined {
  if (q.step) return 'step';
  if (q.scheduledRun) return 'scheduled';
  if (q.outside?.some((k) => OUTSIDE.has(k) || (k === 'file' && q.filesInProject !== true))) return 'outside_content';
  if (q.cause === 'outside_link' || q.cause === 'sensitive_file') return 'guard';
  if (q.cause === 'python_install' || q.install) return 'install';
  // untrusted_turn: an irreversible tool after outside content; reviewed only as a command the card reads (below)
  if (q.cause && q.cause !== 'untrusted_turn' && !DELEGABLE_CAUSES.has(q.cause)) return 'source';
  if (q.irreversible || q.command?.danger) return 'irreversible';
  if (q.command?.installs || q.command?.downloads) return 'install';
  if (q.folderTooWide) return 'too_wide';
  if (q.toolHumanOnly) return 'tool';
  const command = q.toolName === 'run_command' && q.command !== undefined;
  if (q.cause === 'untrusted_turn' && !command) return 'source';
  if (q.byDefault && !command) return 'source';
  if (!q.cause && !q.byDefault && !q.hookDelegable) return 'source';
  return undefined;
}
