import {readFile,writeFile,mkdir} from "node:fs/promises";
import {resolve} from "node:path";
import {z} from "zod";
import {inspectDeals,type BrandConfig} from "./deals.js";
import {regionNames,type Region} from "./search.js";

const schema=z.array(z.object({brand:z.string().min(1),website:z.string().url(),countries:z.array(z.enum(regionNames as [Region,...Region[]])).min(1)}));
async function main(){
 const args=process.argv.slice(2);const val=(f:string)=>{const i=args.indexOf(f);return i>=0?args[i+1]:undefined};
 const input=val("--input")??"brands.json";
 const brands=schema.parse(JSON.parse(await readFile(resolve(input),"utf8"))) as BrandConfig[];
 const results=[];
 for(const brand of brands) for(const country of brand.countries){
   console.log("Deals:",brand.brand,country);
   try{results.push(await inspectDeals(brand,country,args.includes("--headed")))}
   catch(error){results.push({brand:brand.brand,country,website:brand.website,error:error instanceof Error?error.message:String(error)})}
 }
 await mkdir(resolve("output"),{recursive:true});
 const dest=resolve("output",`deals-${Date.now()}.json`);
 await writeFile(dest,JSON.stringify({generatedAt:new Date().toISOString(),results},null,2));
 console.log("Saved:",dest);
}
main().catch(e=>{console.error(e);process.exitCode=1});
