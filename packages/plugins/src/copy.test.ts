// Words that must not appear in what the plugin system shows people (the
// desktop shell's copy rules; its own test checks the same list).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const BANNED = ['重活', '日常', '挪', '装多少', '对不上', '勾上', '这家', '自己填', '管理员给的', '多半', '先不等了', '不让它', '拿到', '点开补上', '填了一半', '看不懂', '不认识', '读不了', '没能'];
const SRC = fileURLToPath(new URL('.', import.meta.url));

describe('user-facing text', () => {
  it('uses none of the banned words', () => {
    const hits: string[] = [];
    for (const f of readdirSync(SRC)) {
      if (!f.endsWith('.ts') || f.endsWith('.test.ts')) continue;
      readFileSync(join(SRC, f), 'utf8')
        .split('\n')
        .forEach((line, i) => {
          for (const w of BANNED) if (line.includes(w)) hits.push(`${f}:${i + 1} ${w}`);
        });
    }
    expect(hits).toEqual([]);
  });
});
