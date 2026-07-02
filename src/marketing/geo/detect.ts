export interface MentionResult {
  mentioned: boolean;
  /** ~60 chars of context either side of the first match; null when no match. */
  excerpt: string | null;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Compile one alias into a word-boundary-ish, separator-flexible pattern:
 * 'eassy life' → /(?<![a-z0-9])eassy[\s.\-_]?life(?![a-z0-9])/i, which matches
 * "Eassy Life", "EassyLife", "eassy-life", "eassy.life" and "eassylife.in"
 * (trailing ".in" is a non-alnum boundary) but not "easylife" or "eassylifestyle".
 */
function aliasPattern(alias: string): RegExp {
  const parts = alias.toLowerCase().split(/[\s.\-_]+/).filter(Boolean).map(escapeRegExp);
  return new RegExp(`(?<![a-z0-9])${parts.join('[\\s.\\-_]?')}(?![a-z0-9])`, 'i');
}

/** Pure: does `text` mention the brand (any alias, any common variant)? */
export function detectMention(text: string, aliases: string[]): MentionResult {
  for (const alias of aliases) {
    if (!alias.trim()) continue;
    const match = aliasPattern(alias).exec(text);
    if (match) {
      const start = Math.max(0, match.index - 60);
      const end = Math.min(text.length, match.index + match[0].length + 60);
      return { mentioned: true, excerpt: text.slice(start, end).trim() };
    }
  }
  return { mentioned: false, excerpt: null };
}

export interface CitationSplit {
  /** First cited domain that is the brand's own (→ geo_observation.cited_url). */
  brandCitedDomain: string | null;
  /** Every other cited domain (→ geo_observation.competitors JSONB). */
  competitorDomains: string[];
}

/** Pure: split an engine's cited domains into the brand's own vs everyone else. */
export function classifyCitations(citedDomains: string[], aliases: string[]): CitationSplit {
  const patterns = aliases.filter((a) => a.trim()).map(aliasPattern);
  let brandCitedDomain: string | null = null;
  const competitorDomains: string[] = [];
  for (const domain of citedDomains) {
    if (patterns.some((p) => p.test(domain))) {
      brandCitedDomain ??= domain;
    } else {
      competitorDomains.push(domain);
    }
  }
  return { brandCitedDomain, competitorDomains };
}
