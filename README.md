# Woolworths MCP Server

A Model Context Protocol (MCP) server for interacting with Woolworths Australia's online shopping platform. This server provides tools for browsing products, searching items, viewing specials, and more.

This is a continuation of [elijah-g/Woolworths-mcp](https://github.com/elijah-g/Woolworths-mcp), keeping its history. Differences so far: slim product responses (see [Response detail](#response-detail)), additive risk ratings and a healthier-alternative search (see [Additive risk](#additive-risk)), a headless browser by default, and a committed lockfile. Releases are tagged `vX.Y.Z`.

<a href="https://glama.ai/mcp/servers/@elijah-g/Woolworths-mcp">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/@elijah-g/Woolworths-mcp/badge" alt="Woolworths Server MCP server" />
</a>

## Features

- **Browser Automation**: Uses Puppeteer to open a browser, navigate to Woolworths, and capture session cookies
- **Session Management**: Maintains session cookies for authenticated API requests
- **Product Search**: Search for products across the Woolworths catalog with filtering and sorting
- **Product Details**: Get detailed information about specific products
- **Specials & Deals**: Browse current specials and promotional offers
- **Healthier Alternatives**: Rate additives from the ingredient list and find the cleanest products on the same shelf
- **Category Browsing**: Explore product categories
- **Shopping Cart**: Add items to cart, view cart contents, update quantities, and remove items

## Installation

1. Install dependencies:

```bash
npm install
```

2. Build the TypeScript code:

```bash
npm run build
```

## Usage

### Running the Server

The MCP server runs on stdio and is designed to be used with MCP-compatible clients (like Claude Desktop, Cline, or other AI assistants).

```bash
npm start
```

### Configuration for Claude Desktop

Add this to your Claude Desktop configuration file:

**Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "woolworths": {
      "command": "node",
      "args": ["C:\\Users\\eglass\\Projects\\Woolworths\\dist\\index.js"]
    }
  }
}
```

Make sure to update the path to match your installation directory.

## Available Tools

### 1. woolworths_open_browser

Opens a browser and navigates to the Woolworths website. This is typically the first step to establish a session.

The browser is headless. Set `WOOLWORTHS_HEADLESS=false` in the server's environment to get a visible one, e.g. to log in by hand on a desktop.

**Parameters:** None

### 2. woolworths_navigate

Navigate to a specific URL on the Woolworths website.

**Parameters:**
- `url` (string, required): The URL to navigate to

### 3. woolworths_get_cookies

Retrieves and stores session cookies from the current browser session. Run this after logging in or when you have an active session.

**Parameters:** None

### 4. woolworths_close_browser

Closes the browser instance while preserving the captured session cookies.

**Parameters:** None

### 5. woolworths_search_products

Search for products on Woolworths.

**Parameters:**
- `searchTerm` (string, required): The product search term
- `pageNumber` (number, optional): Page number (default: 1)
- `pageSize` (number, optional): Number of results to return (default: 10)
- `sortType` (string, optional): `TraderRelevance`, `PriceAsc`, `PriceDesc` or `Name`
- `isSpecial` (boolean, optional): Specials only (default: false)
- `includeSponsored` (boolean, optional): Keep the sponsored ads Woolworths injects into results (default: false)
- `detail` (string, optional): see [Response detail](#response-detail) (default: `summary`)

**Example:**
```json
{
  "searchTerm": "milk",
  "pageSize": 10
}
```

### 6. woolworths_get_product_details

Get detailed information about a specific product by its stockcode.

**Parameters:**
- `stockcode` (string, required): The product stockcode/ID
- `detail` (string, optional): see [Response detail](#response-detail) (default: `nutrition`)

### 6a. woolworths_find_healthier

Find the healthier options for a shopping-list item: search, rate every result, drop those with additives above `maxRisk`, and rank the rest by score. See [Additive risk](#additive-risk).

**Parameters:**
- `searchTerm` (string, required): a plain product name - "chicken stock", not "500 mL chicken stock, salt-reduced"
- `maxRisk` (string, optional): `none`, `watch`, `moderate` or `high` - the worst additive risk to keep (default: `moderate`, i.e. drop only `high`)
- `limit` (number, optional): products to return (default: 5)
- `candidates` (number, optional): search results to rate (default: 24, max: 36)
- `sameShelf` (boolean, optional): compare only products on the same shelf as the top results (default: true)

Returns `products` (slim, at `health` detail), `shelf`, and `excluded` - what was dropped and why. When nothing passes (cured meats, nearly always nitrite and phosphates), `leastBad` holds the closest.

```json
{"success":true,"rated":24,"shelf":["Stock & Gravy"],
 "products":[{"stockcode":34559,"name":"Campbell's Real Stock Chicken 500mL","price":2.75,"cup":"$0.55 / 100ML","hsr":3,"health":{"score":75,"nutriScore":"A","risk":"none","additives":1}}],
 "excluded":[{"name":"OXO Chicken Stock Cubes 71g","flagged":["E621 Monosodium glutamate: high","E150c Ammonia caramel: moderate"]}]}
```

### 7. woolworths_get_specials

Get current specials and deals from Woolworths.

**Parameters:**
- `category` (string, optional): Category filter (e.g., 'fruit-veg', 'meat-seafood')
- `pageSize` (number, optional): Number of results to return (default: 20)
- `detail` (string, optional): see [Response detail](#response-detail) (default: `summary`)

### 8. woolworths_get_categories

Get the list of available product categories.

**Parameters:** None

### 9. woolworths_add_to_cart

Add a product to the shopping cart/trolley.

**Parameters:**
- `stockcode` (number, required): The product stockcode/ID
- `quantity` (number, optional): Quantity to add (default: 1)

**Example:**
```json
{
  "stockcode": 123456,
  "quantity": 2
}
```

### 10. woolworths_get_cart

Get the current contents of the shopping cart/trolley.

**Parameters:** None

### 11. woolworths_remove_from_cart

Remove a product from the shopping cart/trolley.

**Parameters:**
- `stockcode` (number, required): The product stockcode/ID to remove

### 12. woolworths_update_cart_quantity

Update the quantity of a product in the shopping cart/trolley.

**Parameters:**
- `stockcode` (number, required): The product stockcode/ID
- `quantity` (number, required): New quantity

## Response detail

The raw Woolworths payload is about 11 KB (3-4k tokens) per product, so the product tools return a slim shape instead:

```json
{"stockcode":123456,"name":"Woolworths Full Cream Milk 2L","price":3.3,"cup":"$1.65 / 1L","promo":"Range was $3.50","hsr":4}
```

Fields at their default are left out: `special`, `was` and `save` appear only on a special, `promo` only when there is promotion text (multibuys and "lower shelf price" deals are not `special`), `hsr` only when the product has a health star rating, and `unavailable` / `sponsored` only when true.

- `summary`: the fields above.
- `nutrition`: adds `nutrition`, eight per-100g values (energyKj, protein, fat, satFat, carbs, sugars, fibre, sodium).
- `health`: `nutrition`, plus `health` - a Yuka-style score, Nutri-Score and additive risk (see [Additive risk](#additive-risk)).
- `full`: the raw API payload, unchanged. For debugging.

## Additive risk

The `health` detail and `woolworths_find_healthier` rate products the way Yuka does, from data Woolworths already returns: the nutrition panel and the ingredient list.

```json
"health":{"score":17,"nutriScore":"D","risk":"high","flagged":["E451 Triphosphates: high","E250 Sodium nitrite: high"],"additives":4}
```

- `score`: 0-100, Yuka's published formula (below). Absent when the nutrition panel or the ingredient list is missing.
- `nutriScore`: the Nutri-Score grade, calculated from the nutrition panel.
- `risk`: the worst additive found. `unknown` when Woolworths has no ingredient list. Fresh fruit and vegetables have none either, and are `none` with `produce: true`.
- `flagged`: rated additives, worst first.
- `additives`: every additive recognised, rated or not.
- `organic`: by name or by Woolworths' claims fields.

### Score

As Yuka documents it ([food scoring](https://help.yuka.io/l/en/category/zlf9yu9htc-food-scoring)):

- 60% nutrition: the Nutri-Score grade mapped onto A 100-75, B 75-55, C 55-35, D 35-10, E 10-0, placed linearly within the band by Nutri-Score points (Yuka does not publish where in the band).
- 30% additives: 30 points, less 6 per `watch` additive, 15 per `moderate`, 30 per `high`.
- 10% organic.
- Capped at 49 by any `high` additive, and by a D or E Nutri-Score.

Nutri-Score is the 2023 algorithm: general foods, beverages (including milk and plant drinks, with the sweetener penalty), fats and oils, cheese, and the red-meat protein cap, chosen from Woolworths' shelf categories. The fruit, vegetable and legume share is not in Woolworths' data and is taken as zero - except olive, canola and walnut oil, which count wholly - so a fruit-heavy product can grade one step harsher than on its pack.

### Additive levels

| Level | Meaning | Examples |
| --- | --- | --- |
| `high` | EFSA found a high risk of some consumers exceeding the safe intake; IARC Group 1 or 2A; or EFSA no longer considers it safe | nitrites, sulphites, benzoates, sorbates, phosphates, carrageenan, MSG, titanium dioxide (171) |
| `moderate` | A lesser EFSA overexposure risk; IARC Group 2B; or one of the six azo colours that carry an EU hyperactivity warning | aspartame (951), BHA (320), ammonia caramels (150c, 150d), tartrazine (102), potassium chloride (508) |
| `watch` | On the ANSES (France) 2019 list of additives of interest | acesulfame K, sucralose, 472e |
| `none` | Assessed, no concern; or nothing rated was found | |

Additives are found by number - Australian labels write "Emulsifier (471)", "Mineral Salts (450, 451)" - and by name ("Sodium Nitrite"). Numbers are INS codes, the same as EU E-numbers.

The table is generated from the [Open Food Facts additives taxonomy](https://github.com/openfoodfacts/openfoodfacts-server/blob/main/taxonomies/additives.txt) (ODbL), which records the EFSA and ANSES assessments. IARC classifications and the titanium dioxide reversal are not in it; `scripts/build-additives.mjs` adds them, each with its monograph or regulation. Yuka's own ratings are not published as data. To refresh:

```bash
npm run build:additives
```

This is a filter over published assessments, not dietary advice: an EFSA overexposure risk means some consumers may exceed the acceptable daily intake, not that one product is unsafe.

## Typical Workflow

1. **Open Browser**: Use `woolworths_open_browser` to launch a browser window
2. **Log In** (if needed): with `WOOLWORTHS_HEADLESS=false` the browser is visible, so you can log in to your Woolworths account by hand
3. **Capture Cookies**: Use `woolworths_get_cookies` to capture session cookies
4. **Close Browser**: Use `woolworths_close_browser` to close the browser (cookies are preserved)
5. **Use API Tools**: Now you can use any of the API tools (search, get product details, etc.)

## Example Usage Scenario

```
1. User: "Open the Woolworths browser"
   → Calls: woolworths_open_browser
   
2. User manually logs in on the opened browser (if needed)

3. User: "Get the session cookies"
   → Calls: woolworths_get_cookies
   
4. User: "Close the browser"
   → Calls: woolworths_close_browser
   
5. User: "Search for bananas"
   → Calls: woolworths_search_products with searchTerm="bananas"
   
6. User: "What are the current specials?"
   → Calls: woolworths_get_specials

7. User: "Add product 123456 to my cart"
   → Calls: woolworths_add_to_cart with stockcode=123456

8. User: "Show me my cart"
   → Calls: woolworths_get_cart
```

## Technical Details

### Browser Automation

The server uses Puppeteer to:
- Launch a Chromium browser instance
- Navigate to Woolworths website
- Capture cookies from the browser session
- Maintain user agent and browser fingerprint

### API Integration

Once cookies are captured, the server makes authenticated requests to Woolworths' internal APIs:
- Search API: `/apis/ui/Search/products` (POST)
- Product Detail API: `/apis/ui/product/detail/{stockcode}`
- Browse/Category API: `/apis/ui/browse/category`
- Categories API: `/apis/ui/PiesCategoriesWithSpecials`
- Shopping Cart API: `/apis/ui/Trolley/*` (AddItem, RemoveItem, UpdateItem, Get)

### Session Management

Session cookies are stored in memory for the duration of the server process. If the server restarts, you'll need to recapture cookies by opening the browser again.

## Development

### Watch Mode

For development with auto-recompilation:

```bash
npm run dev
```

### Building

```bash
npm run build
```

## Requirements

- Node.js 18 or higher
- npm or yarn
- Chromium/Chrome (automatically installed by Puppeteer)

## Notes

- The browser is headless by default; `WOOLWORTHS_HEADLESS=false` makes it visible for manual login
- Session cookies are stored in memory and persist until the server is restarted
- API endpoints are based on Woolworths' public web interface and may change
- Always respect Woolworths' Terms of Service when using this tool

## Troubleshooting

### Browser won't open
- Check that Puppeteer installed correctly
- On a machine without a display, make sure `WOOLWORTHS_HEADLESS` is not set to `false`

### API requests fail
- Ensure you've captured cookies with `woolworths_get_cookies`
- Check that the session hasn't expired (you may need to re-open browser and capture new cookies)
- Verify the API endpoints are still valid

### Connection issues
- Ensure you have a stable internet connection
- Check that Woolworths website is accessible from your location

## License

GPL-3.0, see [LICENSE](LICENSE).

## Disclaimer

This is an unofficial tool and is not affiliated with or endorsed by Woolworths Group Limited. Use at your own risk and ensure compliance with Woolworths' Terms of Service.