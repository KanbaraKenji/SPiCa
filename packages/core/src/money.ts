// How an amount of money is written where people read it next to a limit they typed (the stop at a spending
// limit, the monitor): US$, up to four decimals, at least two. No dependencies: the desktop shell's demo uses it too.

/** US$0.02, US$0.0203, US$0.015, US$1.20. */
export function usdText(n: number): string {
  return `US$${Math.max(0, n).toFixed(4).replace(/0{1,2}$/, '')}`;
}
