// A small process of its own while the agent operates the computer (driver-win32.ts starts it, ends it after):
// a low-level keyboard hook that tells the main process when the person presses Escape on the real keyboard.
// Keys the agent itself sends (or any program sends) carry LLKHF_INJECTED and do not count. The hook only looks:
// every key goes on to the program it was for. Windows takes a hook away without a word when it answers late, so
// the hook is put in again every so often; messages are pumped on a short timer so the hook is called at all.
import { win32 } from './win32';

const WH_KEYBOARD_LL = 13;
const WM_KEYDOWN = 0x0100;
const WM_SYSKEYDOWN = 0x0104;
const VK_ESCAPE = 0x1b;
const LLKHF_INJECTED = 0x10;
const PM_REMOVE = 0x0001;
const PUMP_MS = 15;
const REINSTALL_MS = 30_000;

interface ParentPort {
  postMessage(v: unknown): void;
}

async function main(): Promise<void> {
  const parent = (process as unknown as { parentPort?: ParentPort }).parentPort;
  const a = await win32();
  const k = a.koffi;
  const proc = k.register((nCode: number, wParam: number, lParam: unknown) => {
    if (nCode >= 0 && (wParam === WM_KEYDOWN || wParam === WM_SYSKEYDOWN)) {
      const info = k.decode(lParam, a.KBDLLHOOKSTRUCT) as { vkCode: number; flags: number };
      if (info.vkCode === VK_ESCAPE && !(info.flags & LLKHF_INJECTED)) parent?.postMessage('escape');
    }
    return a.CallNextHookEx(0, nCode, wParam, lParam);
  }, k.pointer(a.HookProc));
  const module = a.GetModuleHandleW(null as unknown as string);
  let hook = a.SetWindowsHookExW(WH_KEYBOARD_LL, proc, module, 0);
  setInterval(() => {
    if (hook) a.UnhookWindowsHookEx(hook);
    hook = a.SetWindowsHookExW(WH_KEYBOARD_LL, proc, module, 0);
  }, REINSTALL_MS);
  const msg = {};
  setInterval(() => {
    while (a.PeekMessageW(msg, 0, 0, 0, PM_REMOVE)) {
      /* the hook is called from inside PeekMessage */
    }
  }, PUMP_MS);
}

void main();
