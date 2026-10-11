#!/usr/bin/env node
// Regenerates src/additives-data.ts from the Open Food Facts additives
// taxonomy: every E-numbered additive, its English names, and a risk level.
//
//   node scripts/build-additives.mjs [ref]     (ref: a commit or branch, default main)
//
// Why Open Food Facts: it carries the same public assessments that consumer
// apps like Yuka grade additives from - the EFSA re-evaluations ("risk of
// overexposure": high / moderate / none) and the ANSES 2019 list of
// "additives of interest". Yuka's own grading has no public source or API.
//
// Why the .txt and not the published additives.json: only the source file
// has the English synonyms ("Sodium nitrite", "MSG Fine"), which is how an
// additive is named on a label that gives no number.
//
// The taxonomy is ODbL. The generated file says so, and names the commit.

import { writeFileSync } from "node:fs";

const ref = process.argv[2] ?? "main";
const repo = "openfoodfacts/openfoodfacts-server";

const sha = await (await fetch(`https://api.github.com/repos/${repo}/commits/${ref}`, {
  headers: { Accept: "application/vnd.github.sha" },
})).text();
if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`could not resolve ${repo}@${ref}: ${sha}`);

const res = await fetch(`https://raw.githubusercontent.com/${repo}/${sha}/taxonomies/additives.txt`);
if (!res.ok) throw new Error(`taxonomy fetch failed: ${res.status}`);
const text = await res.text();

// "E450(iii)" -> "E450III"; the key the matcher looks codes up by.
const codeKey = (c) => c.toUpperCase().replace(/[^0-9A-Z]/g, "");
// Letters and digits only. Woolworths ingredient text has stray spaces
// inside words ("Maltodextri n"), so names are matched with all of them gone.
const squash = (s) => s.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]/g, "");

// Blocks are separated by blank lines; one block is one additive.
const entries = new Map();
for (const block of text.split(/\n\s*\n/)) {
  const lines = block.split("\n").filter((l) => !l.startsWith("#"));
  const en = lines.find((l) => l.startsWith("en:") && !l.startsWith("en:en"));
  if (!en) continue;
  const names = en
    .slice(3)
    .replace(/\\,/g, "\u0000")
    .split(",")
    .map((s) => s.replace(/\u0000/g, ",").trim())
    .filter(Boolean);
  const code = names.find((n) => /^E\d{3,4}[a-z]?(\([ivx]+\))?$/i.test(n));
  if (!code) continue;

  // 3 high, 2 moderate, 1 watch, 0 none, undefined unassessed.
  const prop = (k) => lines.find((l) => l.startsWith(`${k}:en:`))?.split(":en:")[1].trim();
  const efsa = prop("efsa_evaluation_overexposure_risk");
  const risk = Math.max(
    efsa === "en:high" ? 3 : efsa === "en:moderate" ? 2 : efsa === "en:no" ? 0 : -1,
    prop("anses_additives_of_interest") === "yes" ? 1 : -1
  );

  const label = names.find((n) => n !== code) ?? code;
  // Names that can stand alone in an ingredient list. Short ones ("Caramel",
  // "Pectin", formulas like "NaNO2") collide with ordinary words or other
  // additives, so they only ever match by number.
  const aliases = [...new Set(names.filter((n) => n !== code).map(squash))].filter(
    (s) => s.length >= 8 && /[a-z]{6}/.test(s) && !/^e\d/.test(s)
  );
  entries.set(codeKey(code), { code, label, risk, aliases });
}

// Assessments the taxonomy does not record. Yuka names IARC alongside EFSA
// as a source, and the taxonomy carries neither IARC classifications nor
// EFSA's titanium dioxide reversal, so those additives came out too mild.
// The rule: IARC Group 1 or 2A, or EFSA finding an additive no longer safe,
// is high; IARC 2B or an EU warning label is moderate. Never lowers a rating.
const OVERRIDES = [
  // EFSA 2021: "can no longer be considered safe as a food additive"
  // (genotoxicity could not be ruled out); banned in the EU from 2022 by
  // Regulation 2022/63. Still permitted in Australia.
  [3, ["E171"]],
  // IARC Group 2A: ingested nitrate or nitrite under conditions that result
  // in endogenous nitrosation (Monograph 94, 2010). Already high from EFSA;
  // listed so the reason is on record.
  [3, ["E249", "E250", "E251", "E252"]],
  // IARC Group 2B: butylated hydroxyanisole (Monograph 40, 1986).
  [2, ["E320"]],
  // IARC Group 2B: aspartame (Monograph 134, 2023).
  [2, ["E951"]],
  // IARC Group 2B: 4-methylimidazole (Monograph 101, 2013), formed in the
  // ammonia caramels.
  [2, ["E150C", "E150D"]],
  // IARC Group 2B: potassium bromate (Monograph 73, 1999). Not permitted in
  // Australia, but imports turn up.
  [2, ["E924"]],
  // The "Southampton six" azo colours. EU law makes them carry "may have an
  // adverse effect on activity and attention in children" (Regulation
  // 1333/2008, Annex V); Australia permits them with no warning at all.
  [2, ["E102", "E104", "E110", "E122", "E124", "E129"]],
];
for (const [risk, codes] of OVERRIDES) {
  for (const k of codes) {
    const e = entries.get(k);
    if (!e) throw new Error(`override names ${k}, which the taxonomy no longer has`);
    e.risk = Math.max(e.risk, risk);
  }
}

// EFSA mostly rates a group (E450, diphosphates) and not each member
// (E450(iii), tetrasodium diphosphate), while ANSES lists some members by
// themselves. A member takes the stricter of its own rating and its parents'.
// Roman numerals come off first (E160AII -> E160A), then the letter (-> E160).
const parentOf = (k) => {
  // Letter suffixes run a-h, so a trailing I/V/X after a digit or one of
  // those is a numeral.
  const r = k.replace(/(?<=[0-9A-H])(I|II|III|IV|V|VI|VII|VIII|IX|X)$/, "");
  return r !== k ? r : k.replace(/(\d)[A-Z]$/, "$1");
};
const inherited = new Map();
for (const [k, e] of entries) {
  let risk = e.risk;
  for (let p = k, q; (q = parentOf(p)) !== p; p = q) risk = Math.max(risk, entries.get(q)?.risk ?? -1);
  inherited.set(k, risk);
}

// An alias shared by two additives says nothing about which one is meant.
const owners = new Map();
for (const [k, e] of entries) for (const a of e.aliases) owners.set(a, [...(owners.get(a) ?? []), k]);
const aliases = [...owners].filter(([, ks]) => ks.length === 1).map(([a, [k]]) => [a, k]);
aliases.sort((x, y) => y[0].length - x[0].length);

const table = Object.fromEntries(
  [...entries].map(([k, e]) => [k, inherited.get(k) >= 0 ? [e.label, inherited.get(k)] : [e.label]])
);

const counts = Object.values(table).reduce((c, [, r]) => ((c[r ?? "-"] = (c[r ?? "-"] ?? 0) + 1), c), {});

writeFileSync(
  new URL("../src/additives-data.ts", import.meta.url),
  `// GENERATED by scripts/build-additives.mjs - do not edit by hand.
//
// Source: Open Food Facts additives taxonomy, ${repo}@${sha}
// taxonomies/additives.txt. Licensed under the Open Database License (ODbL)
// 1.0: https://opendatacommons.org/licenses/odbl/1-0/
//
// ${entries.size} additives; risk counts ${JSON.stringify(counts)}
// (3 high, 2 moderate, 1 watch, 0 none, - unassessed).

/** Code key (E450III) -> [label, risk?]. Risk: 3 high, 2 moderate, 1 watch, 0 none. */
export const ADDITIVES: Record<string, [string, number?]> = ${JSON.stringify(table)};

/** Squashed English name -> code key, longest first. */
export const ALIASES: [string, string][] = ${JSON.stringify(aliases)};
`
);
console.log(`wrote ${entries.size} additives, ${aliases.length} aliases from ${sha.slice(0, 12)}`, counts);
