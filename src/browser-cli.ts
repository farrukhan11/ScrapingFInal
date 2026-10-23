import { readFile,writeFile,mkdir } from "node:fs/promises";
import { basename,resolve } from "node:path";
import { inspectBrowser } from "./browser.js";
import type { SearchResult } from "./search.js";

async function main() {
 const args=process.argv.slice(2);
 const value=(name:string)=>{const i=args.indexOf(name);return i>=0?args[i+1]:undefined;};
 const input=value("--input");
 if(!input) throw new Error("Usage: pnpm coupon-browser --input output/search-123.json [--headed] [--domain marieclaire.com]");
 const payload:unknown=JSON.parse(await readFile(resolve(input),"utf8"));
 if(!payload || typeof payload!=="object" || !("results" in payload) || !Array.isArray(payload.results)) throw new Error("Invalid search results JSON");
 const domain=value("--domain")?.toLowerCase();
 const results=(payload.results as SearchResult[]).filter(r=>r.url && (!domain || new URL(r.url).hostname.toLowerCase().includes(domain)));
 if(!results.length) throw new Error("No matching URLs in input");
 const output=[];
 for(const result of results) {
   console.log("Inspecting:",result.url);
   const record=await inspectBrowser(result,{headed:args.includes("--headed")});
   output.push(record);
   console.log(record.status,record.coupons.length+" codes",record.httpStatus??"",record.diagnostics?.join(" | "));
 }
 await mkdir(resolve("output"),{recursive:true});
 const dest=resolve("output","browser-"+basename(input));
 await writeFile(dest,JSON.stringify({generatedAt:new Date().toISOString(),results:output},null,2));
 console.log("Saved:",dest);
}
main().catch(err=>{console.error(err);process.exitCode=1;});
