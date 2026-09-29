import type { CostPriceBook } from '../shared/cost-contracts.js';
import { createDefaultPriceBook, parsePriceBook } from '../shared/cost-engine.js';

export function loadCostPriceBook(env: NodeJS.ProcessEnv): CostPriceBook {
  if (env.COST_PRICEBOOK_JSON === undefined) return createDefaultPriceBook();
  if (!env.COST_PRICEBOOK_JSON.trim() || env.COST_PRICEBOOK_JSON.length > 32_768) {
    throw new Error('Invalid cost price-book configuration.');
  }
  let value: unknown;
  try {
    value = JSON.parse(env.COST_PRICEBOOK_JSON);
  } catch {
    throw new Error('Cost price-book configuration must be valid JSON.');
  }
  return parsePriceBook(value);
}
