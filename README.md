# Woolworths MCP Server

A Model Context Protocol (MCP) server for interacting with Woolworths Australia's online shopping platform. This server provides tools for browsing products, searching items, viewing specials, and more.

This is a continuation of [elijah-g/Woolworths-mcp](https://github.com/elijah-g/Woolworths-mcp), keeping its history. Differences so far: slim product responses (see [Response detail](#response-detail)), a headless browser by default, and a committed lockfile. Releases are tagged `vX.Y.Z`.

<a href="https://glama.ai/mcp/servers/@elijah-g/Woolworths-mcp">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/@elijah-g/Woolworths-mcp/badge" alt="Woolworths Server MCP server" />
</a>

## Features

- **Browser Automation**: Uses Puppeteer to open a browser, navigate to Woolworths, and capture session cookies
- **Session Management**: Maintains session cookies for authenticated API requests
- **Product Search**: Search for products across the Woolworths catalog with filtering and sorting
- **Product Details**: Get detailed information about specific products
- **Specials & Deals**: Browse current specials and promotional offers
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
- `full`: the raw API payload, unchanged. For debugging.

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