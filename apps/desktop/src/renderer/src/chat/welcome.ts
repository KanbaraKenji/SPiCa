// The words on the empty page of a new conversation: a greeting for the time of day with the user's nickname
// (设置 › 账号 › 昵称), and under it the question the page always asked. He picked this one (2026-11-12, 「A：只加问候」)
// over a line that changed with the day and one with today's date. Calm, as the rest of the app speaks.

/** The line under the greeting (the question the empty page asked before there was a greeting). */
export const ASK = '有什么要我做的？';

/** When each part of the day starts (hour, minute) and what is said then; the last one runs past midnight. */
export const DAY_PARTS: { from: [number, number]; greeting: string }[] = [
  { from: [0, 0], greeting: '夜深了' },
  { from: [5, 0], greeting: '早上好' },
  { from: [9, 0], greeting: '上午好' },
  { from: [11, 30], greeting: '中午好' },
  { from: [13, 30], greeting: '下午好' },
  { from: [18, 0], greeting: '晚上好' },
  { from: [23, 0], greeting: '夜深了' },
];

/** 早上好 … 夜深了, by the time of day. */
export function dayGreeting(d: Date): string {
  const m = d.getHours() * 60 + d.getMinutes();
  let hit = DAY_PARTS[0]!.greeting;
  for (const p of DAY_PARTS) if (m >= p.from[0] * 60 + p.from[1]) hit = p.greeting;
  return hit;
}

/** 「下午好，Alex」; without a name only 「下午好」 (never a comma with nothing after it). */
export function greeting(d: Date, name: string): string {
  const g = dayGreeting(d);
  const n = name.trim();
  return n ? `${g}，${n}` : g;
}
