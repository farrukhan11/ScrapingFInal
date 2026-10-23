import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { searchBrand, regionNames, type Region, type SearchResult } from "./search.js";

function parseArgs(argv: string[]) {
  const get = (flag: string) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const brands = (get("--brands") ?? get("--brand") ?? "").split(",").map(s => s.trim()).filter(Boolean);
  const requested = (get("--countries") ?? "US,UK,DE,FR").split(",").map(s => s.trim().toUpperCase());
  if (!brands.length) throw new Error("Provide --brand or --brands");
  if (requested.some(s => !regionNames.includes(s as Region))) throw new Error("Invalid country; use US,UK,DE,FR");
  const website = get("--website");
  if (website && brands.length !== 1) throw new Error("--website supports one brand; use --brand");
  return { brands, website, countries: [...new Set(requested)] as Region[] };
}

async function main() {
  const { brands, countries, website } = parseArgs(process.argv.slice(2));
  const apiKey = process.env.SERPER_API_KEY ?? "";
  if (!apiKey) throw new Error("Set SERPER_API_KEY in .env");
  const results: SearchResult[] = [];
  const failures: { brand: string; country: Region; error: string }[] = [];
  for (const brand of brands) {
    for (const country of countries) {
      try {
        const found = await searchBrand(brand, country, apiKey, fetch, website);
        results.push(...found);
        console.log(`${brand} / ${country}: ${found.length} results`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push({ brand, country, error: message });
        console.error(`${brand} / ${country}: ${message}`);
      }
    }
  }
  await mkdir(resolve("output"), { recursive: true });
  const file = resolve("output", `search-${Date.now()}.json`);
  await writeFile(file, JSON.stringify({ generatedAt: new Date().toISOString(), results, failures }, null, 2));
  console.log(`Saved ${results.length} results to ${file}`);
  if (failures.length) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
