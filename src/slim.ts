// Response slimming for Woolworths API payloads.
// A raw search tile is ~11 KB (~3-4k tokens); a slim product is ~150 bytes.

import { AdditiveReport, findAdditives, Risk } from "./additives.js";
import { kindOf, Nutrients, num, nutriScore, yukaScore } from "./score.js";

export type Detail = "summary" | "nutrition" | "health" | "full";

export interface SlimProduct {
  stockcode: number;
  name: string;            // DisplayName already includes brand + pack size
  price: number | null;
  cup?: string;            // unit price, e.g. "$1.65 / 1L" - key for comparisons
  special?: true;
  was?: number;
  save?: number;
  promo?: string;          // multibuy / "Range was $4.50" / member price text
  hsr?: number;            // health star rating
  unavailable?: true;
  sponsored?: true;
  nutrition?: Record<string, string>; // per 100g/100mL
  health?: Health;
}

export interface Health {
  /** Yuka-style 0-100 (see src/score.ts). Absent without nutrition or ingredients. */
  score?: number;
  /** Nutri-Score as computed from the panel; fruit/veg share taken as 0. */
  nutriScore?: string;
  /** Worst additive found; "unknown" when Woolworths has no ingredient list. */
  risk: Risk | "unknown";
  /** Rated additives, worst first: "E250 Sodium nitrite: high". */
  flagged?: string[];
  /** All additives recognised, rated or not. */
  additives?: number;
  /** Fresh fruit or vegetables: no ingredient list, nothing added. */
  produce?: true;
  organic?: true;
}

// Woolworths fills a missing attribute with the string "None".
export function ingredientsOf(p: any): string | undefined {
  const v = p?.AdditionalAttributes?.ingredients;
  return typeof v === "string" && v.trim() && v.trim() !== "None" ? v : undefined;
}

// Fresh fruit and vegetables have no ingredient list because they are the
// ingredient. Without this they rank as "unknown", below banana chips.
function isProduce(p: any): boolean {
  const a = p?.AdditionalAttributes ?? {};
  return a.sapdepartmentname === "FRUIT AND VEG" || jsonList(a.piescategorynamesjson).includes("Fruit & Veg");
}

const jsonList = (v: unknown): string[] => {
  try {
    const l = typeof v === "string" ? JSON.parse(v) : v;
    return Array.isArray(l) ? l.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
};

/** The website's shelf names, e.g. ["Stock & Gravy"] - what "comparable" means. */
export const subcategoriesOf = (p: any): string[] =>
  [...new Set(jsonList(p?.AdditionalAttributes?.piessubcategorynamesjson))];

// Organic by name ("Macro Organic") or by Woolworths' claims fields.
function isOrganic(p: any): boolean {
  const a = p?.AdditionalAttributes ?? {};
  return /\borganic\b/i.test([p?.DisplayName, a.lifestyleanddietarystatement, a.lifestyleclaim, a.claims].join(" "));
}

export function nutrientsOf(p: any): Nutrients {
  const n = parseNutrition(p?.AdditionalAttributes?.nutritionalinformation) ?? {};
  return {
    energyKj: num(n.energyKj),
    sugars: num(n.sugars),
    satFat: num(n.satFat),
    fat: num(n.fat),
    sodium: num(n.sodium),
    protein: num(n.protein),
    fibre: num(n.fibre),
  };
}

export function healthOf(p: any): Health {
  const ingredients = ingredientsOf(p);
  const produce = !ingredients && isProduce(p);
  const r: AdditiveReport | undefined = ingredients
    ? findAdditives(ingredients)
    : produce
      ? { risk: "none", flagged: [], count: 0, keys: [] }
      : undefined;

  const h: Health = { risk: r ? r.risk : "unknown" };
  const kind = kindOf(p);
  const ns = nutriScore(nutrientsOf(p), kind, r?.keys, p?.DisplayName ?? p?.Name);
  const organic = isOrganic(p);
  // Yuka scores only what it can see in full: nutrition and ingredients both.
  if (ns && r) h.score = yukaScore(ns, r, organic);
  if (ns) h.nutriScore = ns.grade;
  if (r?.flagged.length) h.flagged = r.flagged.map((a) => `${a.code} ${a.name}: ${a.risk}`);
  if (r?.count) h.additives = r.count;
  if (produce) h.produce = true;
  if (organic) h.organic = true;
  return h;
}

const stripHtml = (s?: string | null): string | undefined =>
  s ? s.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim() || undefined : undefined;

function parseHsr(v: unknown): number | undefined {
  const n = parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : undefined;
}

// nutritionalinformation is a JSON string inside JSON, with ~25 rows of
// per-100g, per-serve, ValueWord and SuffixUnits duplicates. Keep 8 numbers.
const NUTRIENTS: Record<string, string> = {
  "Energy kJ Quantity Per 100g - Total - NIP": "energyKj",
  "Protein Quantity Per 100g - Total - NIP": "protein",
  "Fat Total Quantity Per 100g - Total - NIP": "fat",
  "Fat Saturated Quantity Per 100g - Total - NIP": "satFat",
  "Carbohydrate Quantity Per 100g - Total - NIP": "carbs",
  "Sugars Quantity Per 100g - Total - NIP": "sugars",
  "Dietary Fibre Quantity Per 100g - Total - NIP": "fibre",
  "Sodium Quantity Per 100g - Total - NIP": "sodium",
};

export function parseNutrition(raw: unknown): Record<string, string> | undefined {
  if (typeof raw !== "string" || !raw) return undefined;
  try {
    const attrs: any[] = JSON.parse(raw)?.Attributes ?? [];
    const out: Record<string, string> = {};
    for (const a of attrs) {
      const key = NUTRIENTS[a?.Name];
      if (key && a.Value != null) out[key] = String(a.Value);
    }
    return Object.keys(out).length ? out : undefined;
  } catch {
    return undefined;
  }
}

function promoText(p: any): string | undefined {
  return (
    stripHtml(p.CentreTag?.TagContentText) ??
    stripHtml(p.CentreTag?.TagContent) ??
    stripHtml(p.HeaderTag?.Content)
  );
}

export function slimProduct(p: any, detail: Detail = "summary"): SlimProduct | any {
  if (detail === "full") return p;
  const attrs = p.AdditionalAttributes ?? {};

  // Only emit non-default fields: absent means false / not applicable.
  const s: SlimProduct = {
    stockcode: p.Stockcode,
    name: p.DisplayName ?? p.Name,
    price: p.Price ?? null,
  };
  if (p.HasCupPrice && p.CupString) s.cup = p.CupString;
  if (p.IsOnSpecial) {
    s.special = true;
    if (p.WasPrice != null && p.WasPrice !== p.Price) s.was = p.WasPrice;
    if (p.SavingsAmount) s.save = p.SavingsAmount;
  }
  const promo = promoText(p);
  if (promo) s.promo = promo;
  const hsr = parseHsr(attrs.healthstarrating);
  if (hsr !== undefined) s.hsr = hsr;
  if (p.IsAvailable === false || p.IsPurchasable === false) s.unavailable = true;
  if (p.IsSponsoredAd) s.sponsored = true;
  if (detail === "nutrition" || detail === "health") {
    const n = parseNutrition(attrs.nutritionalinformation);
    if (n) s.nutrition = n;
  }
  if (detail === "health") s.health = healthOf(p);
  return s;
}

// Search returns tiles: { Products: [variant...], Name, DisplayName }.
// Flatten, optionally drop injected ads, and dedupe by stockcode
// (a sponsored product often also appears organically further down).
export function slimSearchProducts(
  tiles: any[],
  detail: Detail,
  includeSponsored: boolean
): any[] {
  const seen = new Set<number>();
  const out: any[] = [];
  for (const tile of tiles ?? []) {
    for (const p of tile?.Products ?? [tile]) {
      if (!p || seen.has(p.Stockcode)) continue;
      if (!includeSponsored && p.IsSponsoredAd) continue;
      seen.add(p.Stockcode);
      out.push(slimProduct(p, detail));
    }
  }
  return out;
}
