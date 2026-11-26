// What the tool-call lines say, in English (he chose English for these): each call as a verb and its object
// (Ran Get-ChildItem, Read 报价单.xlsx), a group as one sentence (Ran 4 commands, created a file, read a file),
// and the call running now (Running Get-ChildItem). The model's own one-line description of a step replaces the
// object when it wrote one. The table follows ledger-briefs/core-output/接口.md, section 2.
import type { FileCardMeta, ToolCategory } from '@spica/protocol';
import { t } from '../../../shared/i18n';

/** The parts of a tool call these words need. */
export interface ToolCall {
  name: string;
  input: unknown;
  category?: ToolCategory | undefined;
  /** The model's one line on what this step does (run_command's description). */
  summary?: string | undefined;
  /** A plugin tool's own name for people; for message_agent, the name of the conversation it wrote to. */
  title?: string | undefined;
  /** From an MCP service the person added: its name as they wrote it (not capitalised). */
  server?: string | undefined;
}

/** How a call is said: the verb (shown quieter), the object, and the full text of the object when it was cut. */
export interface ToolWords {
  verb: string;
  object: string;
  full?: string;
  /** A write or an edit: the file's name and the lines it added and removed (the object is the two together). */
  file?: { name: string; added: number; removed: number };
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const arg = (c: ToolCall, key: string): string => str((c.input as Record<string, unknown> | undefined)?.[key]);
const baseName = (p: string): string => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
const cut = (s: string, n = 60): { object: string; full?: string } => (s.length > n ? { object: `${s.slice(0, n)}…`, full: s } : { object: s });
const quoted = (s: string): string => `“${s.length > 40 ? `${s.slice(0, 40)}…` : s}”`;
const named = (s: string): string => t('「{name}」', { name: s });

/** The kind of step: the core's word when it gave one, else guessed from the tool's name (older conversations). */
export function categoryOf(c: ToolCall): ToolCategory {
  if (c.category) return c.category;
  const n = c.name;
  if (n === 'run_command' || n === 'run_javascript' || n === 'command_output' || n === 'stop_command') return 'command';
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
  if (tool && c.server) return `${c.server} · ${tool}`;
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
      // run in the background: started, it runs on after the call
      const verb = (c.input as { run_in_background?: unknown } | undefined)?.run_in_background === true ? 'Started' : 'Ran';
      if (c.summary) return { verb, ...cut(c.summary, 80) };
      const head = commandHead(arg(c, 'command'));
      return head ? { verb, ...cut(head) } : { verb, object: 'a command' };
    }
    case 'run_javascript':
      return c.summary ? { verb: 'Ran', ...cut(c.summary, 80) } : { verb: 'Ran', object: 'JavaScript' };
    case 'command_output':
      return { verb: 'Checked', object: 'a background command' };
    case 'get_diagnostics': {
      const path = arg(c, 'path');
      return { verb: 'Checked', object: path && path !== '.' ? `${baseName(path)} for errors` : 'the project for errors', ...(path ? { full: path } : {}) };
    }
    case 'stop_command':
      return { verb: 'Stopped', object: 'a background command' };
    case 'read_file':
      return arg(c, 'path') ? { verb: 'Read', object: baseName(arg(c, 'path')), full: arg(c, 'path') } : { verb: 'Read', object: 'a file' };
    case 'list_dir': {
      const path = arg(c, 'path');
      // No input yet (the call has only been announced): just a folder.
      if (c.input === undefined) return { verb: 'Listed', object: 'a folder' };
      return { verb: 'Listed', object: path === '.' || !path ? 'the working folder' : `${baseName(path)}\\`, full: path };
    }
    case 'glob':
    case 'grep':
      return arg(c, 'pattern') ? { verb: 'Searched files for', object: quoted(arg(c, 'pattern')) } : { verb: 'Searched', object: 'files' };
    case 'write_file':
    case 'edit_file': {
      const name = card?.name ?? (arg(c, 'path') ? baseName(arg(c, 'path')) : 'a file');
      const lines = card?.lines ? `${card.lines.added ? ` +${card.lines.added}` : ''}${card.lines.removed ? ` −${card.lines.removed}` : ''}` : '';
      const verb = card?.origin === 'created' ? 'Created' : card?.origin === 'modified' || n === 'edit_file' ? 'Edited' : 'Wrote';
      return { verb, object: `${name}${lines}`, full: card?.path ?? arg(c, 'path'), ...(card?.lines ? { file: { name, added: card.lines.added, removed: card.lines.removed } } : {}) };
    }
    case 'web_fetch': {
      const url = arg(c, 'url');
      if (!url) return { verb: 'Fetched', object: 'a page' };
      let shown = url;
      try {
        const u = new URL(url);
        shown = `${u.host}${u.pathname === '/' ? '' : u.pathname}`;
      } catch {
        // as written
      }
      return { verb: 'Fetched', ...cut(shown), full: url };
    }
    case 'python_env': {
      const pk = (c.input as { packages?: unknown } | undefined)?.packages;
      const names = Array.isArray(pk) ? pk.map(String).filter(Boolean) : [];
      return { verb: 'Set up', object: names.length ? `Python with ${names.join(', ')}` : 'Python' };
    }
    case 'web_search':
      return arg(c, 'query') ? { verb: 'Searched the web for', object: quoted(arg(c, 'query')) } : { verb: 'Searched', object: 'the web' };
    // The built-in browser (the right panel's web tabs).
    case 'browser_open': {
      const url = arg(c, 'url');
      if (!url) return { verb: 'Opened', object: 'a page' };
      let shown = url;
      try {
        const u = new URL(url);
        shown = `${u.host}${u.pathname === '/' ? '' : u.pathname}`;
      } catch {
        // as written
      }
      return { verb: 'Opened', ...cut(shown), full: url };
    }
    case 'browser_read':
      return { verb: 'Read', object: 'the page' };
    case 'browser_screenshot':
      return { verb: 'Took', object: 'a screenshot' };
    case 'browser_scroll':
      return { verb: 'Scrolled', object: 'the page' };
    case 'browser_wait':
      return arg(c, 'text') ? { verb: 'Waited for', object: quoted(arg(c, 'text')) } : { verb: 'Waited', object: 'for the page' };
    case 'browser_tabs':
      return { verb: 'Listed', object: 'browser tabs' };
    case 'browser_click':
      return { verb: 'Clicked', object: arg(c, 'ref') ? `element ${arg(c, 'ref')}` : 'on the page' };
    case 'browser_type':
      return arg(c, 'text') ? { verb: 'Typed', object: quoted(arg(c, 'text')) } : { verb: 'Typed', object: 'on the page' };
    case 'browser_press':
      return { verb: 'Pressed', object: arg(c, 'key') || 'a key' };
    case 'browser_find':
      return arg(c, 'query') ? { verb: 'Looked for', object: quoted(arg(c, 'query')) } : { verb: 'Looked for', object: 'elements' };
    case 'browser_select':
      return arg(c, 'value') ? { verb: 'Chose', object: quoted(arg(c, 'value')) } : { verb: 'Chose', object: 'an option' };
    case 'browser_hover':
      return { verb: 'Hovered', object: arg(c, 'ref') ? `over element ${arg(c, 'ref')}` : 'on the page' };
    case 'browser_drag':
      return { verb: 'Dragged', object: arg(c, 'ref') ? `element ${arg(c, 'ref')}` : 'on the page' };
    case 'browser_file_upload':
      return { verb: 'Uploaded', object: 'files' };
    case 'browser_javascript':
      return { verb: 'Ran', object: 'a script on the page' };
    case 'browser_console':
      return { verb: 'Read', object: 'the page console' };
    case 'browser_network':
      return { verb: 'Read', object: 'page requests' };
    case 'browser_batch':
      return { verb: 'Ran', object: 'browser steps' };
    // 操作电脑: programs on this computer (computer_request_access is its approval card, not a step).
    case 'computer_list_apps':
      return { verb: 'Listed', object: 'open programs' };
    case 'computer_open_application':
      return { verb: 'Opened', object: arg(c, 'app') ? named(arg(c, 'app')) : 'a program' };
    case 'computer_screenshot':
      return { verb: 'Took', object: 'a screenshot of the screen' };
    case 'computer_zoom':
      return { verb: 'Zoomed', object: 'into the screen' };
    case 'computer_left_click':
    case 'computer_right_click':
    case 'computer_middle_click':
    case 'computer_double_click':
    case 'computer_triple_click':
      return { verb: 'Clicked', object: 'on the screen' };
    case 'computer_mouse_move':
      return { verb: 'Moved', object: 'the pointer' };
    case 'computer_left_click_drag':
      return { verb: 'Dragged', object: 'on the screen' };
    case 'computer_scroll':
      return { verb: 'Scrolled', object: 'on the screen' };
    case 'computer_type':
      return arg(c, 'text') ? { verb: 'Typed', ...cut(arg(c, 'text')) } : { verb: 'Typed', object: 'text' };
    case 'computer_key':
      return { verb: 'Pressed', object: arg(c, 'text') || 'a key' };
    case 'computer_wait':
      return { verb: 'Waited', object: 'for the screen' };
    case 'computer_batch':
      return { verb: 'Ran', object: 'steps on the screen' };
    case 'search_history':
      return arg(c, 'query') ? { verb: 'Searched conversations for', object: quoted(arg(c, 'query')) } : { verb: 'Searched', object: 'conversations' };
    case 'read_history':
      return { verb: 'Read', object: 'an earlier conversation' };
    case 'find_history_files':
      return { verb: 'Listed', object: 'files from conversations' };
    case 'allowed_folders':
      if (arg(c, 'action') !== 'revoke') return { verb: 'Listed', object: 'allowed folders and tools' };
      // a service's tool (lab__room_temperature): as its card says it, lab · room_temperature
      if (arg(c, 'tool') && !arg(c, 'folder') && (c.input as { all?: unknown } | undefined)?.all !== true) return { verb: 'Took back', object: arg(c, 'tool').split('__').join(' · ') };
      return arg(c, 'folder') && (c.input as { all?: unknown } | undefined)?.all !== true
        ? { verb: 'Took back', object: baseName(arg(c, 'folder')), full: arg(c, 'folder') }
        : { verb: 'Took back', object: 'allowed folders and tools' };
    case 'spawn_agent':
      return { verb: 'Started', object: arg(c, 'title') ? named(arg(c, 'title')) : 'a sub-agent' };
    case 'stop_agent':
      return { verb: 'Stopped', object: 'a sub-agent' };
    case 'wait_agents': {
      const ids = (c.input as { ids?: unknown } | undefined)?.ids;
      const k = Array.isArray(ids) ? ids.length : 0;
      return { verb: 'Waited for', object: k === 1 ? 'a sub-agent' : k > 1 ? `${k} sub-agents` : 'sub-agents' };
    }
    case 'message_agent':
      return { verb: 'Messaged', object: c.title ? named(c.title) : 'a sub-agent' };
    case 'record_decision':
      return { verb: 'Recorded', object: 'a decision' };
    case 'remember':
      return { verb: 'Saved', object: 'a memory' };
    case 'forget':
      return { verb: 'Deleted', object: 'a memory' };
    case 'recall':
      return { verb: 'Recalled', object: arg(c, 'entry') ? named(arg(c, 'entry')) : 'a memory' };
    case 'present_files': {
      const paths = (c.input as { paths?: unknown } | undefined)?.paths;
      const k = Array.isArray(paths) ? paths.length : 0;
      return { verb: 'Presented', object: k === 1 ? '1 file' : `${k} files` };
    }
    case 'list_schedules':
      return { verb: 'Listed', object: 'scheduled tasks' };
    case 'schedule_task':
      return arg(c, 'title') ? { verb: 'Scheduled', object: named(arg(c, 'title')) } : { verb: 'Scheduled', object: 'a task' };
    case 'create_project':
      return arg(c, 'name') ? { verb: 'Created project', object: named(arg(c, 'name')) } : { verb: 'Created', object: 'a project' };
    case 'set_stage':
      return { verb: 'Moved', object: arg(c, 'stage') ? `the project to ${named(arg(c, 'stage'))}` : 'the project' };
    case 'add_work_object':
      return { verb: 'Added', object: arg(c, 'name') ? named(arg(c, 'name')) : 'a work object' };
    case 'open_project':
      return { verb: 'Checked', object: arg(c, 'project') ? named(arg(c, 'project')) : 'a project' };
    case 'project_status':
      return { verb: 'Checked', object: 'the project' };
    case 'triage_mail': {
      const results = (c.input as { results?: unknown } | undefined)?.results;
      const k = Array.isArray(results) ? results.length : 0;
      return { verb: 'Sorted', object: k === 1 ? '1 mail' : k ? `${k} mails` : 'mail' };
    }
    default:
      break;
  }
  const kind = categoryOf(c);
  if (kind === 'project') return { verb: 'Checked', object: 'projects' };
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
    Opened: 'Opening',
    Took: 'Taking',
    Scrolled: 'Scrolling',
    Waited: 'Waiting',
    Clicked: 'Clicking',
    Typed: 'Typing',
    Pressed: 'Pressing',
    'Searched the web for': 'Searching the web for',
    'Searched conversations for': 'Searching conversations for',
    Started: 'Starting',
    'Waited for': 'Waiting for',
    Messaged: 'Messaging',
    Recorded: 'Recording',
    Presented: 'Presenting',
    'Created project': 'Creating project',
    Scheduled: 'Scheduling',
    Moved: 'Moving',
    Added: 'Adding',
    Checked: 'Checking',
    Sorted: 'Sorting',
    Saved: 'Saving',
    Deleted: 'Deleting',
    Recalled: 'Recalling',
    'Set up': 'Setting up',
    'Looked for': 'Looking for',
    Chose: 'Choosing',
    Hovered: 'Hovering',
    Dragged: 'Dragging',
    Uploaded: 'Uploading',
    'Took back': 'Taking back',
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
      if ((c.input as { run_in_background?: unknown } | undefined)?.run_in_background === true) return { key: 'started-command', say: (n) => `started ${many('a background command', n, 'background commands')}` };
      return { key: 'ran', say: (n) => `ran ${many('a command', n, 'commands')}` };
    case 'run_javascript':
      return { key: 'ran-js', say: () => 'ran JavaScript' };
    case 'command_output':
      return { key: 'checked-command', say: () => 'checked background commands' };
    case 'get_diagnostics':
      return { key: 'checked-errors', say: () => 'checked for errors' };
    case 'stop_command':
      return { key: 'stopped-command', say: (n) => `stopped ${many('a background command', n, 'background commands')}` };
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
    case 'browser_open':
      return { key: 'opened', say: (n) => `opened ${many('a page', n, 'pages')}` };
    case 'browser_read':
      return { key: 'browser-read', say: (n) => (n === 1 ? 'read a page' : `read pages ${n} times`) };
    case 'browser_screenshot':
      return { key: 'screenshot', say: (n) => `took ${many('a screenshot', n, 'screenshots')}` };
    case 'browser_scroll':
      return { key: 'scrolled', say: () => 'scrolled' };
    case 'browser_wait':
      return { key: 'waited-page', say: () => 'waited for the page' };
    case 'browser_tabs':
      return { key: 'tabs', say: () => 'listed browser tabs' };
    case 'browser_click':
      return { key: 'clicked', say: (n) => (n === 1 ? 'clicked on the page' : `clicked ${n} times`) };
    case 'browser_type':
      return { key: 'typed', say: () => 'typed on the page' };
    case 'browser_press':
      return { key: 'pressed', say: () => 'pressed keys' };
    case 'browser_find':
      return { key: 'found', say: () => 'looked for elements' };
    case 'browser_select':
      return { key: 'chose', say: () => 'chose options' };
    case 'browser_hover':
      return { key: 'hovered', say: () => 'hovered on the page' };
    case 'browser_drag':
      return { key: 'dragged', say: () => 'dragged on the page' };
    case 'browser_file_upload':
      return { key: 'uploaded', say: () => 'uploaded files' };
    case 'browser_javascript':
      return { key: 'script', say: (n) => (n === 1 ? 'ran a script on the page' : `ran ${n} scripts on pages`) };
    case 'browser_console':
      return { key: 'console', say: () => 'read the page console' };
    case 'browser_network':
      return { key: 'network', say: () => 'read page requests' };
    case 'browser_batch':
      return { key: 'batch', say: (n) => (n === 1 ? 'ran browser steps' : `ran browser steps ${n} times`) };
    case 'computer_list_apps':
      return { key: 'computer-apps', say: () => 'listed open programs' };
    case 'computer_open_application':
      return { key: 'computer-open', say: (n) => `opened ${many('a program', n, 'programs')}` };
    case 'computer_screenshot':
    case 'computer_zoom':
      return { key: 'computer-shot', say: (n) => `took ${many('a screenshot', n, 'screenshots')} of the screen` };
    case 'computer_left_click':
    case 'computer_right_click':
    case 'computer_middle_click':
    case 'computer_double_click':
    case 'computer_triple_click':
    case 'computer_mouse_move':
    case 'computer_left_click_drag':
    case 'computer_scroll':
      return { key: 'computer-click', say: (n) => (n === 1 ? 'clicked on the screen' : `clicked on the screen ${n} times`) };
    case 'computer_type':
    case 'computer_key':
      return { key: 'computer-type', say: () => 'typed on the screen' };
    case 'computer_wait':
      return { key: 'computer-wait', say: () => 'waited for the screen' };
    case 'computer_batch':
      return { key: 'computer-batch', say: (n) => (n === 1 ? 'ran steps on the screen' : `ran steps on the screen ${n} times`) };
    case 'python_env':
      return { key: 'python', say: () => 'set up Python' };
    case 'search_history':
      return { key: 'history', say: () => 'searched conversations' };
    case 'read_history':
      return { key: 'read-history', say: (n) => (n === 1 ? 'read an earlier conversation' : `read ${n} earlier conversations`) };
    case 'find_history_files':
      return { key: 'history-files', say: () => 'listed files from conversations' };
    case 'allowed_folders':
      return arg(c, 'action') === 'revoke' ? { key: 'took-back', say: () => 'took back allowed folders and tools' } : { key: 'allowed-folders', say: () => 'listed allowed folders and tools' };
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
    case 'schedule_task':
      return { key: 'scheduled', say: (n) => (n === 1 ? 'scheduled a task' : `scheduled ${n} tasks`) };
    case 'create_project':
      return { key: 'created-project', say: (n) => (n === 1 ? 'created a project' : `created ${n} projects`) };
    case 'set_stage':
    case 'add_work_object':
      return { key: 'updated-project', say: () => 'updated a project' };
    case 'triage_mail':
      return { key: 'mail', say: () => 'sorted mail' };
    case 'remember':
      return { key: 'memory-saved', say: (n) => `saved ${many('a memory', n, 'memories')}` };
    case 'forget':
      return { key: 'memory-deleted', say: (n) => `deleted ${many('a memory', n, 'memories')}` };
    case 'recall':
      return { key: 'memory-recalled', say: (n) => `recalled ${many('a memory', n, 'memories')}` };
    default:
      break;
  }
  const kind = categoryOf(c);
  if (kind === 'project') return { key: 'project', say: () => 'checked projects' };
  if (kind === 'plugin') {
    const plugin = c.title ? c.title : c.name.split('__')[0]!;
    const shown = c.title ? plugin : c.server ? c.server : `${plugin.charAt(0).toUpperCase()}${plugin.slice(1)}`;
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
