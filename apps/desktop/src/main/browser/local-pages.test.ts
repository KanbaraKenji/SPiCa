import { describe, expect, it } from 'vitest';
import { join, resolve } from 'node:path';
import { LocalPages, realInside } from './local-pages';

const folder = resolve('/work/report');
const tokens = () => {
  let n = 0;
  return () => `tok${++n}`;
};

describe('LocalPages', () => {
  it('a file: its address, and the files of its folder and below', () => {
    const p = new LocalPages(tokens());
    const url = p.addFile(join(folder, 'chart page.html'));
    expect(url).toBe('spica-page://tok1/chart%20page.html');
    expect(p.resolve(url)).toEqual({ kind: 'file', path: join(folder, 'chart page.html'), root: folder });
    expect(p.resolve('spica-page://tok1/js/app.js')).toEqual({ kind: 'file', path: join(folder, 'js', 'app.js'), root: folder });
    expect(p.resolve('spica-page://tok1/img%2Fa.png')).toEqual({ kind: 'file', path: join(folder, 'img', 'a.png'), root: folder });
  });

  it('nothing outside its folder', () => {
    const p = new LocalPages(tokens());
    p.addFile(join(folder, 'index.html'));
    // the address itself folds ../ away: still inside
    expect(p.resolve('spica-page://tok1/../secret.txt')).toEqual({ kind: 'file', path: join(folder, 'secret.txt'), root: folder });
    expect(p.resolve('spica-page://tok1/%2E%2E/secret.txt')).toEqual({ kind: 'file', path: join(folder, 'secret.txt'), root: folder });
    for (const url of ['spica-page://tok1/..%5Csecret.txt', 'spica-page://tok1/..%2Fsecret.txt', 'spica-page://tok1/a/..%2F..%2Fsecret.txt', 'spica-page://tok1/', 'spica-page://tok1/x%00.html'])
      expect(p.resolve(url)).toEqual({ kind: 'none' });
  });

  it('read only: GET (and HEAD), nothing else', () => {
    const p = new LocalPages(tokens());
    const url = p.addFile(join(folder, 'index.html'));
    expect(p.resolve(url, 'HEAD').kind).toBe('file');
    expect(p.resolve(url, 'POST').kind).toBe('none');
    expect(p.resolve(url, 'PUT').kind).toBe('none');
  });

  it('a page drawn from an answer: only its own text', () => {
    const p = new LocalPages(tokens());
    const url = p.addText('Chart', '<script>1</script>');
    expect(url).toBe('spica-page://tok1/index.html');
    expect(p.resolve(url)).toEqual({ kind: 'text', text: '<script>1</script>' });
    expect(p.resolve('spica-page://tok1/other.js')).toEqual({ kind: 'none' });
  });

  it('unknown or given-back tokens and other schemes serve nothing', () => {
    const p = new LocalPages(tokens());
    const url = p.addFile(join(folder, 'index.html'));
    expect(p.resolve('spica-page://nope/index.html').kind).toBe('none');
    expect(p.resolve('https://tok1/index.html').kind).toBe('none');
    p.release(url);
    expect(p.resolve(url).kind).toBe('none');
  });

  it('tokens are random by default', () => {
    const p = new LocalPages();
    const a = new URL(p.addFile(join(folder, 'a.html'))).host;
    const b = new URL(p.addFile(join(folder, 'a.html'))).host;
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });
});

describe('realInside: links inside the folder do not lead out', () => {
  const real = (map: Record<string, string>) => async (p: string) => {
    if (!(p in map)) throw new Error('ENOENT');
    return map[p]!;
  };
  it('a file under the folder, links followed', async () => {
    const f = join(folder, 'a.js');
    expect(await realInside(f, folder, real({ [f]: f, [folder]: folder }))).toBe(true);
  });
  it('a link in the folder that points elsewhere', async () => {
    const f = join(folder, 'escape', 'secret.txt');
    expect(await realInside(f, folder, real({ [f]: resolve('/other/secret.txt'), [folder]: folder }))).toBe(false);
  });
  it('a file that is not there', async () => {
    expect(await realInside(join(folder, 'gone.js'), folder, real({ [folder]: folder }))).toBe(false);
  });
});