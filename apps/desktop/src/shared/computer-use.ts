// Which programs the agent may operate, and how far (操作电脑). A program is known by its exe's file name, not its
// full path: an install folder that carries a version number changes on every update. Checked in the main process
// before a program goes on an approval card, and again before every click, key and typed word.
//   blocked  never: not on a card, not in a screenshot (Spica itself, trading and crypto clients, what the person added)
//   view     screenshots only: no clicks, no typing (browsers: the built-in browser has its own checks for
//            password fields and pay buttons, an outside browser carries the person's sign-ins)
//   click    screenshots and clicks, no typing and no keys (terminals and editors: typing there runs commands
//            without run_command's confirmation)
//   full     everything
// highRisk: allowed, marked 高风险 on the card (Explorer, Settings). shared: one exe runs many programs (java,
// python, node, Store apps), so allowing one allows them all: allowed for this conversation only, never always.
// Shared with 设置 › 常规 › 受限的程序, which lists the groups below as they are.
import { N_ } from './i18n';

export type Tier = 'blocked' | 'view' | 'click' | 'full';

export interface Rule {
  tier: Tier;
  highRisk?: boolean;
  shared?: boolean;
}

/** Browsers: screenshots only. */
const BROWSERS = ['msedge.exe', 'chrome.exe', 'firefox.exe', 'brave.exe', 'opera.exe', 'vivaldi.exe', 'iexplore.exe', 'chromium.exe', 'arc.exe'];

/** Terminals, shells and code editors: screenshots and clicks. */
const TERMINALS = [
  'windowsterminal.exe',
  'wt.exe',
  'openconsole.exe',
  'conhost.exe',
  'cmd.exe',
  'powershell.exe',
  'powershell_ise.exe',
  'pwsh.exe',
  'wsl.exe',
  'bash.exe',
  'mintty.exe',
  'putty.exe',
  'code.exe',
  'code - insiders.exe',
  'cursor.exe',
  'windsurf.exe',
  'devenv.exe',
  'idea64.exe',
  'pycharm64.exe',
  'webstorm64.exe',
  'rider64.exe',
  'clion64.exe',
  'goland64.exe',
  'phpstorm64.exe',
  'rubymine64.exe',
  'datagrip64.exe',
  'studio64.exe',
];

/**
 * Trading, broker and crypto-wallet clients: never. A known list only (the kind of a program cannot be told from
 * the program), so it misses some; those come on the card, where the person can say no or add them in the settings.
 */
const TRADING = [
  'tws.exe',
  'ibgateway.exe',
  'terminal.exe',
  'terminal64.exe',
  'thinkorswim.exe',
  'ftnn.exe',
  'tiger trade.exe',
  'xiadan.exe',
  'hexin.exe',
  'tdxw.exe',
  'mainfree.exe',
  'exodus.exe',
  'electrum.exe',
  'ledger live.exe',
  'trezor suite.exe',
  'atomic wallet.exe',
  'binance.exe',
];

/** Allowed, marked 高风险 on the card. */
const HIGH_RISK = ['explorer.exe', 'systemsettings.exe', 'control.exe'];

/** One exe for many programs: allowing one allows them all, so only for this conversation. */
const SHARED = ['javaw.exe', 'java.exe', 'python.exe', 'pythonw.exe', 'py.exe', 'node.exe', 'applicationframehost.exe', 'rundll32.exe', 'dllhost.exe', 'electron.exe', 'mshta.exe', 'wscript.exe', 'cscript.exe'];

const RULES = new Map<string, Rule>([
  ...BROWSERS.map((n): [string, Rule] => [n, { tier: 'view' }]),
  ...TERMINALS.map((n): [string, Rule] => [n, { tier: 'click' }]),
  ...TRADING.map((n): [string, Rule] => [n, { tier: 'blocked' }]),
  ...HIGH_RISK.map((n): [string, Rule] => [n, { tier: 'full', highRisk: true }]),
  ...SHARED.map((n): [string, Rule] => [n, { tier: 'full', shared: true }]),
]);

/** The exe's file name, lower case ("C:\\…\\EXCEL.EXE" → "excel.exe"). */
export function exeName(path: string): string {
  const name = path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
  return name.toLowerCase();
}

/**
 * How far a program may be operated. `own`: the program is Spica itself (by its process, whatever its exe is
 * called: electron.exe in a development run). `denied`: exe names the person added under 受限的程序.
 */
export function ruleFor(path: string, opts: { own?: boolean; denied?: readonly string[] } = {}): Rule {
  if (opts.own) return { tier: 'blocked' };
  const name = exeName(path);
  if (opts.denied?.some((d) => exeName(d) === name)) return { tier: 'blocked' };
  return RULES.get(name) ?? { tier: 'full' };
}

/** What a tier allows: the screenshot shows it (everything but blocked), clicks, typing and keys. */
export function allows(tier: Tier, what: 'see' | 'click' | 'type'): boolean {
  if (tier === 'blocked') return false;
  if (what === 'see') return true;
  if (what === 'click') return tier === 'click' || tier === 'full';
  return tier === 'full';
}

/**
 * The fixed rows of 设置 › 受限的程序 (the person cannot remove them): what each group is, a few of its programs by
 * name, and how far they may be operated. Programs running as administrator are out of reach whatever the list
 * says (Windows drops input sent to them).
 */
export const RESTRICTED_GROUPS: { title: string; examples: string[]; tier: Tier | 'highRisk' }[] = [
  { title: N_('{app} 自己'), examples: [], tier: 'blocked' },
  { title: N_('证券、交易、加密货币客户端'), examples: ['Trader Workstation', 'MetaTrader', 'Exodus'], tier: 'blocked' },
  { title: N_('以管理员身份运行的程序'), examples: [], tier: 'blocked' },
  { title: N_('浏览器'), examples: ['Microsoft Edge', 'Google Chrome', 'Firefox'], tier: 'view' },
  { title: N_('终端、代码编辑器'), examples: ['Windows Terminal', 'PowerShell', 'VS Code'], tier: 'click' },
  { title: N_('文件资源管理器、系统设置'), examples: [], tier: 'highRisk' },
];
