/**
 * 把字体里的文字转成字标路径。运行时不再依赖字体文件。
 *
 *   npm run wordmark:from-font -w @spica/brand -- <字体.ttf> [字距] [--text 文字 --json 输出.json]
 *
 * 不给 --text：用「Spica」重写 src/wordmark.ts（仓库自带的字标）。
 * 给了 --text：把那段文字的字标写成 JSON（Wordmark 对象）到 --json 指定的路径，不碰仓库里的文件；
 * 打包时按应用名换字标走这条，JSON 交给 SpicaSplash / SpicaBanner 的 wordmark 属性。
 *
 * 字距是千分之一字号，默认 0。只吃静态字重的 TTF / OTF（可变字体先用 fontTools 的 instancer 取出需要的字重）。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { wordmarkFromFont, wordmarkModuleSource } from './wordmark-font.ts';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const text = flag('--text');
const jsonOut = flag('--json');
const [fontFile, trackingArg = '0'] = args;
if (!fontFile || (text !== undefined) !== (jsonOut !== undefined)) {
  console.error('用法：node scripts/wordmark-from-font.ts <字体.ttf> [字距] [--text 文字 --json 输出.json]');
  process.exit(1);
}

const fw = wordmarkFromFont(readFileSync(fontFile), text ?? 'Spica', Number(trackingArg));
const wm = fw.wordmark;
const summary = `${fw.fontName || path.basename(fontFile)}，宽 ${wm.width}，下伸 ${wm.descent}${wm.ascent ? `，上伸 ${wm.ascent}` : ''}`;

if (text !== undefined && jsonOut) {
  writeFileSync(jsonOut, `${JSON.stringify(wm)}\n`);
  console.log(`已写入 ${jsonOut}：${summary}`);
} else {
  const target = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/wordmark.ts');
  writeFileSync(target, wordmarkModuleSource(fw, 'Spica'));
  console.log(`已写入 ${path.relative(process.cwd(), target)}：${summary}`);
}
