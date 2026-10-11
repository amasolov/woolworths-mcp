#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import puppeteer, { Browser, Page } from "puppeteer";
import fetch from "node-fetch";
import { Detail, healthOf, slimProduct, slimSearchProducts, subcategoriesOf } from "./slim.js";
import { Risk, riskRank } from "./additives.js";

// Cookie storage
let sessionCookies: any[] = [];
let browser: Browser | null = null;
let currentPage: Page | null = null;

// Tool definitions
const TOOLS: Tool[] = [
  {
    name: "woolworths_open_browser",
    description:
      "Opens a browser and navigates to Woolworths website. This is the first step to establish a session.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "woolworths_navigate",
    description: "Navigate to a specific URL on the Woolworths website",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The URL to navigate to",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "woolworths_get_cookies",
    description:
      "Retrieves session cookies from the current browser session. Run this after logging in or establishing a session.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "woolworths_close_browser",
    description: "Closes the browser instance",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "woolworths_search_products",
    description:
      "Search for products on Woolworths. Requires session cookies to be obtained first.",
    inputSchema: {
      type: "object",
      properties: {
        searchTerm: {
          type: "string",
          description: "The product search term",
        },
        pageNumber: {
          type: "number",
          description: "Page number for pagination (default: 1)",
          default: 1,
        },
        pageSize: {
          type: "number",
          description: "Number of results to return (default: 10)",
          default: 10,
        },
        sortType: {
          type: "string",
          description: "Sort order: TraderRelevance, PriceAsc, PriceDesc, Name (default: TraderRelevance)",
          enum: ["TraderRelevance", "PriceAsc", "PriceDesc", "Name"],
          default: "TraderRelevance",
        },
        isSpecial: {
          type: "boolean",
          description: "Filter for special offers only (default: false)",
          default: false,
        },
        includeSponsored: {
          type: "boolean",
          description: "Include sponsored ad products injected into results (default: false)",
          default: false,
        },
        detail: {
          type: "string",
          enum: ["summary", "nutrition", "health", "full"],
          description:
            "summary (default): name, price, unit price, special/promo, health stars. nutrition: adds per-100g nutrition. health: nutrition plus additive risk from the ingredient list. full: raw API payload (~3-4k tokens per product, avoid).",
          default: "summary",
        },
      },
      required: ["searchTerm"],
    },
  },
  {
    name: "woolworths_get_product_details",
    description:
      "Get detailed information about a specific product by its stockcode",
    inputSchema: {
      type: "object",
      properties: {
        stockcode: {
          type: "string",
          description: "The product stockcode/ID",
        },
        detail: {
          type: "string",
          enum: ["summary", "nutrition", "health", "full"],
          description:
            "summary: name, price, unit price, special/promo, health stars. nutrition (default): adds per-100g nutrition. health: nutrition plus additive risk from the ingredient list. full: raw API payload (~3-4k tokens per product, avoid).",
          default: "nutrition",
        },
      },
      required: ["stockcode"],
    },
  },
  {
    name: "woolworths_find_healthier",
    description:
      "Find the healthier options for a shopping-list item. Searches Woolworths, rates each product's additives from its ingredient list " +
      "(EFSA, IARC and ANSES assessments), drops those above maxRisk, and ranks the rest by a Yuka-style 0-100 score " +
      "(60% Nutri-Score, 30% additives, 10% organic; any high-risk additive caps it at 49), then unit price. Use a plain product name as the term " +
      '("chicken stock", not "500 mL chicken stock, salt-reduced"). Fresh produce has no ingredient list and comes back as risk "unknown". ' +
      "Requires session cookies to be obtained first.",
    inputSchema: {
      type: "object",
      properties: {
        searchTerm: {
          type: "string",
          description: "The product to look for",
        },
        maxRisk: {
          type: "string",
          enum: ["none", "watch", "moderate", "high"],
          description:
            "Worst additive risk to keep (default: moderate, i.e. drop only high). high: EFSA found a risk of exceeding the safe intake (nitrites, sulphites, phosphates, carrageenan, MSG...). " +
            "moderate: a lesser EFSA overexposure risk, or one of the azo colours with an EU hyperactivity warning. watch: on the ANSES list of additives of interest.",
          default: "moderate",
        },
        limit: {
          type: "number",
          description: "Number of products to return (default: 5)",
          default: 5,
        },
        candidates: {
          type: "number",
          description: "Number of search results to rate (default: 24, max: 36)",
          default: 24,
        },
        sameShelf: {
          type: "boolean",
          description:
            "Only compare products on the same shelf as the top search results, e.g. bananas with bananas and not banana chips (default: true)",
          default: true,
        },
      },
      required: ["searchTerm"],
    },
  },
  {
    name: "woolworths_get_specials",
    description: "Get current specials and deals from Woolworths",
    inputSchema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          description: "Optional category filter (e.g., 'fruit-veg', 'meat-seafood')",
        },
        pageSize: {
          type: "number",
          description: "Number of results to return (default: 20)",
          default: 20,
        },
        detail: {
          type: "string",
          enum: ["summary", "nutrition", "health", "full"],
          description:
            "summary (default): name, price, unit price, special/promo, health stars. nutrition: adds per-100g nutrition. health: nutrition plus additive risk from the ingredient list. full: raw API payload (~3-4k tokens per product, avoid).",
          default: "summary",
        },
      },
    },
  },
  {
    name: "woolworths_get_categories",
    description: "Get the list of available product categories",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "woolworths_add_to_cart",
    description: "Add a product to the shopping cart/trolley",
    inputSchema: {
      type: "object",
      properties: {
        stockcode: {
          type: "number",
          description: "The product stockcode/ID to add",
        },
        quantity: {
          type: "number",
          description: "Quantity to add (default: 1)",
          default: 1,
        },
      },
      required: ["stockcode"],
    },
  },
  {
    name: "woolworths_get_cart",
    description: "Get the contents of the shopping cart/trolley",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "woolworths_remove_from_cart",
    description: "Remove a product from the shopping cart/trolley",
    inputSchema: {
      type: "object",
      properties: {
        stockcode: {
          type: "number",
          description: "The product stockcode/ID to remove",
        },
      },
      required: ["stockcode"],
    },
  },
  {
    name: "woolworths_update_cart_quantity",
    description: "Update the quantity of a product in the shopping cart/trolley",
    inputSchema: {
      type: "object",
      properties: {
        stockcode: {
          type: "number",
          description: "The product stockcode/ID",
        },
        quantity: {
          type: "number",
          description: "New quantity",
        },
      },
      required: ["stockcode", "quantity"],
    },
  },
];

// Helper function to get cookie header string
function getCookieHeader(): string {
  return sessionCookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

// Helper function to make API requests with cookies
async function makeWoolworthsRequest(
  url: string,
  options: any = {}
): Promise<any> {
  if (sessionCookies.length === 0) {
    throw new Error(
      "No session cookies available. Please use woolworths_get_cookies first."
    );
  }

  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Accept: "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    Origin: "https://www.woolworths.com.au",
    Referer: "https://www.woolworths.com.au/",
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    Priority: "u=1, i",
    Cookie: getCookieHeader(),
    ...options.headers,
  };

  const response = await fetch(url, {
    ...options,
    headers,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `API request failed: ${response.status} ${response.statusText}. ${errorText}`
    );
  }

  return response.json();
}

// Tool handlers
async function handleOpenBrowser(args: any): Promise<any> {
  if (browser) {
    return {
      success: false,
      message: "Browser is already open. Close it first with woolworths_close_browser.",
    };
  }

  // Headless unless WOOLWORTHS_HEADLESS=false. Not a tool argument: a server
  // with no display dies with "Missing X server" on a visible launch, and the
  // caller (an LLM) cannot know whether there is one. Set it to false on a
  // desktop to log in by hand.
  const headless = process.env.WOOLWORTHS_HEADLESS !== "false";

  browser = await puppeteer.launch({
    headless,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
    ],
    defaultViewport: { width: 1280, height: 800 },
  });

  currentPage = await browser.newPage();

  // Set user agent to appear more like a real browser
  await currentPage.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  );

  // Navigate to Woolworths homepage
  await currentPage.goto("https://www.woolworths.com.au", {
    waitUntil: "networkidle2",
  });

  return {
    success: true,
    message:
      "Browser opened and navigated to Woolworths homepage. You can now log in manually if needed, then use woolworths_get_cookies to capture the session.",
    url: currentPage.url(),
  };
}

async function handleNavigate(args: any): Promise<any> {
  if (!browser || !currentPage) {
    throw new Error("Browser is not open. Use woolworths_open_browser first.");
  }

  await currentPage.goto(args.url, { waitUntil: "networkidle2" });

  return {
    success: true,
    url: currentPage.url(),
    title: await currentPage.title(),
  };
}

async function handleGetCookies(args: any): Promise<any> {
  if (!browser || !currentPage) {
    throw new Error("Browser is not open. Use woolworths_open_browser first.");
  }

  const cookies = await currentPage.cookies();
  sessionCookies = cookies;

  return {
    success: true,
    message: `Captured ${cookies.length} cookies from the current session.`,
    cookies: cookies.map((c) => ({
      name: c.name,
      domain: c.domain,
      path: c.path,
      secure: c.secure,
      httpOnly: c.httpOnly,
    })),
  };
}

async function handleCloseBrowser(args: any): Promise<any> {
  if (!browser) {
    return {
      success: false,
      message: "Browser is not open.",
    };
  }

  await browser.close();
  browser = null;
  currentPage = null;

  return {
    success: true,
    message: "Browser closed. Session cookies have been preserved.",
  };
}

// One page of raw search results.
async function searchRaw(
  searchTerm: string,
  { pageNumber = 1, pageSize = 10, sortType = "TraderRelevance", isSpecial = false } = {}
): Promise<any> {
  // Woolworths search API endpoint (POST method)
  const url = `https://www.woolworths.com.au/apis/ui/Search/products`;

  const requestBody = {
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
  };

  return makeWoolworthsRequest(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
  });
}

async function handleSearchProducts(args: any): Promise<any> {
  const pageNumber = args.pageNumber ?? 1;
  const pageSize = args.pageSize ?? 10;
  const detail: Detail = args.detail ?? "summary";
  const includeSponsored = args.includeSponsored ?? false;

  try {
    const data = await searchRaw(args.searchTerm, {
      pageNumber,
      pageSize,
      sortType: args.sortType ?? "TraderRelevance",
      isSpecial: args.isSpecial ?? false,
    });

    const total = data.SearchResultsCount || 0;
    return {
      success: true,
      total,
      page: pageNumber,
      hasMore: pageNumber * pageSize < total,
      products: slimSearchProducts(data.Products || [], detail, includeSponsored),
    };
  } catch (error: any) {
    return {
      success: false,
      error: error.message,
    };
  }
}

async function handleFindHealthier(args: any): Promise<any> {
  const maxRisk: Risk = args.maxRisk ?? "moderate";
  const limit = Math.max(1, args.limit ?? 5);
  const candidates = Math.min(36, Math.max(1, args.candidates ?? 24));

  try {
    const data = await searchRaw(args.searchTerm, { pageSize: candidates });

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
    if (args.sameShelf ?? true) {
      const votes = new Map<string, number>();
      for (const r of rated.slice(0, 3)) for (const c of subcategoriesOf(r.p)) votes.set(c, (votes.get(c) ?? 0) + 1);
      const top = Math.max(0, ...votes.values());
      shelf = [...votes].filter(([, n]) => n === top).map(([c]) => c);
    }
    const comparable = shelf.length
      ? rated.filter((r) => subcategoriesOf(r.p).some((c) => shelf.includes(c)))
      : rated;

    const kept = comparable.filter((r) => riskRank(r.health.risk) <= riskRank(maxRisk));
    const excluded = comparable.filter((r) => riskRank(r.health.risk) > riskRank(maxRisk));

    const hsr = (p: any) => parseFloat(p.AdditionalAttributes?.healthstarrating) || 0;
    const unit = (p: any) => (typeof p.CupPrice === "number" && p.CupPrice > 0 ? p.CupPrice : Infinity);
    // How many additives sit at the worst level found - so among the
    // excluded, one nitrite beats nitrite plus three phosphates.
    const worstCount = (h: ReturnType<typeof healthOf>) =>
      h.flagged?.filter((f) => f.endsWith(`: ${h.risk}`)).length ?? 0;
    // The Yuka-style score leads. Fresh produce without a nutrition panel
    // has nothing to score but nothing added either; it goes first. Without
    // a score, fall back to risk, then health stars, then unit price.
    const score = (h: ReturnType<typeof healthOf>) => h.score ?? (h.produce ? 101 : -1);
    const byHealth = (a: (typeof rated)[0], b: (typeof rated)[0]) =>
      score(b.health) - score(a.health) ||
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
      success: true,
      rated: comparable.length,
      ...(shelf.length ? { shelf } : {}),
      products: kept.slice(0, limit).map((r) => slimProduct(r.p, "health")),
      ...(leastBad.length ? { leastBad: leastBad.map((r) => slimProduct(r.p, "health")) } : {}),
      // Why the rest were dropped, so the caller can say so.
      excluded: dropped.slice(0, 10).map((r) => ({
        name: r.p.DisplayName ?? r.p.Name,
        flagged: r.health.flagged,
      })),
      ...(dropped.length > 10 ? { excludedMore: dropped.length - 10 } : {}),
    };
  } catch (error: any) {
    return {
      success: false,
      error: error.message,
    };
  }
}

async function handleGetProductDetails(args: any): Promise<any> {
  const stockcode = args.stockcode;

  const url = `https://www.woolworths.com.au/apis/ui/product/detail/${stockcode}`;

  try {
    const data = await makeWoolworthsRequest(url);
    const detail: Detail = args.detail ?? "nutrition";
    // Detail endpoint wraps the product; fall back to the raw object if not.
    const product = data?.Product ?? data;
    return {
      success: true,
      product: detail === "full" ? data : slimProduct(product, detail),
    };
  } catch (error: any) {
    return {
      success: false,
      error: error.message,
    };
  }
}

async function handleGetSpecials(args: any): Promise<any> {
  const category = args.category || "";
  const pageSize = args.pageSize ?? 20;

  let url = `https://www.woolworths.com.au/apis/ui/browse/category`;

  if (category) {
    url += `?category=${encodeURIComponent(category)}&filter=Specials&pageSize=${pageSize}`;
  } else {
    url += `?category=specials&pageSize=${pageSize}`;
  }

  try {
    const data = await makeWoolworthsRequest(url);
    return {
      success: true,
      category: category || "all",
      totalResults: data.TotalRecordCount || 0,
      products: slimSearchProducts(
        data.Products || data.Bundles || [],
        args.detail ?? "summary",
        false
      ),
    };
  } catch (error: any) {
    return {
      success: false,
      error: error.message,
    };
  }
}

async function handleGetCategories(args: any): Promise<any> {
  const url = `https://www.woolworths.com.au/apis/ui/PiesCategoriesWithSpecials`;

  try {
    const data = await makeWoolworthsRequest(url);
    return {
      success: true,
      categories: data,
    };
  } catch (error: any) {
    return {
      success: false,
      error: error.message,
    };
  }
}

async function handleAddToCart(args: any): Promise<any> {
  const stockcode = args.stockcode;
  const quantity = args.quantity ?? 1;

  const url = `https://www.woolworths.com.au/api/v3/ui/trolley/update`;

  try {
    const data = await makeWoolworthsRequest(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
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
      }),
    });
    return {
      success: true,
      cart: data,
    };
  } catch (error: any) {
    return {
      success: false,
      error: error.message,
    };
  }
}

async function handleGetCart(args: any): Promise<any> {
  const url = `https://www.woolworths.com.au/apis/ui/Trolley`;

  try {
    const data = await makeWoolworthsRequest(url);
    return {
      success: true,
      cart: data,
    };
  } catch (error: any) {
    return {
      success: false,
      error: error.message,
    };
  }
}

async function handleRemoveFromCart(args: any): Promise<any> {
  const stockcode = args.stockcode;

  const url = `https://www.woolworths.com.au/api/v3/ui/trolley/update`;

  try {
    const data = await makeWoolworthsRequest(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        items: [
          {
            stockcode,
            quantity: 0,
            source: "ProductDetail",
            diagnostics: "0",
            searchTerm: null,
            evaluateRewardPoints: false,
            offerId: null,
            profileId: null,
            priceLevel: null,
          },
        ],
      }),
    });
    return {
      success: true,
      cart: data,
    };
  } catch (error: any) {
    return {
      success: false,
      error: error.message,
    };
  }
}

async function handleUpdateCartQuantity(args: any): Promise<any> {
  const stockcode = args.stockcode;
  const quantity = args.quantity;

  const url = `https://www.woolworths.com.au/api/v3/ui/trolley/update`;

  try {
    const data = await makeWoolworthsRequest(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
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
      }),
    });
    return {
      success: true,
      cart: data,
    };
  } catch (error: any) {
    return {
      success: false,
      error: error.message,
    };
  }
}

// Main server setup
async function main() {
  const server = new Server(
    {
      name: "woolworths-mcp-server",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // List available tools
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      let result;

      switch (name) {
        case "woolworths_open_browser":
          result = await handleOpenBrowser(args || {});
          break;

        case "woolworths_navigate":
          result = await handleNavigate(args || {});
          break;

        case "woolworths_get_cookies":
          result = await handleGetCookies(args || {});
          break;

        case "woolworths_close_browser":
          result = await handleCloseBrowser(args || {});
          break;

        case "woolworths_search_products":
          result = await handleSearchProducts(args || {});
          break;

        case "woolworths_get_product_details":
          result = await handleGetProductDetails(args || {});
          break;

        case "woolworths_find_healthier":
          result = await handleFindHealthier(args || {});
          break;

        case "woolworths_get_specials":
          result = await handleGetSpecials(args || {});
          break;

        case "woolworths_get_categories":
          result = await handleGetCategories(args || {});
          break;

        case "woolworths_add_to_cart":
          result = await handleAddToCart(args || {});
          break;

        case "woolworths_get_cart":
          result = await handleGetCart(args || {});
          break;

        case "woolworths_remove_from_cart":
          result = await handleRemoveFromCart(args || {});
          break;

        case "woolworths_update_cart_quantity":
          result = await handleUpdateCartQuantity(args || {});
          break;

        default:
          throw new Error(`Unknown tool: ${name}`);
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result),
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: false,
                error: error.message,
              },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }
  });

  // Cleanup on exit
  process.on("SIGINT", async () => {
    if (browser) {
      await browser.close();
    }
    process.exit(0);
  });

  // Start the server
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("Woolworths MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

