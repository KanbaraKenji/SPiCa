import { describe, expect, it } from 'vitest';
import { runsAsProgram } from './runs-as-program';

describe('runsAsProgram', () => {
  it('programs and scripts, whatever the case; documents and pictures are not', () => {
    for (const p of ['C:/out/setup.exe', 'D:/a/RUN.BAT', '/tmp/x.ps1', 'C:/x/installer.msi', 'C:/x/a.js', 'C:/x/a.vbs', 'C:/x/a.scr', 'C:/x/a.lnk', 'C:/x/a.cmd'])
      expect(runsAsProgram(p), p).toBe(true);
    for (const p of ['C:/out/spec.pdf', 'C:/out/bom.xlsx', 'C:/out/a.png', 'C:/out/notes.txt', 'C:/out/noext', 'C:/out/a.json'])
      expect(runsAsProgram(p), p).toBe(false);
  });
});
