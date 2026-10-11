# Woolworths MCP Server

A Model Context Protocol (MCP) server for Woolworths Australia: product search, prices, unit prices, specials, nutrition, additive risk and categories.

This continues [elijah-g/Woolworths-mcp](https://github.com/elijah-g/Woolworths-mcp), keeping its history. Releases are tagged `vX.Y.Z`.

<a href="https://glama.ai/mcp/servers/@elijah-g/Woolworths-mcp">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/@elijah-g/Woolworths-mcp/badge" alt="Woolworths Server MCP server" />
</a>

## How it works

Woolworths' web APIs sit behind Akamai Bot Manager. A request needs the cookies a real browser earns on the homepage, and those cookies are tied to the client that earned them. So the server calls the API from a real browser:

- **Opening the browser.** The first tool call launches headless Chromium (through Puppeteer) with two tabs. One loads the homepage, where Akamai's script runs and keeps the cookies current. The other sits on the Woolworths origin and makes the API calls with the browser's own `fetch()`, as the website does. This takes about 1–3s and uses roughly 250 MB.
- **Keeping it open.** The browser stays open while calls come in and closes after 10 minutes without one.
- **When Woolworths refuses a call.** On a 403, or its bot-check page (HTTP 200 with HTML instead of JSON), the homepage tab reloads once and the call is retried. If the refusal persists, the call fails with a "rate-limited, retry later" error, and the server makes no calls to Woolworths for a minute rather than prolonging the block. A 401 is reported as-is: the endpoint wants a logged-in account.

To stay well under the bot protection's thresholds, the server keeps its own traffic low:

- **Pacing.** At most two calls at once, with their starts at least 250 ms apart.
- **Caching identical calls.** Searches and specials for 5 minutes, product details for 30.
- **Remembering products.** Every product a search or specials page returns is kept for 30 minutes. A search result carries price, specials, nutrition and ingredients, so `woolworths_get_product_details` for those products needs no request at all.

The session is anonymous. It is enough for the catalogue, but not tied to anyone's Woolworths account.

## Running it

```bash
npm ci
npm run build
```

### stdio (desktop clients)

```json
{
  "mcpServers": {
    "woolworths": {
      "command": "node",
      "args": ["/path/to/woolworths-mcp/dist/index.js"]
    }
  }
}
```

### Streamable HTTP

```bash
MCP_TRANSPORT=http PORT=8000 node dist/index.js
```

MCP is served at `POST /mcp` and a health check at `GET /healthz`. The server is stateless: no `mcp-session-id` is issued and each request stands alone. Nothing needs to survive between requests except the cookies, and those are per process, so a restart cannot leave a client holding a session id the server no longer knows.

There is no authentication. Put it behind something that has some.

### Environment

| Variable | Default | |
| --- | --- | --- |
| `MCP_TRANSPORT` | `stdio` | `stdio` or `http` |
| `PORT` | `8000` | HTTP port |
| `WOOLWORTHS_HEADLESS` | `true` | `false` shows the browser while it collects cookies |
| `WOOLWORTHS_ENABLE_CART` | `false` | `true` adds the cart tools (see below) |
| `PUPPETEER_EXECUTABLE_PATH` | Puppeteer's Chrome | use a system Chromium instead |

## Tools

### woolworths_search_products

- `searchTerm` (string, required)
- `pageNumber` (default 1), `pageSize` (1-36, default 10)
- `sortType`: `TraderRelevance` (default), `PriceAsc`, `PriceDesc`, `Name`
- `isSpecial`: specials only (default false)
- `includeSponsored`: keep the sponsored ads Woolworths injects into results (default false)
- `detail`: see [Response detail](#response-detail) (default `summary`)

### woolworths_get_product_details

- `stockcode` (string): one product, or
- `stockcodes` (string array, up to 20): several in one call. Failures are reported per product.
- `detail` (default `nutrition`)

Products from a search or specials page in the last 30 minutes are answered from memory. `full` always asks Woolworths, because a search result is not the detail endpoint's payload.

### woolworths_find_healthier

Find the healthier options for a shopping-list item: search, rate every result's additives, drop those above `maxRisk`, and rank the rest. See [Additive risk](#additive-risk).

**Parameters:**
- `searchTerm` (string, required): a plain product name - "chicken stock", not "500 mL chicken stock, salt-reduced"
- `maxRisk` (string, optional): `none`, `watch`, `moderate` or `high` - the worst additive risk to keep (default: `moderate`, i.e. drop only `high`)
- `limit` (number, optional): products to return (default: 5)
- `candidates` (number, optional): search results to rate (default: 12, max: 36)
- `sameShelf` (boolean, optional): compare only products on the same shelf as the top results (default: true)

Returns `products` (slim, at `health` detail), `shelf`, and `excluded` - what was dropped and why. When nothing passes (cured meats, nearly always nitrite and phosphates), `leastBad` holds the closest.

```json
{"rated":24,"shelf":["Stock & Gravy"],
 "products":[{"stockcode":34559,"name":"Campbell's Real Stock Chicken 500mL","price":2.75,"cup":"$0.55 / 100ML","hsr":3,"health":{"risk":"none","additives":1}}],
 "excluded":[{"name":"OXO Chicken Stock Cubes 71g","flagged":["E621 Monosodium glutamate: high","E150c Ammonia caramel: moderate"]}]}
```

### woolworths_get_specials

- `type`: a special type such as `half-price`, `lower-shelf-price`, `buy-more-save-more`, `everyday-low-price` or `seasonal-price`. `woolworths_get_categories` lists the current ones as `specialTypes`.
- `category`: a department id or path, e.g. `fruit-veg`
- `pageNumber`, `pageSize` (1-36, default 20), `detail`

With `type` only you get that kind of special, and with `category` only you get that department's specials. Both together give one kind of special within one department, and neither gives `half-price`.

### woolworths_get_categories

- `parent`: a category id or path. Omit it for the departments.

Returns one level of the category tree, along with the special types. The full tree is about 2,600 nodes (870 KB), so the server caches it for 6 hours and never returns all of it.

### Cart tools (off by default)

`woolworths_add_to_cart`, `woolworths_get_cart`, `woolworths_remove_from_cart` and `woolworths_update_cart_quantity` exist only with `WOOLWORTHS_ENABLE_CART=true`. They change state, and with the anonymous session they fill a trolley nobody can see.

## Response detail

The raw Woolworths payload is about 11 KB (3-4k tokens) per product, so the product tools return a slim shape instead:

```json
{"stockcode":888140,"name":"Woolworths Full Cream Milk 3L","price":4.95,"cup":"$1.65 / 1L","hsr":4}
```

Fields at their default are left out:
- `special`, `was` and `save` appear only on a special.
- `promo` appears only when there is promotion text. Multibuys ("2 for $4.50") and lower-shelf-price deals are not flagged `special`, so `promo` is where they show up.
- `hsr` appears only for products with a health star rating.
- `unavailable` and `sponsored` appear only when true.

- `summary`: the fields above.
- `nutrition`: adds `nutrition`, eight per-100g values (energyKj, protein, fat, satFat, carbs, sugars, fibre, sodium).
- `health`: `nutrition`, plus `health` - the additive risk from the ingredient list (see [Additive risk](#additive-risk)).
- `full`: the raw API payload, unchanged. For debugging.

Errors come back as an MCP error result (`isError: true`) with `{"error": "..."}`.

## Additive risk

The `health` detail and `woolworths_find_healthier` rate a product the way apps like Yuka do: by its worst additive.

```json
"health":{"risk":"high","flagged":["E451 Triphosphates: high","E250 Sodium nitrite: high"],"additives":4}
```

- `risk`: the worst level found. `unknown` when Woolworths has no ingredient list for the product. Fresh fruit and vegetables have none either, and are `none` with `produce: true`.
- `flagged`: rated additives, worst first.
- `additives`: every additive recognised, rated or not.

Levels:

| Level | Meaning | Examples |
| --- | --- | --- |
| `high` | EFSA found a high risk of some consumers exceeding the safe intake | nitrites, sulphites, benzoates, sorbates, phosphates, carrageenan, MSG |
| `moderate` | A lesser EFSA overexposure risk, or one of the six azo colours that carry an EU hyperactivity warning | ammonia caramel (150c), tartrazine (102), sunset yellow (110) |
| `watch` | On the ANSES (France) 2019 list of additives of interest | acesulfame K, sucralose, 472e |
| `none` | Assessed, no concern; or nothing rated was found | |

Additives are found by number - Australian labels write "Emulsifier (471)", "Mineral Salts (450, 451)" - and by name ("Sodium Nitrite"). Numbers are INS codes, the same as EU E-numbers.

The ratings are a table generated from the [Open Food Facts additives taxonomy](https://github.com/openfoodfacts/openfoodfacts-server/blob/main/taxonomies/additives.txt) (ODbL), which records the EFSA and ANSES assessments. Yuka's own grading has no public source. To refresh it:

```bash
npm run build:additives
```

This is a filter over published assessments, not dietary advice: an EFSA overexposure risk means some consumers may exceed the acceptable daily intake, not that one product is unsafe.

## Development

```bash
npm test        # build, then the fixture tests
npm run dev     # tsc --watch
```

`test/fixtures/` holds real responses from an anonymous session, trimmed to the fields the code reads. [woolworths-api-docs.md](woolworths-api-docs.md) has notes on the endpoints.

## License

GPL-3.0, see [LICENSE](LICENSE).

## Disclaimer

This is an unofficial tool and is not affiliated with or endorsed by Woolworths Group Limited. Use at your own risk and ensure compliance with Woolworths' Terms of Service.
