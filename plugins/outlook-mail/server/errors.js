// Error codes the Outlook plugin returns. Every failure reaches the model as
// an error result whose first line is "[CODE] 一句中文人话"; the model and
// the user both read it. Messages never contain mail content.

/** code → what the user is told. */
export const MESSAGES = {
  NOT_WINDOWS: '只能在 Windows 上读本机 Outlook。可以在 Spica 里打开模拟模式，用样例邮件试。',
  OUTLOOK_NOT_INSTALLED: '这台电脑上没有装 Outlook。本插件需要经典版 Outlook（Office 里带的那个）；也可以打开模拟模式用样例邮件试。',
  OUTLOOK_NEW_ONLY: '这台电脑上只有新版 Outlook。新版 Outlook 不支持本地自动化，需要经典版 Outlook（开始菜单里叫「Outlook (classic)」）。',
  OUTLOOK_NO_PROFILE: '经典版 Outlook 已经装了，但还没有配置邮箱账号。请先打开「Outlook (classic)」登录一次邮箱，再让我试。',
  OUTLOOK_NOT_RUNNING: 'Outlook 没有打开。请先打开 Outlook，再让我试一次。',
  OUTLOOK_BUSY: 'Outlook 正忙，或者有一个窗口在等你处理（例如提示框、登录框）。处理完再让我试。',
  OUTLOOK_SECURITY_BLOCKED: 'Outlook 弹出了安全提示，访问被拒绝了。如果是你点了「拒绝」，下次请选「允许」；如果一直弹，请管理员检查杀毒软件状态。',
  POWERSHELL_RESTRICTED: '这台电脑的安全策略不允许脚本访问 Outlook（PowerShell 受限模式）。请联系管理员。',
  POWERSHELL_FAILED: '读取 Outlook 的后台组件出错了，详情在插件日志里。',
  TIMEOUT: 'Outlook 太久没有回应。可能有提示框在等你处理，或者邮件太多，可以缩小范围再试。',
  FOLDER_NOT_FOUND: '找不到这个文件夹。可以先用 list_folders 看有哪些文件夹。',
  MESSAGE_NOT_FOUND: '找不到这封邮件，可能已经被移动或删除。请重新列一次邮件拿新的 id。',
  ATTACHMENT_NOT_FOUND: '这封邮件里没有这个附件。可以先用 read_message 看附件清单。',
  PATH_NOT_ALLOWED: '附件只能存到项目文件夹（或插件自己的数据文件夹）里。',
  INVALID_ARGUMENT: '参数不对。',
  COM_ERROR: 'Outlook 报了一个错误，详情在插件日志里。',
};

/** status → the sentence shown with it (same wording as the matching error). */
export const STATE_HINTS = {
  ready: 'Outlook 可以用了。',
  restricted: MESSAGES.POWERSHELL_RESTRICTED,
  not_installed: MESSAGES.OUTLOOK_NOT_INSTALLED,
  new_outlook_only: MESSAGES.OUTLOOK_NEW_ONLY,
  no_profile: MESSAGES.OUTLOOK_NO_PROFILE,
  not_running: MESSAGES.OUTLOOK_NOT_RUNNING,
};

export class MailError extends Error {
  /** @param {keyof typeof MESSAGES} code @param {string} [detail] extra human text (no mail content) @param {string} [hresult] */
  constructor(code, detail, hresult) {
    super(detail ? `${MESSAGES[code] ?? ''}${detail}`.trim() : (MESSAGES[code] ?? code));
    this.code = code;
    this.hresult = hresult;
  }
}

/** Format an error for the tool result: "[CODE] message (0x…)". */
export function formatError(err) {
  if (err instanceof MailError) {
    return `[${err.code}] ${err.message}${err.hresult ? `（错误代码 ${err.hresult}）` : ''}`;
  }
  return `[COM_ERROR] ${MESSAGES.COM_ERROR}`;
}

/**
 * HRESULT → code. Values are COM / MAPI / RPC constants; the ones marked
 * "unverified" are what the Outlook object model is documented or commonly
 * reported to raise and still need a check on a logged-in Outlook.
 */
export const HRESULT_CODES = {
  '0x80040154': 'OUTLOOK_NOT_INSTALLED', // REGDB_E_CLASSNOTREG
  '0x800401F3': 'OUTLOOK_NOT_INSTALLED', // CO_E_CLASSSTRING (ProgID unknown)
  '0x800401E3': 'OUTLOOK_NOT_RUNNING', // MK_E_UNAVAILABLE (no running instance)
  '0x800706BA': 'OUTLOOK_NOT_RUNNING', // RPC_S_SERVER_UNAVAILABLE (Outlook closed mid-call)
  '0x800706BE': 'OUTLOOK_NOT_RUNNING', // RPC_S_CALL_FAILED
  '0x80010108': 'OUTLOOK_NOT_RUNNING', // RPC_E_DISCONNECTED
  '0x80080005': 'OUTLOOK_NOT_RUNNING', // CO_E_SERVER_EXEC_FAILURE (often: Outlook runs as administrator)
  '0x80010001': 'OUTLOOK_BUSY', // RPC_E_CALL_REJECTED
  '0x8001010A': 'OUTLOOK_BUSY', // RPC_E_SERVERCALL_RETRYLATER
  '0x80004004': 'OUTLOOK_SECURITY_BLOCKED', // E_ABORT — security prompt denied (unverified)
  '0x80070005': 'OUTLOOK_SECURITY_BLOCKED', // E_ACCESSDENIED (unverified)
  '0x8004010F': 'MESSAGE_NOT_FOUND', // MAPI_E_NOT_FOUND
  '0x80040107': 'MESSAGE_NOT_FOUND', // MAPI_E_INVALID_ENTRYID
};

const HINTS = {
  '0x80080005': '如果 Outlook 是「以管理员身份运行」的，请正常方式重新打开它。',
};

/** Text that marks PowerShell's constrained language mode. */
const RESTRICTED_PATTERNS = [/language mode/i, /语言模式/];

/**
 * Turn what the PowerShell worker reported into a MailError.
 * @param {{ code?: string, hresult?: string, message?: string } | undefined} info
 */
export function mapWorkerError(info) {
  if (!info) return new MailError('POWERSHELL_FAILED');
  const hresult = normalizeHresult(info.hresult);
  if (info.code && info.code !== 'COM_ERROR' && MESSAGES[info.code]) {
    // detail is a folder path or attachment name the model passed in.
    return new MailError(info.code, info.detail ? `（「${info.detail}」）` : undefined, hresult);
  }
  if (hresult && HRESULT_CODES[hresult]) return new MailError(HRESULT_CODES[hresult], HINTS[hresult], hresult);
  if (info.message && RESTRICTED_PATTERNS.some((p) => p.test(info.message))) return new MailError('POWERSHELL_RESTRICTED');
  return new MailError('COM_ERROR', undefined, hresult);
}

/** "-2147221164" | "0x80040154" | 2147746132 → "0x80040154". */
export function normalizeHresult(v) {
  if (v === undefined || v === null || v === '') return undefined;
  let n;
  if (typeof v === 'number') n = v;
  else if (/^0x[0-9a-f]+$/i.test(String(v))) n = parseInt(String(v), 16);
  else if (/^-?\d+$/.test(String(v))) n = Number(v);
  else return undefined;
  return `0x${(n >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
}
