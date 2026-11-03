import { PriceUnavailable, type PriceGuide, type PriceProvider, type PriceUnavailableReason } from '../../../src/server/valuation/bricklink';

/** What the stand-in answers for one quote: a guide, null (unknown to BrickLink), or a refusal. */
export type FakeAnswer = { readonly average: number | null; readonly sampleSize?: number; readonly currency?: string } | null | { readonly refuse: PriceUnavailableReason };

/**
 * A stand-in price provider over a made-up price list, keyed `TYPE NO N|U`, or `TYPE NO COLOUR N|U`
 * when the caller gave a colour, and a clock each request moves on by `requestMs`, so a test can
 * spend a refresh's budget without waiting. Like the real client, it asks the caller's `admit`
 * before each request and refuses with `daily-limit` when it says no. `during` runs inside each
 * request, before it answers. Every item number and price here is made up.
 */
export function standInPrices(
  answers: Readonly<Record<string, FakeAnswer>>,
  options: { readonly start?: Date; readonly requestMs?: number; readonly during?: (key: string) => Promise<void> } = {},
) {
  let clock = (options.start ?? new Date('2026-11-03T10:00:00.000Z')).getTime();
  const requestMs = options.requestMs ?? 1_000;
  const asked: string[] = [];
  const budgets: number[] = [];
  const provider: PriceProvider = {
    async priceGuide(itemType, itemNo, newOrUsed, { budgetMs, colorId, admit }): Promise<PriceGuide | null> {
      const key = colorId === undefined ? `${itemType} ${itemNo} ${newOrUsed}` : `${itemType} ${itemNo} ${colorId} ${newOrUsed}`;
      if (admit !== undefined && !(await admit())) throw new PriceUnavailable('daily-limit');
      asked.push(key);
      budgets.push(budgetMs);
      clock += requestMs;
      await options.during?.(key);
      const answer = answers[key];
      if (answer === undefined || answer === null) return null;
      if ('refuse' in answer) throw new PriceUnavailable(answer.refuse);
      return { itemType, itemNo, newOrUsed, average: answer.average, sampleSize: answer.sampleSize ?? 5, currency: answer.currency ?? 'EUR' };
    },
  };
  return {
    provider,
    asked,
    budgets,
    now: () => new Date(clock),
    advance: (ms: number) => {
      clock += ms;
    },
  };
}
