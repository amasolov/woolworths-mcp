// Finds additives in a Woolworths ingredient list and rates them, the way
// consumer apps like Yuka do: a product is as risky as its worst additive.
//
// The ratings come from src/additives-data.ts (Open Food Facts, see
// scripts/build-additives.mjs for what each level means and where it is from).

import { ADDITIVES, ALIASES } from "./additives-data.js";

export type Risk = "high" | "moderate" | "watch" | "none";
const RISKS: Risk[] = ["none", "watch", "moderate", "high"];

export interface FoundAdditive {
  code: string;   // "E250"
  name: string;   // "Sodium nitrite"
  risk?: Risk;    // absent: not assessed by EFSA or ANSES
}

export interface AdditiveReport {
  /** Worst risk found; "none" when nothing rated was found. */
  risk: Risk;
  /** Rated additives only (watch and above), worst first. */
  flagged: FoundAdditive[];
  /** Every additive recognised, rated or not. */
  count: number;
}

// "E450III" -> "E450(iii)" for display.
const display = (k: string) =>
  k.replace(/^(E\d+[A-H]?)([IVX]+)$/, (_, b, r) => `${b}(${r.toLowerCase()})`)
   .replace(/^(E\d+)([A-H])/, (_, b, l) => b + l.toLowerCase());

// Looks a code up, falling back to its parent: labels write "160a(ii)" or
// "150c" for variants the taxonomy may only know as a group.
function lookup(raw: string): string | undefined {
  let k = "E" + raw.toUpperCase().replace(/^(E|INS)/, "").replace(/[^0-9A-Z]/g, "");
  for (;;) {
    if (ADDITIVES[k]) return k;
    const p = k.replace(/(?<=[0-9A-H])(I|II|III|IV|V|VI|VII|VIII|IX|X)$/, "");
    const q = p !== k ? p : k.replace(/(\d)[A-Z]$/, "$1");
    if (q === k) return undefined;
    k = q;
  }
}

// One code as written on a label: "471", "E471", "INS 471", "160a". A
// variant's numeral, "160a(ii)", is split off with the brackets and dropped;
// the group's rating covers it.
const CODE = /^(?:e|ins)?\s*-?\s*(\d{3,4}[a-h]?)$/i;

export function findAdditives(ingredients: string): AdditiveReport {
  const keys = new Set<string>();
  const text = ingredients.replace(/<[^>]*>/g, " ");

  // By number. Australian labels give the class and the number in brackets:
  // "Emulsifier (471)", "Mineral Salts (450, 451)". Split on brackets and
  // separators - and before a number, for "Emulsifier 471" - and a token that
  // is nothing but a code is one. Anything else with a number in it is a
  // percentage or a weight - "(98%)", "500g" - and fails the pattern.
  for (const tok of text.split(/[()\[\]{},;:/&.]|\band\b|\s(?=(?:(?:e|ins)\s*)?\d)/i)) {
    const m = tok.trim().match(CODE);
    const k = m && lookup(m[1]);
    if (k) keys.add(k);
  }

  // By name, for labels that spell it out ("Sodium Nitrite"). Matched on
  // letters and digits only: Woolworths' text has stray spaces inside words
  // ("Maltodextri n"). Longest alias first, and a match is cut out of the
  // text so "monosodium glutamate" does not also count as "glutamate".
  let squashed = text.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]/g, "");
  for (const [alias, k] of ALIASES) {
    if (squashed.includes(alias)) {
      keys.add(k);
      squashed = squashed.split(alias).join("|");
    }
  }

  // A group and its own member (E450 and E450(i)) on one label is one
  // additive written twice; keep the more specific.
  for (const k of keys) {
    for (const other of keys) if (other !== k && other.startsWith(k) && /^[A-HIVX]+$/.test(other.slice(k.length))) keys.delete(k);
  }

  const found: FoundAdditive[] = [...keys].map((k) => {
    const [name, r] = ADDITIVES[k];
    return r === undefined ? { code: display(k), name } : { code: display(k), name, risk: RISKS[r] };
  });
  const rank = (a: FoundAdditive) => (a.risk ? RISKS.indexOf(a.risk) : -1);
  const flagged = found.filter((a) => rank(a) >= 1).sort((a, b) => rank(b) - rank(a));
  return { risk: flagged[0]?.risk ?? "none", flagged, count: found.length };
}

export const riskRank = (r?: Risk | "unknown") => (r && r !== "unknown" ? RISKS.indexOf(r) : -1);
