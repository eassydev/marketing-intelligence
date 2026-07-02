import Anthropic from '@anthropic-ai/sdk';
import { env } from '../../config/env.js';
import { createChildLogger } from '../../shared/logger/index.js';
import type { MarketingState } from '../context/serialize.js';

const log = createChildLogger({ module: 'insights' });

export interface Insights {
  generated: boolean;
  model: string | null;
  summary: string;
  state: MarketingState;
}

const SYSTEM = `You are a performance-marketing analyst for a ${env.MIL_MARKET_DESCRIPTION}. Given a compact JSON snapshot of marketing state, write 4-6 crisp bullet insights: blended CAC health, which campaigns are efficient vs wasteful (cost per first order), notable drops, and ONE prioritized recommendation. Amounts in ${env.MIL_CURRENCY}. No preamble, just the bullets.`;

/**
 * The AI brain over the serialize seam. Degrades gracefully to a deterministic
 * summary when ANTHROPIC_API_KEY is unset, so the endpoint always works.
 */
export async function generateInsights(state: MarketingState): Promise<Insights> {
  if (!env.ANTHROPIC_API_KEY) {
    return { generated: false, model: null, summary: fallbackSummary(state), state };
  }
  try {
    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    const res = await client.messages.create({
      model: env.ANTHROPIC_MODEL,
      max_tokens: 600,
      temperature: 0,
      system: SYSTEM,
      messages: [{ role: 'user', content: `Marketing state:\n${JSON.stringify(state)}` }],
    });
    const summary = res.content
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('')
      .trim();
    return { generated: true, model: env.ANTHROPIC_MODEL, summary, state };
  } catch (err) {
    log.error({ err: (err as Error).message }, 'insight generation failed; using fallback');
    return { generated: false, model: null, summary: fallbackSummary(state), state };
  }
}

function fallbackSummary(state: MarketingState): string {
  const p = state.performance;
  const lines = [
    `Window ${state.window.from}..${state.window.to} (${state.app}).`,
    `Spend ₹${p.spendInr}, first orders ${p.firstOrders}, blended CAC ${p.blendedCacInr == null ? 'n/a' : '₹' + p.blendedCacInr}.`,
  ];
  if (state.topCampaigns.length > 0) {
    const top = state.topCampaigns[0]!;
    lines.push(
      `Top-spend campaign: ${top.campaign ?? 'unknown'} (₹${top.spendInr}, CPFO ${top.costPerFirstOrderInr == null ? 'n/a' : '₹' + top.costPerFirstOrderInr}).`,
    );
  } else {
    lines.push('No campaign spend yet — connect Meta/Google to populate.');
  }
  lines.push('(LLM summary disabled: set ANTHROPIC_API_KEY to enable narrative insights.)');
  return lines.join(' ');
}
