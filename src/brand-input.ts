import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { regionNames, type Region } from "./search.js";

export type BrandBatchItem = {
  brand: string;
  website: string;
  countries: Region[];
};

const countrySet = new Set<string>(regionNames);

export function deriveBrand(website:string):string {
  const raw=/^https?:\/\//i.test(website)?website:`https://${website}`;
  const u=new URL(raw);
  const parts=u.hostname.toLowerCase().replace(/^www\./,"").split(".");
  let label=parts[0];
  if(["us","uk","de","fr"].includes(label) && parts.length>2) label=parts[1];
  return label.replace(/[-_]+/g," ").replace(/\b\w/g,c=>c.toUpperCase());
}

function normalizeWebsite(value:string):string {
  const raw=value.trim();
  if(!raw) throw new Error("Website is required");
  const url=new URL(/^https?:\/\//i.test(raw)?raw:`https://${raw}`);
  return url.toString();
}

export async function loadBrandBatch(path:string):Promise<BrandBatchItem[]> {
  const text=await readFile(resolve(path),"utf8");
  if(path.toLowerCase().endsWith(".json")){
    const raw:unknown=JSON.parse(text);
    if(!Array.isArray(raw)) throw new Error("Brand input JSON must be an array");
    return raw.map((item:any)=>{
      const website=normalizeWebsite(String(item.website??item.url??""));
      const countriesRaw=item.countries ?? (item.country ? [item.country] : ["US"]);
      const countries=countriesRaw.map((x:any)=>String(x).trim().toUpperCase()) as Region[];
      if(!countries.length || countries.some(c=>!countrySet.has(c))) throw new Error("Invalid country; use US, UK, DE or FR");
      return {brand:String(item.brand??deriveBrand(website)).trim(),website,countries};
    });
  }

  const rows=text.split(/\r?\n/).map(x=>x.trim()).filter(Boolean)
    .filter(x=>!/^[-|\s]+$/.test(x))
    .filter(x=>!/website|domain/i.test(x) || !/country/i.test(x));

  const out:BrandBatchItem[]=[];
  for(const row of rows){
    const cells=row.includes("|")
      ? row.split("|").map(x=>x.trim()).filter(Boolean)
      : row.split(/\t|,/).map(x=>x.trim()).filter(Boolean);
    if(cells.length<2) continue;
    const website=normalizeWebsite(cells[0].replace(/^\[|\]$/g,"").split(/s+/)[0]);
    const country=String(cells[cells.length-1]).toUpperCase() as Region;
    if(!countrySet.has(country)) continue;
    out.push({brand:deriveBrand(website),website,countries:[country]});
  }
  if(!out.length) throw new Error("No valid website/country rows found");
  return out;
}
