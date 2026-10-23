import assert from "node:assert/strict";
import { test } from "node:test";
import { buildKeyword, normalizeUrl, searchBrand } from "../src/search.js";

test("local language query", () => {
  assert.equal(buildKeyword("Lulu Post", "DE"), "Lulu Post Gutscheincode");
});
test("tracking parameters removed", () => {
  assert.equal(normalizeUrl("https://example.com/a?utm_source=x&id=2#top"), "https://example.com/a?id=2");
});
test("extract organic results and deduplicate", async () => {
  const mock = async () => new Response(JSON.stringify({ organic: [
    { link: "https://example.com/a", title: "A", position: 1 },
    { link: "https://example.com/a#fragment", title: "Duplicate", position: 2 },
  ] }), { status: 200 });
  const results = await searchBrand("Lulu Post", "US", "test-key", mock as typeof fetch);
  assert.equal(results.length, 1);
  assert.equal(results[0].position, 1);
});
