// run_javascript in approval mode Auto: code that names an absolute path outside the conversation's folders is
// confirmed (cause outside_folder), as a command that writes there is; inside, it runs without a card.
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeGateway } from './testing/fake-gateway.ts';
import { captureEvents, makeRuntime, startGateway, tempDir } from './testing/helpers.ts';
import { absolutePathsIn, createJavaScriptTool } from './tools/javascript-tool.ts';
import { realPath } from './write-scope.ts';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let gw: FakeGateway;
let root: string;
let cleanup: () => Promise<void>;
let work: string;
let outside: string;
beforeEach(async () => {
  gw = await startGateway();
  ({ dir: root, cleanup } = await tempDir());
  work = join(root, 'work');
  outside = join(root, 'elsewhere');
  await mkdir(work);
  await mkdir(outside);
});
afterEach(async () => {
  await gw.stop();
  await cleanup();
});

async function run(code: string, approvalMode: 'manual' | 'auto' = 'auto') {
  gw.enqueue({ toolCalls: [{ id: 'j1', name: 'run_javascript', args: { code } }] }, { text: 'done' });
  const rt = makeRuntime(gw, { tools: [createJavaScriptTool()] });
  const events = captureEvents(rt);
  const s = rt.createSession({ cwd: work, approvalMode });
  await s.send('do it').done;
  const req = events.find((e) => e.type === 'confirm.request') as { cause?: string; outsideFolder?: string } | undefined;
  return { req };
}

const js = (p: string) => JSON.stringify(p);

describe('absolutePathsIn', () => {
  it('finds Windows, UNC and POSIX paths in string literals, as JavaScript reads them', () => {
    expect(absolutePathsIn("fs.writeFileSync('D:\\\\out\\\\a.txt', x)")).toEqual(['D:\\out\\a.txt']);
    expect(absolutePathsIn('fs.readFileSync("C:/data/q.csv")')).toEqual(['C:/data/q.csv']);
    expect(absolutePathsIn("copy('\\\\\\\\server\\\\share\\\\f')")).toEqual(['\\\\server\\share\\f']);
    expect(absolutePathsIn('open(`/home/alex/x.txt`)')).toEqual(['/home/alex/x.txt']);
    expect(absolutePathsIn('open(`/srv/${name}/x`)')).toEqual(['/srv/']);
  });
  it('leaves relative paths, URLs, a lone slash and one-part strings alone', () => {
    expect(absolutePathsIn("read('data/q.csv'); get('https://example.com/a/b'); x.split('/'); y = '/api'; z = './a/b'")).toEqual([]);
  });
});

describe('run_javascript in Auto', () => {
  it('an absolute path outside the folders: confirmed with the folder', async () => {
    const r = await run(`require('fs').writeFileSync(${js(join(outside, 'a.txt'))}, 'x')`);
    expect(r.req).toMatchObject({ cause: 'outside_folder', outsideFolder: realPath(outside) });
    expect(existsSync(join(outside, 'a.txt'))).toBe(false);
  });
  it('a folder outside named on its own: that folder', async () => {
    const r = await run(`require('fs').readdirSync(${js(outside)})`);
    expect(r.req).toMatchObject({ cause: 'outside_folder', outsideFolder: realPath(outside) });
  });
  it('inside the folders, or no absolute path: runs without a card', async () => {
    expect((await run(`require('fs').writeFileSync(${js(join(work, 'in.txt'))}, 'x')`)).req).toBeUndefined();
    expect(existsSync(join(work, 'in.txt'))).toBe(true);
    expect((await run("require('fs').writeFileSync('rel.txt', 'x')")).req).toBeUndefined();
  });
});
