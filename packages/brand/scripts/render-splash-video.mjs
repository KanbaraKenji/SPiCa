// 开机短片逐帧渲染：直接用本包的时间线函数（splashFrame / starfield），和组件同一份数学。
// 出 1280×720 PNG 帧到 <输出目录>/frames/<主题>/；可按帧段拆成多个进程并行，最后用 ffmpeg 合成 mp4：
//   ffmpeg -framerate 60 -i frames/dark/f%05d.png -c:v libx264 -preset slow -crf 20 -pix_fmt yuv420p -movflags +faststart boot-dark.mp4
// 用法：node scripts/render-splash-video.mjs <dark|light> <起始帧> <结束帧（不含）> [readyAt=7] [fps=60] [输出目录=demo-out]
import { Resvg } from '@resvg/resvg-js';
import fs from 'node:fs';
import path from 'node:path';
import { MARK_CENTER, MARK_GEOMETRY, sparklePath } from '../src/geometry.ts';
import { SPLASH_LAYOUT as L, SPLASH_STAGE, splashFrame, starfield } from '../src/splash.ts';
import { WORDMARK } from '../src/wordmark.ts';

const [theme = 'dark', fromArg = '0', toArg = '0', readyArg = '7', fpsArg = '60', outArg = 'demo-out'] = process.argv.slice(2);
const readyAt = Number(readyArg);
const FPS = Number(fpsArg);
const W = SPLASH_STAGE.width, H = SPLASH_STAGE.height;
const T = theme === 'dark'
  ? { bg: '#0B0F19', ink: '#F1F5F9', acc: '#62A9FF', star: '#DCE8FF', companion: '#E8F0FF', core: '#FFFFFF', glow: 0.55, vign: true }
  : { bg: '#F7F9FC', ink: '#0F172A', acc: '#2F7DE1', star: '#9DB8E0', companion: '#1B3F7A', core: null, glow: 0, vign: false };
// 可选：SPLASH_OPTIONS 环境变量传 JSON（例如 {"finish":{"bigTurns":0.7,"diveAngle":222}}），用来出对比档
const OPTS = process.env.SPLASH_OPTIONS ? JSON.parse(process.env.SPLASH_OPTIONS) : {};
// 拖尾画法：streak = 连续光带（缺省），dots = 一串光点（SPLASH_TRAIL=dots）
const TRAIL = process.env.SPLASH_TRAIL === 'dots' ? 'dots' : 'streak';
const C = MARK_CENTER;
const STAR_R = 7;
const SPARK = sparklePath(0, 0, STAR_R * 2.4, 0.16);
const f2 = (n) => n.toFixed(2);

const defs = `<defs>
<radialGradient id="glow"><stop offset="0" stop-color="${T.acc}" stop-opacity="${T.glow}"/><stop offset="0.45" stop-color="${T.acc}" stop-opacity="0.12"/><stop offset="1" stop-color="${T.acc}" stop-opacity="0"/></radialGradient>
<radialGradient id="sg"><stop offset="0" stop-color="${T.acc}" stop-opacity="0.12"/><stop offset="1" stop-color="${T.acc}" stop-opacity="0"/></radialGradient>
<radialGradient id="vign" cx="0.5" cy="0.5" r="0.75"><stop offset="0.55" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.55"/></radialGradient>
<filter id="blur" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="6"/></filter>
</defs>`;

function starEl(s) {
  if (s.opacity <= 0.005) return '';
  const halo = theme === 'dark' ? `<circle r="${STAR_R * 2.6}" fill="url(#sg)" opacity="0.5"/>` : '';
  return `<g transform="translate(${f2(s.x)} ${f2(s.y)}) scale(${f2(s.scale)})" opacity="${s.opacity.toFixed(3)}">${halo}<path d="${SPARK}" fill="${s.companion ? T.companion : T.acc}"/><circle r="${STAR_R * 0.55}" fill="${T.core ?? (s.companion ? T.companion : T.acc)}"/></g>`;
}
function trailEl(d) {
  if (d.opacity <= 0.005) return '';
  return `<circle cx="${f2(d.x)}" cy="${f2(d.y)}" r="${f2(d.r)}" fill="${d.companion ? T.companion : T.acc}" opacity="${d.opacity.toFixed(3)}"/>`;
}
function ribbonEl(r) {
  if (r.opacity <= 0.005) return '';
  return `<path d="${r.d}" fill="${r.companion ? T.companion : T.acc}" opacity="${r.opacity.toFixed(3)}"/>`;
}
const trailEls = (f, front) => TRAIL === 'dots'
  ? f.trails.filter((d) => d.front === front).map(trailEl)
  : f.ribbons.filter((r) => r.front === front).map(ribbonEl);
const petalPaths = (ink, acc) => MARK_GEOMETRY.petals.map((p) => `<path fill="${p.long ? acc : ink}" transform="rotate(${p.angle} ${C} ${C})" d="${p.d}"/>`).join('');
const letterBody = (s, color) => s.kind === 'fill'
  ? `<path fill="${color}"${s.evenOdd ? ' fill-rule="evenodd"' : ''} d="${s.d}"/>`
  : `<path fill="none" stroke="${color}" stroke-width="${s.strokeWidth}" stroke-linecap="square" stroke-linejoin="miter" d="${s.d}"/>`;

function frame(t) {
  const ready = t >= readyAt ? readyAt : null;
  const f = splashFrame(t, ready, OPTS);
  const out = [];
  for (const s of starfield(t, ready, W, H, 1, OPTS)) {
    if (s.opacity <= 0.005) continue;
    out.push(`<line x1="${f2(s.x1)}" y1="${f2(s.y1)}" x2="${f2(s.x2)}" y2="${f2(s.y2)}" stroke="${s.accent ? T.acc : T.star}" stroke-width="${f2(s.width)}" stroke-linecap="round" opacity="${(s.opacity * f.layer).toFixed(3)}"/>`);
  }
  const g = [];
  if (theme === 'dark') g.push(`<circle cx="${L.cx}" cy="${L.cy}" r="${f2(L.markScale * 61)}" fill="url(#glow)" opacity="${f.glow.toFixed(3)}"/>`);
  g.push(...trailEls(f, false));
  for (const s of f.stars) if (!s.front) g.push(starEl(s));
  // 花标：底色剪影（挡住后面的星）→ 呼吸中的暗花标 → 水波填充的实色花标（圆形遮罩）→ 涟漪 → 轴
  let mark = `<g opacity="${f.appear.toFixed(3)}">${petalPaths(T.bg, T.bg)}<circle cx="${C}" cy="${C}" r="4.5" fill="${T.bg}"/></g>`;
  mark += `<g opacity="${(f.petals[0]?.opacity ?? 0).toFixed(3)}">${petalPaths(T.ink, T.acc)}</g>`;
  if (f.fill) {
    mark += `<clipPath id="fillclip"><circle cx="${C}" cy="${C}" r="${f.fill.radius.toFixed(3)}"/></clipPath><g clip-path="url(#fillclip)">${petalPaths(T.ink, T.acc)}</g>`;
    for (const rp of f.fill.ripples) if (rp.opacity > 0.005) mark += `<circle cx="${C}" cy="${C}" r="${rp.r.toFixed(3)}" fill="none" stroke="${T.acc}" stroke-width="0.35" opacity="${rp.opacity.toFixed(3)}"/>`;
  }
  mark += `<circle cx="${C}" cy="${C}" r="${(4.5 * f.hubScale).toFixed(3)}" fill="${T.ink}" opacity="${f.hubOpacity.toFixed(3)}"/>`;
  g.push(`<g transform="translate(${L.cx} ${L.cy}) scale(${L.markScale}) translate(-${C} -${C})">${mark}</g>`);
  // 字标：暗色辉光是模糊的强调色垫在下面；浅色辉光是清晰的强调色盖在上面
  let word = '';
  WORDMARK.shapes.forEach((s, i) => {
    const l = f.letters[i];
    const tr = `translate(0 ${(l.dy / L.wordScale).toFixed(3)})`;
    const glow = l.glow > 0.005 ? `<g transform="${tr}" opacity="${l.glow.toFixed(3)}"${theme === 'dark' ? ' filter="url(#blur)"' : ''}>${letterBody(s, T.acc)}</g>` : '';
    const letter = `<g transform="${tr}" opacity="${l.opacity.toFixed(3)}">${letterBody(s, T.ink)}</g>`;
    word += theme === 'dark' ? glow + letter : letter + glow;
  });
  g.push(`<g transform="translate(${L.wordX} ${L.wordY}) scale(${L.wordScale})">${word}</g>`);
  g.push(...trailEls(f, true));
  for (const s of f.stars) if (s.front) g.push(starEl(s));
  out.push(`<g opacity="${f.layer.toFixed(3)}">${g.join('')}</g>`);
  if (T.vign) out.push(`<rect width="${W}" height="${H}" fill="url(#vign)"/>`);
  return out.join('');
}

const dir = path.resolve(outArg, 'frames', theme);
fs.mkdirSync(dir, { recursive: true });
for (let i = Number(fromArg); i < Number(toArg); i++) {
  const t = i / FPS;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="1280" height="720">${defs}<rect width="${W}" height="${H}" fill="${T.bg}"/>${frame(t)}</svg>`;
  fs.writeFileSync(path.join(dir, `f${String(i).padStart(5, '0')}.png`), new Resvg(svg).render().asPng());
}
console.log('ok', theme, fromArg, toArg);
