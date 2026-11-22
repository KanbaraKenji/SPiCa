// The Windows functions 操作电脑 calls, through koffi (MIT; its native part ships as resources/koffi, see
// scripts/koffi.mjs). Loaded only by the real driver (driver-win32.ts) and the Escape watch (escape-watch.ts),
// never by the tests or a test window. Window handles are passed as plain numbers (intptr_t).
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type * as Koffi from 'koffi';

export type Win32 = ReturnType<typeof bind>;

let cached: Win32 | undefined;

/** Where koffi is: resources/koffi in an installed copy, else node_modules (by name, never bundled). */
function koffiPath(): string {
  const resources = (process as { resourcesPath?: string }).resourcesPath;
  const shipped = resources ? join(resources, 'koffi') : '';
  return shipped && existsSync(join(shipped, 'package.json')) ? shipped : 'koffi';
}

/** The functions, loaded once (koffi is loaded on first use, not when the app starts). */
export async function win32(): Promise<Win32> {
  if (cached) return cached;
  const load = createRequire(__filename);
  const spec = koffiPath();
  const mod = load(spec) as { default?: typeof Koffi } & typeof Koffi;
  cached = bind(mod.default ?? mod);
  return cached;
}

function bind(koffi: typeof Koffi) {
  const user32 = koffi.load('user32.dll');
  const kernel32 = koffi.load('kernel32.dll');
  const advapi32 = koffi.load('advapi32.dll');
  const dwmapi = koffi.load('dwmapi.dll');
  const version = koffi.load('version.dll');

  const RECT = koffi.struct('SPICA_RECT', { left: 'int32_t', top: 'int32_t', right: 'int32_t', bottom: 'int32_t' });
  const KBDLLHOOKSTRUCT = koffi.struct('SPICA_KBDLLHOOKSTRUCT', { vkCode: 'uint32_t', scanCode: 'uint32_t', flags: 'uint32_t', time: 'uint32_t', dwExtraInfo: 'uintptr_t' });
  const MSG = koffi.struct('SPICA_MSG', { hwnd: 'intptr_t', message: 'uint32_t', wParam: 'uintptr_t', lParam: 'intptr_t', time: 'uint32_t', x: 'int32_t', y: 'int32_t', lPrivate: 'uint32_t' });
  const EnumProc = koffi.proto('bool __stdcall SpicaEnumWindowsProc(intptr_t hwnd, intptr_t lParam)');
  const HookProc = koffi.proto('intptr_t __stdcall SpicaLowLevelKeyboardProc(int nCode, uintptr_t wParam, SPICA_KBDLLHOOKSTRUCT *lParam)');

  return {
    koffi,
    RECT,
    KBDLLHOOKSTRUCT,
    HookProc,
    EnumWindows: user32.func('__stdcall', 'EnumWindows', 'bool', [koffi.pointer(EnumProc), 'intptr_t']),
    IsWindowVisible: user32.func('__stdcall', 'IsWindowVisible', 'bool', ['intptr_t']),
    IsIconic: user32.func('__stdcall', 'IsIconic', 'bool', ['intptr_t']),
    GetWindowRect: user32.func('__stdcall', 'GetWindowRect', 'bool', ['intptr_t', koffi.out(koffi.pointer(RECT))]),
    GetWindowTextW: user32.func('__stdcall', 'GetWindowTextW', 'int', ['intptr_t', 'void *', 'int']),
    GetWindowThreadProcessId: user32.func('__stdcall', 'GetWindowThreadProcessId', 'uint32_t', ['intptr_t', koffi.out(koffi.pointer('uint32_t'))]),
    GetForegroundWindow: user32.func('__stdcall', 'GetForegroundWindow', 'intptr_t', []),
    SetForegroundWindow: user32.func('__stdcall', 'SetForegroundWindow', 'bool', ['intptr_t']),
    ShowWindow: user32.func('__stdcall', 'ShowWindow', 'bool', ['intptr_t', 'int']),
    GetAncestor: user32.func('__stdcall', 'GetAncestor', 'intptr_t', ['intptr_t', 'uint32_t']),
    SetCursorPos: user32.func('__stdcall', 'SetCursorPos', 'bool', ['int', 'int']),
    SendInput: user32.func('__stdcall', 'SendInput', 'uint32_t', ['uint32_t', 'void *', 'int']),
    SetWindowsHookExW: user32.func('__stdcall', 'SetWindowsHookExW', 'intptr_t', ['int', koffi.pointer(HookProc), 'intptr_t', 'uint32_t']),
    UnhookWindowsHookEx: user32.func('__stdcall', 'UnhookWindowsHookEx', 'bool', ['intptr_t']),
    CallNextHookEx: user32.func('__stdcall', 'CallNextHookEx', 'intptr_t', ['intptr_t', 'int', 'uintptr_t', 'void *']),
    PeekMessageW: user32.func('__stdcall', 'PeekMessageW', 'bool', [koffi.out(koffi.pointer(MSG)), 'intptr_t', 'uint32_t', 'uint32_t', 'uint32_t']),
    GetModuleHandleW: kernel32.func('__stdcall', 'GetModuleHandleW', 'intptr_t', ['str16']),
    OpenProcess: kernel32.func('__stdcall', 'OpenProcess', 'intptr_t', ['uint32_t', 'bool', 'uint32_t']),
    CloseHandle: kernel32.func('__stdcall', 'CloseHandle', 'bool', ['intptr_t']),
    QueryFullProcessImageNameW: kernel32.func('__stdcall', 'QueryFullProcessImageNameW', 'bool', ['intptr_t', 'uint32_t', 'void *', koffi.inout(koffi.pointer('uint32_t'))]),
    OpenProcessToken: advapi32.func('__stdcall', 'OpenProcessToken', 'bool', ['intptr_t', 'uint32_t', koffi.out(koffi.pointer('intptr_t'))]),
    GetTokenInformation: advapi32.func('__stdcall', 'GetTokenInformation', 'bool', ['intptr_t', 'int', 'void *', 'uint32_t', koffi.out(koffi.pointer('uint32_t'))]),
    RegGetValueW: advapi32.func('__stdcall', 'RegGetValueW', 'int32_t', ['intptr_t', 'str16', 'str16', 'uint32_t', 'void *', 'void *', koffi.inout(koffi.pointer('uint32_t'))]),
    DwmGetWindowAttribute: dwmapi.func('__stdcall', 'DwmGetWindowAttribute', 'int32_t', ['intptr_t', 'uint32_t', 'void *', 'uint32_t']),
    GetFileVersionInfoSizeW: version.func('__stdcall', 'GetFileVersionInfoSizeW', 'uint32_t', ['str16', 'void *']),
    GetFileVersionInfoW: version.func('__stdcall', 'GetFileVersionInfoW', 'bool', ['str16', 'uint32_t', 'uint32_t', 'void *']),
    VerQueryValueW: version.func('__stdcall', 'VerQueryValueW', 'bool', ['void *', 'str16', koffi.out(koffi.pointer('void *')), koffi.out(koffi.pointer('uint32_t'))]),
  };
}
