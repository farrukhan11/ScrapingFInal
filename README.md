# ScrapingFinal — Phase 1: Serper Search

Search Google organic results for coupon-related brand queries across US, UK, Germany and France using Serper.dev. This phase discovers URLs only; it does not scrape or verify coupon codes.

## Setup

Requires Node.js 20+ and pnpm 10+.

```bash
pnpm install
cp .env.example .env
```

Set your Serper API key in `.env`:

```env
SERPER_API_KEY=your_key
```

## Run

```bash
pnpm coupon-search --brand "Citizen Watch" --website "citizenwatch.com" --countries US
pnpm coupon-search --brands "Lulu Post,Nike,Adidas" --countries US,UK,DE,FR
pnpm typecheck
pnpm test
```

Output is saved to `output/search-<timestamp>.json`, including results and per-query failures. Up to 10 organic results are requested per brand and region; fewer may be returned. Search queries use region-specific keywords and Serper `gl`/`hl` parameters. Search API usage is billable according to your Serper plan.

The optional `--website` identifies the official merchant domain and annotates official-domain results. It is **not** appended to the Google search query, so third-party coupon results remain discoverable. With `--website`, use a single brand. Without `--countries`, all four regions are searched. The URL is not a guarantee of merchant identity for third-party coupon results.\n\n## Scope

- Region-aware organic SERP discovery
- Basic URL normalization and per-query deduplication
- Retries on transient API failures
- No Playwright, scraping, or AI extraction yet

Keep `.env` private. Never commit API credentials.

## Phase 2: Static extraction

After a search, pass the generated JSON file to the extractor:

```powershell
pnpm coupon-search --brand "Citizen Watch" --website "citizenwatch.com" --countries US
pnpm coupon-extract --input "output/search-YOUR_TIMESTAMP.json"
```

Use the actual filename from the first command. Results are saved to `output/extracted-search-YOUR_TIMESTAMP.json`.

The extractor classifies sources, fetches public HTML, parses explicit coupon attributes and JSON state, and marks reveal-button pages as `needs_browser`. It does **not** click reveal buttons or verify codes at checkout. `blocked` and `error` are recorded separately. Respect website access policies and rate limits. HTML-only extraction may miss JavaScript-rendered codes.

Run `pnpm typecheck` and `pnpm test` after `pnpm install`.

## Phase 3: Browser diagnostics and reveal clicks (experimental)

```powershell
git pull origin main
pnpm install
pnpm exec playwright install chromium
pnpm coupon-browser --input "output/search-1792738476128.json" --domain marieclaire.com --headed
```

To inspect all 10 URLs, omit `--domain`. `--headed` opens visible Chromium; omit it for headless mode. Results are saved to `output/browser-search-....json` and diagnostics/screenshot files under `output/browser-diagnostics/`. The browser attempts up to 12 visible reveal buttons per page, rescanning after each click. Codes are only accepted from explicit coupon DOM attributes or structured JSON; this is not checkout validation and may return zero even after a reveal. Some pages block automated access; no CAPTCHA or access-control bypass is included. Use on sites where access and automation are permitted.
