# ScrapingFinal — Phase 1: Serper Search

Search Google organic results for coupon-related brand queries across US, UK, Germany and France using Serper.dev. This phase discovers URLs only; it does not scrape or verify coupon codes.

## Setup

Requires Node.js 20+.

```bash
npm install
cp .env.example .env
```

Set your Serper API key in `.env`:

```env
SERPER_API_KEY=your_key
```

## Run

```bash
npm run search -- --brand "Lulu Post"
npm run search -- --brands "Lulu Post,Nike,Adidas" --countries US,UK,DE,FR
npm run typecheck
npm test
```

Output is saved to `output/search-<timestamp>.json`, including results and per-query failures. Up to 10 organic results are requested per brand and region; fewer may be returned. Search queries use region-specific keywords and Serper `gl`/`hl` parameters. Search API usage is billable according to your Serper plan.

## Scope

- Region-aware organic SERP discovery
- Basic URL normalization and per-query deduplication
- Retries on transient API failures
- No Playwright, scraping, or AI extraction yet

Keep `.env` private. Never commit API credentials.
