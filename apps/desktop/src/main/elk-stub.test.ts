// elkjs (EPL-2.0) is not shipped: the renderer build points it at a stub that refuses, so a flowchart that asks
// for the elk layout cannot be drawn and stays a code block.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import ELK from '../renderer/flow/elk-stub';

describe('the elk layout is left out', () => {
  it('the renderer build resolves elkjs to the stub', () => {
    const config = readFileSync(join(__dirname, '../../electron.vite.config.ts'), 'utf8');
    expect(config).toMatch(/'elkjs\/lib\/elk\.bundled\.js':\s*resolve\(__dirname,\s*'src\/renderer\/flow\/elk-stub\.ts'\)/);
  });

  it('the stub refuses, so the chart falls back to its code', () => {
    expect(() => new ELK()).toThrow('The elk layout is not included.');
  });
});
