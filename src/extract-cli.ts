import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, basename } from "node:path";
import { extractPage } from "./extract.js";
import type { SearchResult } from "./search.js";

async function main() {
  const args = process.argv.slice(2);
  const idx = args.indexOf("--input");
  if (idx < 0 || !args[idx+1]) throw new Error("Usage: pnpm coupon-extract --input output/search-123.json");
  const input = resolve(args[idx+1]);
  const payload: unknown = JSON.parse(await readFile(input,"utf8"));
  if (!payload || typeof payload !== "object" || !("results" in payload) || !Array.isArray(payload.results)) throw new Error("Input must contain results array");
  const results = payload.results as SearchResult[];
  const extracted = [];
  for (const item of results) {
    if (!item.url || !item.brand || !item.country) continue;
    const record = await extractPage(item);
    extracted.push(record);
    console.log(`${record.status.padEnd(14)} ${record.coupons.length} codes ${record.url}`);
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  await mkdir(resolve("output"), {recursive:true});
  const output = resolve("output", `extracted-${basename(input).replace(/\.json$/,"")}.json`);
  await writeFile(output, JSON.stringify({generatedAt:new Date().toISOString(),sourceFile:input,results:extracted},null,2));
  console.log("Saved:",output);
}
main().catch(err => { console.error(err); process.exitCode=1; });
