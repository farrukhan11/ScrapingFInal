import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadBrandBatch } from "./brand-input.js";
import { searchBrand, type SearchResult } from "./search.js";
import { inspectBrowser } from "./browser.js";
import { inspectDeals } from "./deals.js";

async function main(){
  const args=process.argv.slice(2);
  const value=(flag:string)=>{const i=args.indexOf(flag);return i>=0?args[i+1]:undefined};
  const input=value("--input") ?? "brands-batch.json";
  const headed=args.includes("--headed");
  const apiKey=process.env.SERPER_API_KEY ?? "";
  if(!apiKey) throw new Error("Set SERPER_API_KEY in .env");

  const brands=await loadBrandBatch(input);
  const generatedAt=new Date().toISOString();
  const runDir=resolve("output",`run-${Date.now()}`);
  await mkdir(runDir,{recursive:true});

  const searchOutput:any[]=[];
  const couponOutput:any[]=[];
  const dealOutput:any[]=[];
  const failures:any[]=[];

  for(const item of brands){
    for(const country of item.countries){
      console.log(`\n=== ${item.brand} / ${country} ===`);
      let found:SearchResult[]=[];
      try{
        found=await searchBrand(item.brand,country,apiKey,fetch,item.website);
        searchOutput.push({
          brand:item.brand,
          country,
          website:item.website,
          results:found.map(r=>({url:r.url}))
        });
      }catch(error){
        failures.push({stage:"search",brand:item.brand,country,error:error instanceof Error?error.message:String(error)});
        continue;
      }

      const organic=[];
      for(const result of found.slice(0,10)){
        console.log("Coupon:",result.url);
        try{
          const record=await inspectBrowser(result,{headed});
          organic.push({
            url:result.url,
            codes:record.coupons.slice(0,10).map(c=>c.code),
            status:record.status
          });
        }catch(error){
          organic.push({url:result.url,codes:[],status:"error"});
          failures.push({stage:"coupon",brand:item.brand,country,url:result.url,error:error instanceof Error?error.message:String(error)});
        }
      }
      couponOutput.push({brand:item.brand,country,website:item.website,results:organic});

      console.log("Deals:",item.website);
      try{
        dealOutput.push(await inspectDeals(item,country,headed));
      }catch(error){
        failures.push({stage:"deals",brand:item.brand,country,website:item.website,error:error instanceof Error?error.message:String(error)});
      }
    }
  }

  await writeFile(resolve(runDir,"search.json"),JSON.stringify({generatedAt,searches:searchOutput,failures:failures.filter(x=>x.stage==="search")},null,2));
  await writeFile(resolve(runDir,"coupons.json"),JSON.stringify({generatedAt,results:couponOutput},null,2));
  await writeFile(resolve(runDir,"deals.json"),JSON.stringify({generatedAt,results:dealOutput},null,2));
  await writeFile(resolve(runDir,"failures.json"),JSON.stringify({generatedAt,failures},null,2));
  console.log("\nSaved full run to:",runDir);
}
main().catch(error=>{console.error(error);process.exitCode=1});
