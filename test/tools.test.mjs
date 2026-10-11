// Tool behaviour against captured Woolworths payloads (test/fixtures), with
// fetch and the browser capture faked. Run with `npm test`.
//
// The fixtures are real responses from an anonymous session, trimmed to the
// fields the code reads. Refresh them when Woolworths changes shape.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { callTool, toolDefinitions } = await import("../dist/tools.js");
const { _resetForTests } = await import("../dist/woolworths.js");

const fixture = (name) => JSON.parse(readFileSync(new URL(`fixtures/${name}.json`, import.meta.url), "utf8"));
const FIXTURES = {
  "/apis/ui/Search/products": fixture("search-milk"),
  "/apis/ui/product/detail/888140": fixture("product-888140"),
  "/apis/ui/browse/category": fixture("browse-fruit-veg-specials"),
  "/apis/ui/PiesCategoriesWithSpecials": fixture("categories"),
};

let requests;
let captures;
// Status to answer the next API calls with, consumed front to back.
let statuses;

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

globalThis.fetch = async (url, init) => {
  const { pathname } = new URL(url);
  requests.push({ path: pathname, body: init.body ? JSON.parse(init.body) : undefined, cookie: init.headers.Cookie });
  const status = statuses.shift() ?? 200;
  if (status !== 200) return json(status, { error: status });
  const body = FIXTURES[pathname];
  return body ? json(200, body) : json(404, {});
};

beforeEach(() => {
  requests = [];
  captures = 0;
  statuses = [];
  _resetForTests(async () => {
    captures++;
    await new Promise((r) => setTimeout(r, 10));
    return { cookieHeader: `capture=${captures}`, userAgent: "test", capturedAt: Date.now() };
  });
});

test("only the catalogue tools are listed by default", () => {
  assert.deepEqual(
    toolDefinitions.map((t) => t.name),
    ["woolworths_search_products", "woolworths_get_product_details", "woolworths_get_specials", "woolworths_get_categories"]
  );
  for (const t of toolDefinitions) assert.equal(t.handler, undefined);
});

test("search returns slim products and drops sponsored ads", async () => {
  const r = await callTool("woolworths_search_products", { searchTerm: "milk", pageSize: 4 });
  assert.equal(r.total, 2421);
  assert.equal(r.hasMore, true);
  assert.deepEqual(r.products.map((p) => p.stockcode), [888140, 888137, 88436, 50923]);
  assert.deepEqual(r.products[0], {
    stockcode: 888140,
    name: "Woolworths Full Cream Milk 3L",
    price: 4.95,
    cup: "$1.65 / 1L",
    hsr: 4,
  });
  assert.ok(JSON.stringify(r).length < 1000, "slim output stays small");
  assert.equal(requests[0].body.pageSize, 4);
});

test("search can keep sponsored ads, flagged", async () => {
  const r = await callTool("woolworths_search_products", { searchTerm: "milk", includeSponsored: true });
  assert.equal(r.products.length, 6);
  assert.equal(r.products.filter((p) => p.sponsored).length, 2);
});

test("search detail=full passes the raw payload through", async () => {
  const r = await callTool("woolworths_search_products", { searchTerm: "milk", detail: "full" });
  assert.ok(r.products[0].AdditionalAttributes);
});

test("search rejects bad arguments before calling Woolworths", async () => {
  await assert.rejects(callTool("woolworths_search_products", {}), /searchTerm/);
  await assert.rejects(callTool("woolworths_search_products", { searchTerm: "x", pageSize: 500 }), /pageSize/);
  await assert.rejects(callTool("woolworths_search_products", { searchTerm: "x", sortType: "Nope" }), /sortType/);
  await assert.rejects(callTool("woolworths_search_products", { searchTerm: "x", detail: "all" }), /detail/);
  assert.equal(requests.length, 0);
});

test("product details unwrap Product and include nutrition", async () => {
  const r = await callTool("woolworths_get_product_details", { stockcode: "888140" });
  assert.equal(r.product.stockcode, 888140);
  assert.equal(r.product.nutrition.protein, "3.3g");
  assert.equal(Object.keys(r.product.nutrition).length >= 7, true);
  await assert.rejects(callTool("woolworths_get_product_details", { stockcode: "../x" }), /numeric/);
});

test("categories: departments and special types, one level at a time", async () => {
  const top = await callTool("woolworths_get_categories", {});
  assert.deepEqual(top.categories.map((c) => c.path), ["fruit-veg", "personal-care"]);
  assert.ok(top.specialTypes.includes("half-price"));
  assert.ok(!top.specialTypes.includes("my-specials-and-offers"), "account-only type is hidden");

  const fv = await callTool("woolworths_get_categories", { parent: "fruit-veg" });
  assert.ok(fv.categories.some((c) => c.path === "fruit-veg/fruit"));
  const byId = await callTool("woolworths_get_categories", { parent: "1-E5BEE36E" });
  assert.deepEqual(byId, fv);

  await assert.rejects(callTool("woolworths_get_categories", { parent: "nope" }), /Unknown category/);
});

test("specials for a department filter that department to specials", async () => {
  const r = await callTool("woolworths_get_specials", { category: "fruit-veg", pageSize: 3 });
  const body = requests.find((q) => q.path === "/apis/ui/browse/category").body;
  assert.equal(body.categoryId, "1-E5BEE36E");
  assert.equal(body.isSpecial, true);
  assert.equal(body.url, "/shop/browse/fruit-veg");
  assert.equal(r.specials, "fruit-veg");
  assert.ok(r.products.length > 0);
  // Multibuys are not IsOnSpecial; their promo text is what carries the deal.
  assert.ok(r.products.some((p) => !p.special && /for \$/.test(p.promo ?? "")));
});

test("specials by type, and by type within a department", async () => {
  await callTool("woolworths_get_specials", {});
  let body = requests.at(-1).body;
  assert.equal(body.url, "/shop/browse/specials/half-price");
  assert.equal(body.isSpecial, false);

  await callTool("woolworths_get_specials", { type: "half-price", category: "personal-care" });
  body = requests.at(-1).body;
  assert.match(body.categoryId, /^specialsgroup\.\d+\.1_894D0A8$/);
  assert.equal(body.url, "/shop/browse/specials/half-price/personal-care");

  await assert.rejects(callTool("woolworths_get_specials", { type: "nope" }), /Available: .*half-price/);
});

test("unknown tools are an error", async () => {
  await assert.rejects(callTool("woolworths_open_browser", {}), /Unknown tool/);
});

// --- session handling --------------------------------------------------------

test("cookies are captured once and shared by concurrent calls", async () => {
  await Promise.all([1, 2, 3].map(() => callTool("woolworths_search_products", { searchTerm: "milk" })));
  assert.equal(captures, 1);
  assert.ok(requests.every((q) => q.cookie === "capture=1"));
});

test("a 403 refreshes the cookies once and retries", async () => {
  await callTool("woolworths_get_product_details", { stockcode: "888140" });
  // Pretend the cookies were captured long enough ago to be refreshable.
  const realNow = Date.now;
  Date.now = () => realNow() + 120_000;
  try {
    statuses = [403];
    const r = await callTool("woolworths_get_product_details", { stockcode: "888140" });
    assert.equal(r.product.stockcode, 888140);
    assert.equal(captures, 2);
    assert.equal(requests.at(-1).cookie, "capture=2");
  } finally {
    Date.now = realNow;
  }
});

test("a 403 right after capturing fails fast instead of relaunching", async () => {
  statuses = [200, 403];
  await callTool("woolworths_get_product_details", { stockcode: "888140" });
  await assert.rejects(callTool("woolworths_get_product_details", { stockcode: "888140" }), /try again in a minute/);
  assert.equal(captures, 1);
});

test("a 401 is reported, not refreshed - it needs an account", async () => {
  statuses = [401];
  await assert.rejects(callTool("woolworths_get_product_details", { stockcode: "888140" }), /401/);
  assert.equal(captures, 1);
});

test("a failed capture is reported, and its reason repeated until a retry is allowed", async () => {
  _resetForTests(async () => {
    captures++;
    throw new Error("Navigation timeout of 45000 ms exceeded");
  });
  await assert.rejects(callTool("woolworths_get_product_details", { stockcode: "888140" }), /Navigation timeout/);
  await assert.rejects(callTool("woolworths_get_product_details", { stockcode: "888140" }), /No working Woolworths session: Navigation timeout.*try again/);
  assert.equal(captures, 1);
});
