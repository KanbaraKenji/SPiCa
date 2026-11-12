// How a spend is written where it is shown (信息栏 › 花费, 设置 › 插件 › 今日). Calls of a model without a known
// price (a company gateway's) are not counted (packages/core cost.ts, ModelPrice.unpriced): what they cost is
// unknown, so it is said in words, never as 0 (he, 2026-11-12: 没有价格的模型……花费显示成「未计价」).
// Mixed: the counted part, then 「+ 未计价」, so it does not read as the whole cost.

export const UNPRICED = '未计价';

/** `amount` writes the counted part ($0.12 or US$0.12, as the place does). */
export function spendText(usd: number, unpriced: boolean | undefined, amount: (usd: number) => string): string {
  if (!unpriced) return amount(usd);
  return usd > 0 ? `${amount(usd)} + ${UNPRICED}` : UNPRICED;
}
