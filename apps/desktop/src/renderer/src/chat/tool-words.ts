// What the tool-call lines say, in English (he chose English for these): each call as a verb and its object
// (Ran Get-ChildItem, Read 报价单.xlsx), a group as one sentence (Ran 4 commands, created a file, read a file),
// and the call running now (Running Get-ChildItem). The model's own one-line description of a step replaces the
// object when it wrote one. The table follows ledger-briefs/core-output/接口.md, section 2.
import type { FileCardMeta, ToolCategory } from '@spica/protocol';

/** The parts of a tool call these words need. */
export interface ToolCall {
  name: string;
  input: unknown;
  category?: ToolCategory | undefined;
  /** The model's one line on what this step does (run_command's description). */
  summary?: string | undefined;
  /** A plugin tool's own name for people; for message_agent, the name of the conversation it wrote to. */
  title?: string | undefined;
}

/** How a call is said: the verb (shown quieter), the object, and the full text of the object when it was cut. */
export interface ToolWords {
  verb: string;
  object: string;
  full?: string;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const arg = (c: ToolCall, key: string): string => str((c.input as Record<string, unknown> | undefined)?.[key]);
const baseName = (p: string): string => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
const cut = (s: string, n = 60): { object: string; full?: string } => (s.length > n ? { object: `${s.slice(0, n)}…`, full: s } : { object: s });
const quoted = (s: string): string => `“${s.length > 40 ? `${s.slice(0, 40)}…` : s}”`;
const named = (s: string): string => `「${s}」`;

/** The kind of step: the core's word when it gave one, else guessed from the tool's name (older conversations). */
export function categoryOf(c: ToolCall): ToolCategory {
  if (c.category) return c.category;
  const n = c.name;
  if (n === 'run_command') return 'command';
  if (['read_file', 'list_dir', 'glob', 'grep'].includes(n)) return 'read';
  if (n === 'write_file' || n === 'edit_file') return 'write';
  if (n === 'web_fetch' || n === 'web_search') return 'web';
  if (['search_history', 'read_history', 'find_history_files'].includes(n)) return 'history';
  if (n === 'spawn_agent' || n === 'wait_agents') return 'agent';
  if (n === 'message_agent' || n === 'record_decision') return 'message';
  if (n === 'ask_user' || n === 'suggest_actions') return 'ask';
  if (n === 'present_files') return 'present';
  if (['create_project', 'list_projects', 'open_project', 'project_status', 'list_work_objects', 'set_stage', 'add_work_object'].includes(n)) return 'project';
  if (n === 'triage_mail') return 'mail';
  if (n.includes('__')) return 'plugin';
  return 'other';
}

/** A plugin tool's name for people: its title, else the plugin's and the tool's names (notes__list_notes → Notes · list_notes). */
function pluginName(c: ToolCall): string {
  if (c.title) return c.title;
  const [plugin, tool] = c.name.split('__');
  return tool ? `${plugin!.charAt(0).toUpperCase()}${plugin!.slice(1)} · ${tool}` : c.name;
}

/** The first line of a command, if it is short enough to be its name. */
function commandHead(command: string): string | null {
  const first = command.trim().split('\n')[0]!.trim();
  return first && first.length <= 80 ? first : null;
}

/** One call, done or not yet: `card` is its file card (write_file's says Created or Edited, and the lines). */
export function toolWords(c: ToolCall, card?: FileCardMeta): ToolWords {
  const n = c.name;
  switch (n) {
    case 'run_command': {
      if (c.summary) return { verb: 'Ran', ...cut(c.summary, 80) };
      const head = commandHead(arg(c, 'command'));
      return head ? { verb: 'Ran', ...cut(head) } : { verb: 'Ran', object: 'a command' };
    }
    case 'read_file':
      return { verb: 'Read', object: baseName(arg(c, 'path')), full: arg(c, 'path') };
    case 'list_dir':
      return { verb: 'Listed', object: arg(c, 'path') === '.' || !arg(c, 'path') ? 'the working folder' : `${baseName(arg(c, 'path'))}\\`, full: arg(c, 'path') };
    case 'glob':
    case 'grep':
      return { verb: 'Searched files for', object: quoted(arg(c, 'pattern')) };
    case 'write_file':
    case 'edit_file': {
      const name = card?.name ?? baseName(arg(c, 'path'));
      const lines = card?.lines ? `${card.lines.added ? ` +${card.lines.added}` : ''}${card.lines.removed ? ` −${card.lines.removed}` : ''}` : '';
      const verb = card?.origin === 'created' ? 'Created' : card?.origin === 'modified' || n === 'edit_file' ? 'Edited' : 'Wrote';
      return { verb, object: `${name}${lines}`, full: card?.path ?? arg(c, 'path') };
    }
    case 'web_fetch': {
      const url = arg(c, 'url');
      let shown = url;
      try {
        const u = new URL(url);
        shown = `${u.host}${u.pathname === '/' ? '' : u.pathname}`;
      } catch {
        // as written
      }
      return { verb: 'Fetched', ...cut(shown), full: url };
    }
    case 'web_search':
      return { verb: 'Searched the web for', object: quoted(arg(c, 'query')) };
    case 'search_history':
      return { verb: 'Searched conversations for', object: quoted(arg(c, 'query')) };
    case 'read_history':
      return { verb: 'Read', object: 'an earlier conversation' };
    case 'find_history_files':
      return { verb: 'Listed', object: 'files from conversations' };
    case 'spawn_agent':
      return { verb: 'Started', object: arg(c, 'title') ? named(arg(c, 'title')) : 'a sub-agent' };
    case 'wait_agents': {
      const ids = (c.input as { ids?: unknown } | undefined)?.ids;
      const k = Array.isArray(ids) ? ids.length : 0;
      return { verb: 'Waited for', object: k === 1 ? 'a sub-agent' : k > 1 ? `${k} sub-agents` : 'sub-agents' };
    }
    case 'message_agent':
      return { verb: 'Messaged', object: c.title ? named(c.title) : 'a sub-agent' };
    case 'record_decision':
      return { verb: 'Recorded', object: 'a decision' };
    case 'present_files': {
      const paths = (c.input as { paths?: unknown } | undefined)?.paths;
      const k = Array.isArray(paths) ? paths.length : 0;
      return { verb: 'Presented', object: k === 1 ? '1 file' : `${k} files` };
    }
    case 'create_project':
      return { verb: 'Created project', object: named(arg(c, 'name')) };
    case 'triage_mail': {
      const results = (c.input as { results?: unknown } | undefined)?.results;
      const k = Array.isArray(results) ? results.length : 0;
      return { verb: 'Sorted', object: k === 1 ? '1 mail' : k ? `${k} mails` : 'mail' };
    }
    default:
      break;
  }
  const kind = categoryOf(c);
  if (kind === 'project') return { verb: 'Checked', object: arg(c, 'name') ? named(arg(c, 'name')) : 'projects' };
  if (kind === 'plugin') return { verb: '', object: pluginName(c) };
  return { verb: '', object: n };
}

/** The line of a call: verb and object together. */
export function toolLineText(c: ToolCall, card?: FileCardMeta): string {
  const w = toolWords(c, card);
  return w.verb ? `${w.verb} ${w.object}` : w.object;
}

/** A call while it runs (Running Get-ChildItem, Reading 报价单.xlsx). */
export function runningWords(c: ToolCall): string {
  const w = toolWords(c);
  const ing: Record<string, string> = {
    Ran: 'Running',
    Read: 'Reading',
    Listed: 'Listing',
    'Searched files for': 'Searching files for',
    Wrote: 'Writing',
    Created: 'Writing',
    Edited: 'Editing',
    Fetched: 'Fetching',
    'Searched the web for': 'Searching the web for',
    'Searched conversations for': 'Searching conversations for',
    Started: 'Starting',
    'Waited for': 'Waiting for',
    Messaged: 'Messaging',
    Recorded: 'Recording',
    Presented: 'Presenting',
    'Created project': 'Creating project',
    Checked: 'Checking',
    Sorted: 'Sorting',
  };
  if (c.name === 'run_command' && !c.summary && w.object === 'a command') return 'Running a command';
  return `${w.verb ? (ing[w.verb] ?? w.verb) : 'Running'} ${w.object}`;
}

/** What a group of calls running at once says: the first one, and how many more. */
export function runningGroup(calls: ToolCall[]): string {
  const first = runningWords(calls[0]!);
  return calls.length > 1 ? `${first} and ${calls.length - 1} more` : first;
}

/** Each call's part of the group sentence: a key (calls with the same key are counted together) and how to say n of them. */
function phrase(c: ToolCall, card?: FileCardMeta): { key: string; say(n: number): string } {
  const many = (one: string, n: number, plural: string) => (n === 1 ? one : `${n} ${plural}`);
  switch (c.name) {
    case 'run_command':
      return { key: 'ran', say: (n) => `ran ${many('a command', n, 'commands')}` };
    case 'read_file':
      return { key: 'read', say: (n) => `read ${many('a file', n, 'files')}` };
    case 'list_dir':
      return { key: 'listed', say: (n) => `listed ${many('a folder', n, 'folders')}` };
    case 'glob':
    case 'grep':
      return { key: 'searched-files', say: () => 'searched files' };
    case 'write_file':
    case 'edit_file': {
      const created = card?.origin === 'created';
      const verb = created ? 'created' : c.name === 'edit_file' || card?.origin === 'modified' ? 'edited' : 'wrote';
      return { key: verb, say: (n) => `${verb} ${many('a file', n, 'files')}` };
    }
    case 'web_fetch':
      return { key: 'fetched', say: (n) => `fetched ${many('a page', n, 'pages')}` };
    case 'web_search':
      return { key: 'web', say: () => 'searched the web' };
    case 'search_history':
      return { key: 'history', say: () => 'searched conversations' };
    case 'read_history':
      return { key: 'read-history', say: (n) => (n === 1 ? 'read an earlier conversation' : `read ${n} earlier conversations`) };
    case 'find_history_files':
      return { key: 'history-files', say: () => 'listed files from conversations' };
    case 'spawn_agent':
      return { key: 'started', say: (n) => `started ${many('a sub-agent', n, 'sub-agents')}` };
    case 'wait_agents':
      return { key: 'waited', say: () => 'waited for sub-agents' };
    case 'message_agent': {
      const to = toolWords(c).object;
      return { key: `messaged ${to}`, say: () => `messaged ${to}` };
    }
    case 'record_decision':
      return { key: 'decision', say: (n) => (n === 1 ? 'recorded a decision' : `recorded ${n} decisions`) };
    case 'present_files':
      return { key: 'presented', say: () => toolLineText(c).replace(/^Presented/, 'presented') };
    case 'create_project':
      return { key: 'created-project', say: (n) => (n === 1 ? 'created a project' : `created ${n} projects`) };
    case 'triage_mail':
      return { key: 'mail', say: () => 'sorted mail' };
    default:
      break;
  }
  const kind = categoryOf(c);
  if (kind === 'project') return { key: 'project', say: () => 'checked projects' };
  if (kind === 'plugin') {
    const plugin = c.title ? c.title : c.name.split('__')[0]!;
    const shown = c.title ? plugin : `${plugin.charAt(0).toUpperCase()}${plugin.slice(1)}`;
    return { key: `plugin ${shown}`, say: () => `used ${named(shown)}` };
  }
  return { key: 'other', say: (n) => `used ${many('a tool', n, 'tools')}` };
}

/** The sentence for a group, in the order things first happened: Ran 4 commands, created a file, read a file. */
export function groupWords(calls: { call: ToolCall; card?: FileCardMeta | undefined }[]): string {
  const counts = new Map<string, { n: number; say(n: number): string }>();
  for (const { call, card } of calls) {
    const p = phrase(call, card);
    const had = counts.get(p.key);
    if (had) had.n++;
    else counts.set(p.key, { n: 1, say: p.say });
  }
  const text = [...counts.values()].map((x) => x.say(x.n)).join(', ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}
