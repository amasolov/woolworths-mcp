// A Yuka-style 0-100 score: 60% nutrition (Nutri-Score), 30% additives, 10%
// organic, as Yuka documents it (help.yuka.io, "food scoring"):
//
//   * nutrition: the Nutri-Score grade mapped onto A 100-75, B 75-55,
//     C 55-35, D 35-10, E 10-0. Where in the band is not published; this
//     places the product linearly by its Nutri-Score points.
//   * additives: 30 points, less 6 per limited-risk ("watch") additive, 15
//     per moderate, 30 per high.
//   * organic: 10 points.
//   * capped at 49 by any high-risk additive, and by a D or E Nutri-Score.
//
// Nutri-Score is the 2023 algorithm (general foods; beverages from the 2023
// beverage update; fats, cheese and red meat special cases). Two inputs are
// missing from Woolworths' data and taken as zero: the fruit, vegetable and
// legume share, which only ever adds favourable points, so the grade can
// come out one step harsher than on the pack (olive, canola and walnut oil
// excepted, see FV_OILS); and fibre where the panel leaves it out.

import type { AdditiveReport } from "./additives.js";

export type Kind = "general" | "beverage" | "water" | "fat" | "cheese" | "redMeat";
export type Grade = "A" | "B" | "C" | "D" | "E";

export interface Nutrients {
  energyKj?: number;
  sugars?: number;
  satFat?: number;
  fat?: number;
  sodium?: number; // mg
  protein?: number;
  fibre?: number;
}

const jsonList = (v: unknown): string[] => {
  try {
    const l = typeof v === "string" ? JSON.parse(v) : v;
    return Array.isArray(l) ? l.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
};

// Which Nutri-Score table applies. From Woolworths' own shelving: the
// website departments and categories (pies*) and the SAP category.
export function kindOf(p: any): Kind {
  const a = p?.AdditionalAttributes ?? {};
  const dept = jsonList(a.piesdepartmentnamesjson);
  const cat = jsonList(a.piescategorynamesjson);
  const sub = jsonList(a.piessubcategorynamesjson);
  const sap = String(a.sapcategoryname ?? "");
  const name = String(p?.DisplayName ?? p?.Name ?? "");
  // Sold by volume. Without this, coffee beans and tea bags from the Drinks
  // department would be scored as drinks.
  const liquid = /^\d*\s*M?L$/i.test(String(p?.CupMeasure ?? ""));

  if (cat.includes("Water") && liquid) return "water";
  if (liquid && (dept.includes("Drinks") || cat.some((c) => /Milk/.test(c)) || /MILK/.test(sap))) return "beverage";
  if (/OILS|BUTTER & MARGARINE/.test(sap) || sub.some((c) => /^(Oil|Butter & Margarine|Peanut Butter|Nut Butters?)$/.test(c)))
    return "fat";
  if (cat.includes("Cheese") || /^CHEESE/.test(sap)) return "cheese";
  if (
    (dept.includes("Poultry, Meat & Seafood") || dept.includes("Deli")) &&
    /\b(beef|lamb|pork|veal|ham|bacon|salami|prosciutto|chorizo|pepperoni|mince)\b/i.test(name) &&
    !/\b(chicken|turkey|duck|fish|salmon|tuna|plant|vegan)\b/i.test(name)
  )
    return "redMeat";
  return "general";
}

// Points = how many thresholds the value exceeds.
const pts = (v: number | undefined, steps: number[]) => (v === undefined ? 0 : steps.filter((t) => v > t).length);

const ENERGY = [335, 670, 1005, 1340, 1675, 2010, 2345, 2680, 3015, 3350];
const SAT_FAT = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const SUGARS = [3.4, 6.8, 10, 14, 17, 20, 24, 27, 31, 34, 37, 41, 44, 48, 51];
const SALT = [0.2, 0.4, 0.6, 0.8, 1, 1.2, 1.4, 1.6, 1.8, 2, 2.2, 2.4, 2.6, 2.8, 3, 3.2, 3.4, 3.6, 3.8, 4];
const PROTEIN = [2.4, 4.8, 7.2, 9.6, 12, 14, 17];
const FIBRE = [3, 4.1, 5.2, 6.3, 7.4];
// Fats: energy from saturates (kJ) and the saturated share of fat (%).
const SAT_ENERGY = [120, 240, 360, 480, 600, 720, 840, 960, 1080, 1200];
const SAT_RATIO = [10, 16, 22, 28, 34, 40, 46, 52, 58, 64].map((t) => t - 1e-9); // "< t" boundaries
// Beverages.
const BEV_ENERGY = [30, 90, 150, 210, 240, 270, 300, 330, 360, 390];
const BEV_SUGARS = [0.5, 2, 3.5, 5, 6, 7, 8, 9, 10, 11];
const BEV_PROTEIN = [1.2, 1.5, 1.8, 2.1, 2.4, 2.7, 3.0];

const FRUIT_VEG = [40, 60, 80];

// Non-nutritive sweeteners: 4 unfavourable points in a beverage.
const SWEETENERS = new Set(["E950", "E951", "E952", "E954", "E955", "E957", "E959", "E960", "E961", "E962", "E969"]);

// Grade boundaries (upper bound of each of A..D) and the score range each
// table can produce, for placing a product within its band.
const BANDS: Record<"general" | "beverage" | "fat", { upper: number[]; min: number; max: number }> = {
  general: { upper: [0, 2, 10, 18], min: -17, max: 55 },
  beverage: { upper: [-Infinity, 2, 6, 9], min: -18, max: 54 },
  fat: { upper: [-6, 2, 10, 18], min: -17, max: 50 },
};
const GRADES: Grade[] = ["A", "B", "C", "D", "E"];

export interface NutriScore {
  grade: Grade;
  points: number;
  kind: Kind;
}

// Olive, rapeseed (canola) and walnut oil count wholly as "fruit, vegetables
// and legumes" in Nutri-Score - it is what lifts olive oil from C to B. The
// only fruit/veg share Woolworths' data lets us know.
const FV_OILS = /\b(olive|rapeseed|canola|walnut)\b/i;

export function nutriScore(
  n: Nutrients,
  kind: Kind,
  additiveKeys: string[] = [],
  name = ""
): NutriScore | undefined {
  if (kind === "water") return { grade: "A", points: -18, kind };
  if (n.energyKj === undefined || n.sugars === undefined || n.satFat === undefined || n.sodium === undefined) return undefined;
  const salt = (n.sodium * 2.5) / 1000;

  let negative: number;
  let protein: number;
  if (kind === "beverage") {
    negative =
      pts(n.energyKj, BEV_ENERGY) + pts(n.sugars, BEV_SUGARS) + pts(n.satFat, SAT_FAT) + pts(salt, SALT) +
      (additiveKeys.some((k) => SWEETENERS.has(k)) ? 4 : 0);
    protein = pts(n.protein, BEV_PROTEIN);
  } else if (kind === "fat") {
    const ratio = n.fat ? (100 * n.satFat) / n.fat : undefined;
    negative =
      pts(n.satFat * 37, SAT_ENERGY) + pts(n.sugars, SUGARS) + (ratio === undefined ? pts(n.satFat, SAT_FAT) : pts(ratio, SAT_RATIO)) +
      pts(salt, SALT);
    protein = pts(n.protein, PROTEIN);
  } else {
    negative = pts(n.energyKj, ENERGY) + pts(n.satFat, SAT_FAT) + pts(n.sugars, SUGARS) + pts(salt, SALT);
    protein = pts(n.protein, PROTEIN);
    // Red meat: protein counts for at most 2 points (2023).
    if (kind === "redMeat") protein = Math.min(protein, 2);
  }
  const fvShare = kind === "fat" && FV_OILS.test(name) ? 100 : 0;
  const fv = kind === "beverage" ? 2 * pts(fvShare, FRUIT_VEG) : [0, 1, 2, 5][pts(fvShare, FRUIT_VEG)];
  // Protein does not offset a product that is already unfavourable, except
  // for cheese, or one that is mostly fruit and vegetables.
  const proteinCounts = kind === "cheese" || fvShare > 80 || negative < (kind === "fat" ? 7 : 11);
  const points = negative - pts(n.fibre, FIBRE) - fv - (proteinCounts ? protein : 0);

  const band = BANDS[kind === "beverage" ? "beverage" : kind === "fat" ? "fat" : "general"];
  const i = band.upper.findIndex((u) => points <= u);
  return { grade: GRADES[i === -1 ? 4 : i], points, kind };
}

// Yuka's published bands for each grade, high end first.
const YUKA_BAND: Record<Grade, [number, number]> = { A: [100, 75], B: [75, 55], C: [55, 35], D: [35, 10], E: [10, 0] };

function nutritionPoints(ns: NutriScore): number {
  if (ns.kind === "water") return 100;
  const band = BANDS[ns.kind === "beverage" ? "beverage" : ns.kind === "fat" ? "fat" : "general"];
  const g = GRADES.indexOf(ns.grade);
  // The Nutri-Score points this grade spans.
  const lo = g === 0 ? band.min : Math.max(band.min, band.upper[g - 1] + 1);
  const hi = g === 4 ? band.max : band.upper[g];
  const [top, bottom] = YUKA_BAND[ns.grade];
  const t = hi > lo ? (Math.min(Math.max(ns.points, lo), hi) - lo) / (hi - lo) : 0;
  return top - t * (top - bottom);
}

const PENALTY = { watch: 6, moderate: 15, high: 30, none: 0 } as const;

export function yukaScore(ns: NutriScore, additives: AdditiveReport, organic: boolean): number {
  const additivePoints = Math.max(0, 30 - additives.flagged.reduce((s, a) => s + PENALTY[a.risk ?? "none"], 0));
  let score = 0.6 * nutritionPoints(ns) + additivePoints + (organic ? 10 : 0);
  if (additives.risk === "high" || ns.grade === "D" || ns.grade === "E") score = Math.min(score, 49);
  return Math.round(score);
}

/** "448.0kJ", "Approx.63.3g", "< 1.0g" -> number. Undefined when absent. */
export function num(v: string | undefined): number | undefined {
  // The first number, not every digit and dot: "Approx. 1430kJ" with the
  // punctuation stripped is ".1430", and the bacon scored an A.
  const m = v?.replace(/,(?=\d{3})/g, "").match(/\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : undefined;
}
