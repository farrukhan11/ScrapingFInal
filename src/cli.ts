import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { searchBrand, regionNames, type Region } from "./search.js";
import { loadBrandBatch } from "./brand-input.js";

async function parseArgs(argv: string[]) {
  const get = (flag: string) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const input = get("--input");
  if (input) return { brandInputs: await loadBrandBatch(input) };

  const brands = (get("--brands") ?? get("--brand") ?? "").split(",").map(s => s.trim()).filter(Boolean);
  const requested = (get("--countries") ?? "US,UK,DE,FR").split(",").map(s => s.trim().toUpperCase());
  if (!brands.length) throw new Error("Provide --brand, --brands or --input");
  const normalizedRequested=requested.map(s=>s==="GB"?"UK":s);
  if (normalizedRequested.some(s => !regionNames.includes(s as Region))) throw new Error("Invalid country; use US,CA,UK/GB,DE,FR");
  const website = get("--website");
  if (website && brands.length !== 1) throw new Error("--website supports one brand; use --brand");
  return { brandInputs: brands.map(brand=>({brand,website:website ?? `https://${brand.toLowerCase().replace(/\s+/g,"")}.com/`,countries:[...new Set(normalizedRequested)] as Region[]})) };
}

async function main() {
  const { brandInputs } = await parseArgs(process.argv.slice(2));
  const apiKey = process.env.SERPER_API_KEY ?? "";
  if (!apiKey) throw new Error("Set SERPER_API_KEY in .env");
  const searches: { brand:string; country:Region; results:{url:string}[] }[] = [];
  const failures: { brand: string; country: Region; error: string }[] = [];
  for (const item of brandInputs) {
    for (const country of item.countries) {
      const brand=item.brand;
      try {
        const found = await searchBrand(brand, country, apiKey, fetch, item.website);
        searches.push({brand,country,results:found.map(item=>({url:item.url}))});
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
  const latest = resolve("output", "search-latest.json");
  const payload = JSON.stringify({ generatedAt: new Date().toISOString(), searches, failures }, null, 2);
  await writeFile(file, payload);
  await writeFile(latest, payload);
  const total=searches.reduce((sum,s)=>sum+s.results.length,0);
  console.log(`Saved ${total} results to ${file}`);
  if (failures.length) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
