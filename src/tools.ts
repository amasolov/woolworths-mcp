// Tool definitions and handlers.

import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { Detail, healthOf, slimProduct, slimSearchProducts, subcategoriesOf } from "./slim.js";
import { Risk, riskRank } from "./additives.js";
import { browse, listCategories, resolveSpecials } from "./categories.js";
import { request } from "./woolworths.js";

type Args = Record<string, unknown>;
type Handler = (args: Args) => Promise<unknown>;

const DETAILS: Detail[] = ["summary", "nutrition", "health", "full"];
const RISKS: Risk[] = ["none", "watch", "moderate", "high"];

const detailSchema = (fallback: Detail) => ({
  type: "string",
  enum: DETAILS,
  description: `summary: name, price, unit price, special/promo, health stars. nutrition: adds per-100g nutrition. health: nutrition plus additive risk from the ingredient list. full: raw API payload (~3-4k tokens per product, avoid). Default: ${fallback}.`,
  default: fallback,
});

function str(args: Args, key: string, fallback?: string): string {
  const v = args[key] ?? fallback;
  if (typeof v !== "string" || v === "") throw new Error(`${key} must be a non-empty string`);
  return v;
}

function int(args: Args, key: string, fallback: number, min = 1, max = 100): number {
  const v = args[key] ?? fallback;
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${key} must be an integer from ${min} to ${max}`);
  }
  return n;
}

function bool(args: Args, key: string, fallback: boolean): boolean {
  const v = args[key] ?? fallback;
  if (typeof v !== "boolean") throw new Error(`${key} must be a boolean`);
  return v;
}

function detail(args: Args, fallback: Detail): Detail {
  const v = args.detail ?? fallback;
  if (!DETAILS.includes(v as Detail)) throw new Error(`detail must be one of ${DETAILS.join(", ")}`);
  return v as Detail;
}

const SORT_TYPES = ["TraderRelevance", "PriceAsc", "PriceDesc", "Name"];

// How long an identical call is answered from memory. Prices and specials
// change at most daily (specials on Wednesdays), and an LLM often repeats a
// call within a conversation; product details - ingredients above all - are
// the most repeated and the slowest to change.
const SEARCH_CACHE_MS = 5 * 60 * 1000;
const DETAIL_CACHE_MS = 30 * 60 * 1000;

// One page of raw search results.
function searchRaw(
  searchTerm: string,
  { pageNumber = 1, pageSize = 10, sortType = "TraderRelevance", isSpecial = false } = {}
): Promise<any> {
  return request("/apis/ui/Search/products", {
    cacheMs: SEARCH_CACHE_MS,
    body: {
      searchTerm,
      pageNumber,
      pageSize,
      sortType,
      location: `/shop/search/products?searchTerm=${encodeURIComponent(searchTerm)}`,
      formatObject: JSON.stringify({ name: searchTerm }),
      isSpecial,
      isBundle: false,
      isMobile: false,
      filters: [],
      groupEdmVariants: false,
    },
  });
}

// --- catalogue -------------------------------------------------------------

const catalogue: Array<Tool & { handler: Handler }> = [
  {
    name: "woolworths_search_products",
    description: "Search Woolworths Australia products by keyword. Returns price, unit price, specials and health star rating.",
    inputSchema: {
      type: "object",
      properties: {
        searchTerm: { type: "string", description: "The product search term" },
        pageNumber: { type: "number", description: "Page number (default: 1)", default: 1 },
        pageSize: { type: "number", description: "Results per page, 1-36 (default: 10)", default: 10 },
        sortType: {
          type: "string",
          enum: SORT_TYPES,
          description: "Sort order (default: TraderRelevance)",
          default: "TraderRelevance",
        },
        isSpecial: { type: "boolean", description: "Specials only (default: false)", default: false },
        includeSponsored: {
          type: "boolean",
          description: "Include sponsored ad products injected into results (default: false)",
          default: false,
        },
        detail: detailSchema("summary"),
      },
      required: ["searchTerm"],
    },
    async handler(args) {
      const searchTerm = str(args, "searchTerm");
      const pageNumber = int(args, "pageNumber", 1, 1, 1000);
      const pageSize = int(args, "pageSize", 10, 1, 36);
      const sortType = str(args, "sortType", "TraderRelevance");
      if (!SORT_TYPES.includes(sortType)) throw new Error(`sortType must be one of ${SORT_TYPES.join(", ")}`);
      const isSpecial = bool(args, "isSpecial", false);
      const includeSponsored = bool(args, "includeSponsored", false);
      const d = detail(args, "summary");

      const data = await searchRaw(searchTerm, { pageNumber, pageSize, sortType, isSpecial });
      const total = data.SearchResultsCount || 0;
      return {
        total,
        page: pageNumber,
        hasMore: pageNumber * pageSize < total,
        products: slimSearchProducts(data.Products || [], d, includeSponsored),
      };
    },
  },
  {
    name: "woolworths_get_product_details",
    description:
      "Get one Woolworths product by stockcode, including per-100g nutrition by default. " +
      "Do not call this for every product in a list: woolworths_search_products with detail nutrition or health, " +
      "or woolworths_find_healthier, already return the same data for a whole page in one call, " +
      "and a burst of calls gets the server rate-limited by Woolworths.",
    inputSchema: {
      type: "object",
      properties: {
        stockcode: { type: "string", description: "The product stockcode" },
        detail: detailSchema("nutrition"),
      },
      required: ["stockcode"],
    },
    async handler(args) {
      const stockcode = String(args.stockcode ?? "");
      if (!/^\d+$/.test(stockcode)) throw new Error("stockcode must be numeric");
      const d = detail(args, "nutrition");
      const data = await request(`/apis/ui/product/detail/${stockcode}`, { cacheMs: DETAIL_CACHE_MS });
      // The detail endpoint wraps the product in `Product` (confirmed live);
      // fall back to the top level in case that ever changes.
      return { product: d === "full" ? data : slimProduct(data?.Product ?? data, d) };
    },
  },
  {
    name: "woolworths_find_healthier",
    description:
      "Find the healthier options for a shopping-list item. Searches Woolworths, rates each product's additives from its ingredient list " +
      "(EFSA overexposure and ANSES assessments, as used by apps like Yuka), drops those above maxRisk, and ranks the rest: " +
      "fewest risky additives, then Health Star Rating, then unit price. Use a plain product name as the term " +
      '("chicken stock", not "500 mL chicken stock, salt-reduced"). Products without an ingredient list come back as risk "unknown"; fresh produce is "none".',
    inputSchema: {
      type: "object",
      properties: {
        searchTerm: { type: "string", description: "The product to look for" },
        maxRisk: {
          type: "string",
          enum: RISKS,
          description:
            "Worst additive risk to keep (default: moderate, i.e. drop only high). high: EFSA found a risk of exceeding the safe intake (nitrites, sulphites, phosphates, carrageenan, MSG...). " +
            "moderate: a lesser EFSA overexposure risk, or one of the azo colours with an EU hyperactivity warning. watch: on the ANSES list of additives of interest.",
          default: "moderate",
        },
        limit: { type: "number", description: "Number of products to return, 1-36 (default: 5)", default: 5 },
        candidates: { type: "number", description: "Number of search results to rate, 1-36 (default: 12)", default: 12 },
        sameShelf: {
          type: "boolean",
          description:
            "Only compare products on the same shelf as the top search results, e.g. bananas with bananas and not banana chips (default: true)",
          default: true,
        },
      },
      required: ["searchTerm"],
    },
    async handler(args) {
      const searchTerm = str(args, "searchTerm");
      const maxRisk = str(args, "maxRisk", "moderate") as Risk;
      if (!RISKS.includes(maxRisk)) throw new Error(`maxRisk must be one of ${RISKS.join(", ")}`);
      const limit = int(args, "limit", 5, 1, 36);
      const candidates = int(args, "candidates", 12, 1, 36);
      const sameShelf = bool(args, "sameShelf", true);

      const data = await searchRaw(searchTerm, { pageSize: candidates });

      // Flatten tiles the way slimSearchProducts does, but keep the raw
      // product: ranking needs CupPrice, which the slim form only has as text.
      const seen = new Set<number>();
      const rated: { p: any; health: ReturnType<typeof healthOf> }[] = [];
      for (const tile of data.Products ?? []) {
        for (const p of tile?.Products ?? [tile]) {
          if (!p || seen.has(p.Stockcode) || p.IsSponsoredAd) continue;
          seen.add(p.Stockcode);
          rated.push({ p, health: healthOf(p) });
        }
      }

      // Compare like with like, as Yuka does. Search for "bananas" also finds
      // banana chips, banana yoghurt and banana prawns; ranked on additives
      // alone, the prawns would compete with the fruit. The shelf is whichever
      // subcategory the most relevant few results share most.
      let shelf: string[] = [];
      if (sameShelf) {
        const votes = new Map<string, number>();
        for (const r of rated.slice(0, 3)) for (const c of subcategoriesOf(r.p)) votes.set(c, (votes.get(c) ?? 0) + 1);
        const top = Math.max(0, ...votes.values());
        shelf = [...votes].filter(([, n]) => n === top).map(([c]) => c);
      }
      const comparable = shelf.length ? rated.filter((r) => subcategoriesOf(r.p).some((c) => shelf.includes(c))) : rated;

      const kept = comparable.filter((r) => riskRank(r.health.risk) <= riskRank(maxRisk));
      const excluded = comparable.filter((r) => riskRank(r.health.risk) > riskRank(maxRisk));

      // Rated-and-passing before unknown (no ingredient list: fresh food, or
      // Woolworths simply lacks the data). Within each: lower risk, more health
      // stars (none counts as 0), cheaper per unit when units match.
      const hsr = (p: any) => parseFloat(p.AdditionalAttributes?.healthstarrating) || 0;
      const unit = (p: any) => (typeof p.CupPrice === "number" && p.CupPrice > 0 ? p.CupPrice : Infinity);
      // How many additives sit at the worst level found - so among the
      // excluded, one nitrite beats nitrite plus three phosphates.
      const worstCount = (h: ReturnType<typeof healthOf>) => h.flagged?.filter((f) => f.endsWith(`: ${h.risk}`)).length ?? 0;
      const byHealth = (a: (typeof rated)[0], b: (typeof rated)[0]) =>
        Number(a.health.risk === "unknown") - Number(b.health.risk === "unknown") ||
        riskRank(a.health.risk) - riskRank(b.health.risk) ||
        worstCount(a.health) - worstCount(b.health) ||
        hsr(b.p) - hsr(a.p) ||
        (a.p.CupMeasure === b.p.CupMeasure ? unit(a.p) - unit(b.p) : 0);
      kept.sort(byHealth);
      excluded.sort(byHealth);

      // Everything was over the line - cured meats nearly always are (nitrite,
      // phosphates). Offer the least bad rather than nothing; the caller can
      // also retry with a narrower term ("nitrite free ham").
      const leastBad = kept.length === 0 ? excluded.slice(0, Math.min(limit, 3)) : [];
      const dropped = excluded.slice(leastBad.length);

      return {
        rated: comparable.length,
        ...(shelf.length ? { shelf } : {}),
        products: kept.slice(0, limit).map((r) => slimProduct(r.p, "health")),
        ...(leastBad.length ? { leastBad: leastBad.map((r) => slimProduct(r.p, "health")) } : {}),
        // Why the rest were dropped, so the caller can say so.
        excluded: dropped.slice(0, 10).map((r) => ({ name: r.p.DisplayName ?? r.p.Name, flagged: r.health.flagged })),
        ...(dropped.length > 10 ? { excludedMore: dropped.length - 10 } : {}),
      };
    },
  },
  {
    name: "woolworths_get_specials",
    description:
      "Get current Woolworths specials. Pick a special type (e.g. half-price), a department (e.g. fruit-veg), or both. With neither, returns half-price specials.",
    inputSchema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          description:
            "Special type, e.g. half-price, lower-shelf-price, buy-more-save-more, everyday-low-price, seasonal-price. woolworths_get_categories lists them as specialTypes.",
        },
        category: {
          type: "string",
          description: "Department id or path from woolworths_get_categories, e.g. fruit-veg",
        },
        pageNumber: { type: "number", description: "Page number (default: 1)", default: 1 },
        pageSize: { type: "number", description: "Results per page, 1-36 (default: 20)", default: 20 },
        detail: detailSchema("summary"),
      },
    },
    async handler(args) {
      const type = args.type === undefined ? undefined : str(args, "type");
      const category = args.category === undefined ? undefined : str(args, "category");
      const pageNumber = int(args, "pageNumber", 1, 1, 1000);
      const pageSize = int(args, "pageSize", 20, 1, 36);
      const d = detail(args, "summary");
      const { node, specialsOnly } = await resolveSpecials(type, category);
      const data = await browse(node, { specialsOnly, pageNumber, pageSize });
      const total = data.TotalRecordCount || 0;
      return {
        specials: node.path,
        total,
        page: pageNumber,
        hasMore: pageNumber * pageSize < total,
        products: slimSearchProducts(data.Bundles || data.Products || [], d, false),
      };
    },
  },
  {
    name: "woolworths_get_categories",
    description:
      "List Woolworths categories one level at a time: the departments (and the special types) with no parent, or the children of a category id or path.",
    inputSchema: {
      type: "object",
      properties: {
        parent: { type: "string", description: "Category id or path, e.g. fruit-veg or fruit-veg/fruit. Omit for departments." },
      },
    },
    async handler(args) {
      return listCategories(args.parent === undefined ? undefined : str(args, "parent"));
    },
  },
];

// --- cart --------------------------------------------------------------------
//
// Off unless WOOLWORTHS_ENABLE_CART=true. The session is the anonymous one the
// server captures itself, so these fill a trolley no person can see - while
// telling the caller it worked. They also change state. Kept for whoever wires
// up a logged-in session.

async function updateTrolley(stockcode: number, quantity: number) {
  return request("/api/v3/ui/trolley/update", {
    body: {
      items: [
        {
          stockcode,
          quantity,
          source: "ProductDetail",
          diagnostics: "0",
          searchTerm: null,
          evaluateRewardPoints: false,
          offerId: null,
          profileId: null,
          priceLevel: null,
        },
      ],
    },
  });
}

const stockcodeSchema = { type: "number", description: "The product stockcode" };

const cart: Array<Tool & { handler: Handler }> = [
  {
    name: "woolworths_add_to_cart",
    description: "Add a product to the shopping trolley",
    inputSchema: {
      type: "object",
      properties: {
        stockcode: stockcodeSchema,
        quantity: { type: "number", description: "Quantity to add (default: 1)", default: 1 },
      },
      required: ["stockcode"],
    },
    handler: async (args) => ({ cart: await updateTrolley(int(args, "stockcode", 0, 1, Number.MAX_SAFE_INTEGER), int(args, "quantity", 1, 1, 99)) }),
  },
  {
    name: "woolworths_get_cart",
    description: "Get the contents of the shopping trolley",
    inputSchema: { type: "object", properties: {} },
    handler: async () => ({ cart: await request("/apis/ui/Trolley") }),
  },
  {
    name: "woolworths_remove_from_cart",
    description: "Remove a product from the shopping trolley",
    inputSchema: { type: "object", properties: { stockcode: stockcodeSchema }, required: ["stockcode"] },
    handler: async (args) => ({ cart: await updateTrolley(int(args, "stockcode", 0, 1, Number.MAX_SAFE_INTEGER), 0) }),
  },
  {
    name: "woolworths_update_cart_quantity",
    description: "Set the quantity of a product in the shopping trolley",
    inputSchema: {
      type: "object",
      properties: { stockcode: stockcodeSchema, quantity: { type: "number", description: "New quantity" } },
      required: ["stockcode", "quantity"],
    },
    handler: async (args) => ({ cart: await updateTrolley(int(args, "stockcode", 0, 1, Number.MAX_SAFE_INTEGER), int(args, "quantity", 0, 0, 99)) }),
  },
];

export const TOOLS = process.env.WOOLWORTHS_ENABLE_CART === "true" ? [...catalogue, ...cart] : catalogue;

const handlers = new Map(TOOLS.map((t) => [t.name, t.handler]));

/** Run a tool. Throws on unknown tools, bad arguments and API failures. */
export async function callTool(name: string, args: Args): Promise<unknown> {
  const handler = handlers.get(name);
  if (!handler) throw new Error(`Unknown tool: ${name}`);
  return handler(args);
}

/** Tool definitions without the handlers, for tools/list. */
export const toolDefinitions: Tool[] = TOOLS.map(({ handler: _, ...tool }) => tool);
