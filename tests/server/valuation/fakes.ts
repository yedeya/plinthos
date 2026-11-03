import { PriceUnavailable, type PriceGuide, type PriceProvider, type PriceUnavailableReason } from '../../../src/server/valuation/bricklink';

/** What the stand-in answers for one quote: a guide, null (unknown to BrickLink), or a refusal. */
export type FakeAnswer = { readonly average: number | null; readonly sampleSize?: number; readonly currency?: string } | null | { readonly refuse: PriceUnavailableReason };

/**
 * A stand-in price provider over a made-up price list, keyed `TYPE NO N|U`, and a clock each
 * request moves on by `requestMs`, so a test can spend a refresh's budget without waiting.
 * Every item number and price here is made up.
 */
export function standInPrices(answers: Readonly<Record<string, FakeAnswer>>, options: { readonly start?: Date; readonly requestMs?: number } = {}) {
  let clock = (options.start ?? new Date('2026-11-03T10:00:00.000Z')).getTime();
  const requestMs = options.requestMs ?? 1_000;
  const asked: string[] = [];
  const budgets: number[] = [];
  const provider: PriceProvider = {
    async priceGuide(itemType, itemNo, newOrUsed, { budgetMs }): Promise<PriceGuide | null> {
      const key = `${itemType} ${itemNo} ${newOrUsed}`;
      asked.push(key);
      budgets.push(budgetMs);
      clock += requestMs;
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
