// Which confirmations a sub-agent's manager may answer for the user (设置: the manager answers its sub-agents'
// confirmations, off by default). An allow-list: a confirmation is the manager's to answer only when it comes from one
// of the sources below and nothing about it is human-only; any other source, including ones added later, stays with
// the user. The manager answers once (allow or decline, with a reason), never 始终允许, and the user can still answer.
import type { GuardCause, UntrustedKind } from '@spica/protocol';

/** Why a confirmation is the user's alone; the first that applies. */
export type HumanOnly =
  /** A step inside a running call (browser_batch, computer_batch …): asked right then, not stored. */
  | 'step'
  /** The conversation acts on outside content (a web page, mail, MCP or plugin data, a file outside the project). */
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
  /**
   * The outside content the session acts on since the user last wrote (Session.outsideKind; every read_file and grep
   * counts, inside the project too). `inProject`: for 'file', all of it was read inside the project's folders.
   */
  outside?: { kind: UntrustedKind; inProject?: boolean };
  /** Why the guard asks, if it does. */
  cause?: GuardCause;
  /** The registry's default confirmation of an irreversible-by-declaration tool. Only run_command's may be handed over. */
  byDefault?: boolean;
  /** The tool's name. */
  toolName: string;
  /** A hook asked and said its confirmation may be answered by a manager (a user-added MCP server's tool, a plugin tool not marked irreversible). */
  hookDelegable?: boolean;
  /** Marked irreversible (无法撤销). */
  irreversible?: boolean;
  /** The folder is too wide to keep (盘符根、主目录): the card offers only 允许. */
  folderTooWide?: boolean;
  /** A python_env download. */
  install?: boolean;
  /** The tool declares that only the user answers its confirmation. */
  toolHumanOnly?: boolean;
  /** For run_command: what it does, as the card reads it (command-plain's facts). Without it a command is not handed over. */
  command?: { danger: boolean; installs: boolean; downloads: boolean };
}

/** The guard's causes a manager may answer: a write outside the conversation's folders, a read in another project's. */
const DELEGABLE_CAUSES: ReadonlySet<GuardCause> = new Set<GuardCause>(['outside_folder', 'other_project']);

/** Undefined: the manager may answer it. Otherwise why only the user may. */
export function humanOnly(q: DelegateQuery): HumanOnly | undefined {
  if (q.step) return 'step';
  // files read inside the project are the project's own; anything else from outside stays with the user
  if (q.outside && !(q.outside.kind === 'file' && q.outside.inProject)) return 'outside_content';
  if (q.cause === 'outside_link' || q.cause === 'sensitive_file') return 'guard';
  if (q.cause === 'python_install' || q.install) return 'install';
  // untrusted_turn: an irreversible tool after outside content; only project files reach here (see above)
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
