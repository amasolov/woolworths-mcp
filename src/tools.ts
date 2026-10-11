// Tool definitions and handlers.

import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { Detail, slimProduct, slimSearchProducts } from "./slim.js";
import { browse, listCategories, resolveSpecials } from "./categories.js";
import { request } from "./woolworths.js";

type Args = Record<string, unknown>;
type Handler = (args: Args) => Promise<unknown>;

const DETAILS: Detail[] = ["summary", "nutrition", "full"];

const detailSchema = (fallback: Detail) => ({
  type: "string",
  enum: DETAILS,
  description: `summary: name, price, unit price, special/promo, health stars. nutrition: adds per-100g nutrition. full: raw API payload (~3-4k tokens per product, avoid). Default: ${fallback}.`,
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

      const data = await request("/apis/ui/Search/products", {
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
    description: "Get one Woolworths product by stockcode, including per-100g nutrition by default.",
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
      const data = await request(`/apis/ui/product/detail/${stockcode}`);
      // The detail endpoint wraps the product in `Product` (confirmed live);
      // fall back to the top level in case that ever changes.
      return { product: d === "full" ? data : slimProduct(data?.Product ?? data, d) };
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
