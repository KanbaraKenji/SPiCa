// The approval card of 操作电脑 (computer_request_access) as a block of the conversation: built from what the core
// asked about (the programs the main process worked out, backend/computer-tools.ts `prepared`), and after a restart
// from the tool's result, whose lines say what was allowed (accessText there). Not a step row: the card is the
// only thing the conversation shows for the call, waiting and answered alike.

export const COMPUTER_ACCESS = 'computer_request_access';

export type ComputerTier = 'blocked' | 'view' | 'click' | 'full';

/** A program on the card. */
export interface ComputerCardApp {
  name: string;
  exe: string;
  icon?: string;
  tier: ComputerTier;
  highRisk?: boolean;
  shared?: boolean;
  /** For a program sharing its exe with others: its window's title. */
  title?: string;
}

/** The card: the programs asked about, then what the person chose (始终允许 / 允许一次 / 拒绝), or stopped. */
export interface ComputerBlock {
  type: 'computer';
  callId: string;
  apps: ComputerCardApp[];
  approved?: boolean;
  always?: boolean;
  cancelled?: boolean;
}

const TIERS = new Set<ComputerTier>(['blocked', 'view', 'click', 'full']);

/** The card from what the core asked about: the programs still to be allowed. */
export function computerCard(callId: string, input: unknown): ComputerBlock {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const prepared = (o.prepared && typeof o.prepared === 'object' ? o.prepared : {}) as Record<string, unknown>;
  const list = Array.isArray(prepared.apps) ? prepared.apps : [];
  const apps: ComputerCardApp[] = [];
  for (const a of list) {
    if (!a || typeof a !== 'object') continue;
    const r = a as Record<string, unknown>;
    if (r.state !== 'ask' || typeof r.name !== 'string' || typeof r.exe !== 'string') continue;
    const tier = TIERS.has(r.tier as ComputerTier) ? (r.tier as ComputerTier) : 'full';
    apps.push({
      name: r.name,
      exe: r.exe,
      ...(typeof r.icon === 'string' && r.icon.startsWith('data:image/') ? { icon: r.icon } : {}),
      tier,
      ...(r.highRisk === true ? { highRisk: true } : {}),
      ...(r.shared === true ? { shared: true } : {}),
      ...(typeof r.title === 'string' && r.title ? { title: r.title } : {}),
    });
  }
  // a card restored from history before its result: the names the model asked for
  if (!apps.length && Array.isArray(o.apps)) for (const n of o.apps) if (typeof n === 'string' && n.trim()) apps.push({ name: n.trim(), exe: '', tier: 'full' });
  return { type: 'computer', callId, apps };
}

/** One line of the result: "- 记事本 (C:\…\notepad.exe): approved for every conversation — full control, high risk". */
const LINE = /^- (.+?) \((.+)\): approved for (every|this) conversation — (full control|view only|click only)[^,\n]*(, high risk)?/;

/**
 * The card as its result says it went: the programs allowed (always or once), declined, or stopped. Undefined when
 * no card was shown (every program was allowed already, or none could be).
 */
export function settleComputer(block: ComputerBlock, content: string, isError: boolean, stopped: boolean): ComputerBlock | undefined {
  if (stopped) return { ...block, cancelled: true };
  if (isError) return /declined/i.test(content) ? { ...block, approved: false } : undefined;
  const apps: ComputerCardApp[] = [];
  let always: boolean | undefined;
  for (const line of content.split('\n')) {
    const m = LINE.exec(line.trim());
    if (!m) continue;
    const prev = block.apps.find((a) => a.exe && a.exe.toLowerCase() === m[2]!.toLowerCase());
    if (m[3] === 'every') always = true;
    else if (always === undefined) always = false;
    apps.push({
      ...prev,
      name: m[1]!,
      exe: m[2]!,
      tier: m[4] === 'view only' ? 'view' : m[4] === 'click only' ? 'click' : 'full',
      ...(m[5] ? { highRisk: true } : {}),
    });
  }
  if (!apps.length) return undefined;
  return { ...block, apps, approved: true, always: block.always ?? always === true };
}
