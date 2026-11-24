// Files that run as a program when opened (Windows starts them; macOS and Linux shell scripts too): a file card's
// 打开, or a path clicked in an answer, shows such a file in its folder instead. A file a tool returned may be
// named anything (an MCP tool's embedded file is named by its server).
import { extname } from 'node:path';

const PROGRAMS = new Set([
  'exe', 'com', 'scr', 'pif', 'cpl', 'msi', 'msp', 'msc', 'bat', 'cmd', 'ps1', 'psm1', 'psd1', 'ps1xml', 'vbs', 'vbe',
  'js', 'jse', 'wsf', 'wsh', 'hta', 'lnk', 'url', 'scf', 'inf', 'reg', 'jar', 'application', 'appref-ms', 'gadget',
  'appx', 'msix', 'appxbundle', 'msixbundle', 'sh', 'command', 'app',
]);

/** Opening it would run it. */
export function runsAsProgram(path: string): boolean {
  return PROGRAMS.has(extname(path).slice(1).toLowerCase().replace(/[. ]+$/, ''));
}
