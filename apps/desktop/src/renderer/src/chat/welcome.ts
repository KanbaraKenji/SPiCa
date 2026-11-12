// The words on the empty page of a new conversation: a greeting for the time of day with the name the user
// goes by (设置 › 账号 › 称呼), and a line under it. Three ways to fill that line, for him to pick (2026-11-12):
//   a  the plain one: the question the page always asked
//   b  a line for the time of day and the day of the week (LINES below)
//   c  today's date, and how many conversations wait for the user to answer or confirm
// All the words are here, in one place. Calm, as the rest of the app speaks: no exclamation marks, no slang.

export type WelcomeStyle = 'a' | 'b' | 'c';

/** Which one the page shows until he picks. */
export const WELCOME_STYLE: WelcomeStyle = 'a';

/** The question the empty page asked before there was a greeting (and still asks under style a). */
export const ASK = '有什么要我做的？';

export type DayPart = 'morning' | 'forenoon' | 'noon' | 'afternoon' | 'evening' | 'late';

/** When each part of the day starts (hour, minute) and what is said then; the last one runs past midnight. */
export const DAY_PARTS: { part: DayPart; from: [number, number]; greeting: string }[] = [
  { part: 'late', from: [0, 0], greeting: '夜深了' },
  { part: 'morning', from: [5, 0], greeting: '早上好' },
  { part: 'forenoon', from: [9, 0], greeting: '上午好' },
  { part: 'noon', from: [11, 30], greeting: '中午好' },
  { part: 'afternoon', from: [13, 30], greeting: '下午好' },
  { part: 'evening', from: [18, 0], greeting: '晚上好' },
  { part: 'late', from: [23, 0], greeting: '夜深了' },
];

export function dayPart(d: Date): { part: DayPart; greeting: string } {
  const m = d.getHours() * 60 + d.getMinutes();
  let hit = DAY_PARTS[0]!;
  for (const p of DAY_PARTS) if (m >= p.from[0] * 60 + p.from[1]) hit = p;
  return { part: hit.part, greeting: hit.greeting };
}

/** 「下午好，Alex」; without a name only 「下午好」 (never a comma with nothing after it). */
export function greeting(d: Date, name: string): string {
  const g = dayPart(d).greeting;
  const n = name.trim();
  return n ? `${g}，${n}` : g;
}

/**
 * Style b's lines. `when` narrows a line to days of the week (0 = Sunday) and parts of the day; the most narrow
 * line that fits is said, and among lines as narrow, the day picks one (the same all day: switching to a new
 * conversation does not change it).
 */
export const LINES: { text: string; days?: number[]; parts?: DayPart[] }[] = [
  { text: '新的一周，先从最要紧的一件开始。', days: [1], parts: ['morning', 'forenoon'] },
  { text: '周五下午了，把这周没收尾的事理一理？', days: [5], parts: ['afternoon'] },
  { text: '周末还在忙，有什么我先接过来。', days: [0, 6], parts: ['morning', 'forenoon', 'noon', 'afternoon', 'evening'] },
  { text: '这么晚了，要做的我先记下，明天接着做也可以。', parts: ['late'] },
  { text: '今天先处理哪件事？', parts: ['morning'] },
  { text: '先把今天要做的过一遍？', parts: ['morning', 'forenoon'] },
  { text: '要查的、要写的，都可以交给我。', parts: ['forenoon'] },
  { text: '吃过饭了吗？有事可以先交给我。', parts: ['noon'] },
  { text: '下午的事，从哪件开始？', parts: ['afternoon'] },
  { text: '有文件要整理、报告要写，可以交给我。', parts: ['afternoon'] },
  { text: '今天还有什么没做完？', parts: ['evening'] },
  { text: '收尾的事交给我，你早点休息。', parts: ['evening'] },
];

function dayKey(d: Date): number {
  return d.getFullYear() * 400 + d.getMonth() * 32 + d.getDate();
}

/** Style b's line for this moment. */
export function lineFor(d: Date): string {
  const { part } = dayPart(d);
  const day = d.getDay();
  const fits = LINES.filter((l) => (!l.days || l.days.includes(day)) && (!l.parts || l.parts.includes(part)));
  const narrow = (l: (typeof LINES)[number]) => (l.days ? 2 : 0) + (l.parts ? 1 : 0);
  const best = Math.max(...fits.map(narrow));
  const pool = fits.filter((l) => narrow(l) === best);
  return pool.length ? pool[dayKey(d) % pool.length]!.text : ASK;
}

const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

/** Style c's line: 「11月12日 星期四」, and 「2 条对话在等你回答或确认」 when there are any. */
export function todayLine(d: Date, waiting: number): string {
  const date = `${d.getMonth() + 1}月${d.getDate()}日 ${WEEKDAYS[d.getDay()]}`;
  return waiting > 0 ? `${date} · ${waiting} 条对话在等你回答或确认` : date;
}

/** What the empty page says: the greeting (the big line) and the line under it. */
export function welcome(o: { now: Date; name: string; waiting: number; style?: WelcomeStyle }): { title: string; line: string } {
  const style = o.style ?? WELCOME_STYLE;
  const title = greeting(o.now, o.name);
  if (style === 'b') return { title, line: lineFor(o.now) };
  if (style === 'c') return { title, line: todayLine(o.now, o.waiting) };
  return { title, line: ASK };
}
