import "dotenv/config";
import { chromium } from "playwright";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadBrandBatch } from "./brand-input.js";
import { buildKeyword, normalizeUrl, regions, type Region } from "./search.js";

const googleHosts:Record<Region,string>={
  US:"www.google.com",
  CA:"www.google.ca",
  AU:"www.google.com.au",
  UK:"www.google.co.uk",
  DE:"www.google.de",
  FR:"www.google.fr"
};

const localeMap:Record<Region,string>={
  US:"en-US",
  CA:"en-CA",
  AU:"en-AU",
  UK:"en-GB",
  DE:"de-DE",
  FR:"fr-FR"
};

const safe=(s:string)=>s.replace(/[^a-z0-9-]+/gi,"-").replace(/^-|-$/g,"").toLowerCase();

async function main(){
  const args=process.argv.slice(2);
  const value=(f:string)=>{const i=args.indexOf(f);return i>=0?args[i+1]:undefined};
  const input=value("--input");
  const headed=args.includes("--headed");
  if(!input) throw new Error("Usage: pnpm google-search-browser --input brands.txt [--headed]");

  const items=await loadBrandBatch(input);
  const browser=await chromium.launch({
    headless:!headed,
    args:["--no-sandbox","--disable-dev-shm-usage"]
  });

  const searches:any[]=[];
  const failures:any[]=[];

  try{
    for(const item of items){
      for(const country of item.countries){
        const query=buildKeyword(item.brand,country);
        const host=googleHosts[country];
        const region=regions[country];
        const context=await browser.newContext({
          locale:localeMap[country],
          viewport:{width:1440,height:1200},
          timezoneId:"UTC"
        });
        const page=await context.newPage();

        try{
          const url=`https://${host}/search?q=${encodeURIComponent(query)}&hl=${encodeURIComponent(region.hl)}&gl=${encodeURIComponent(region.gl)}&num=10&pws=0&filter=0`;
          const response=await page.goto(url,{waitUntil:"domcontentloaded",timeout:35000});
          await page.waitForTimeout(1800);

          const title=await page.title().catch(()=>"");
          const body=await page.locator("body").innerText({timeout:5000}).catch(()=>"");
          const blocked=/unusual traffic|automated queries|detected unusual traffic|captcha|verify you are human/i.test(body+" "+title);

          if(blocked){
            failures.push({brand:item.brand,country,query,error:"Google blocked/CAPTCHA"});
            searches.push({brand:item.brand,domain:new URL(item.website).hostname.replace(/^www\./,""),country,query,googleHost:host,sponsored:[],organic:[],status:"blocked"});
            await context.close();
            continue;
          }

          // Sponsored search ads: collect ad containers first, then resolve their main outbound links.
          const sponsored=await page.evaluate(() => {
            const out:any[]=[];
            const seen=new Set<string>();
            const containers=[...document.querySelectorAll("div")].filter((el:any)=>{
              const text=(el.innerText||"").trim();
              if(!text || text.length>4000) return false;
              return /(^|\n)(Sponsored|Ad)(\n|$)/i.test(text) && el.querySelector("a[href]");
            });

            for(const el of containers){
              const links=[...el.querySelectorAll("a[href]")] as HTMLAnchorElement[];
              const main=links.find(a=>{
                const href=a.href||"";
                return /^https?:\/\//i.test(href) && !/google\./i.test(new URL(href).hostname);
              });
              if(!main) continue;
              const href=main.href;
              if(seen.has(href)) continue;
              seen.add(href);
              const heading=(el.querySelector("h3")?.textContent||main.textContent||"").trim();
              out.push({title:heading,url:href});
              if(out.length>=10) break;
            }
            return out;
          });

          // Organic results: Google's result anchors with h3 are substantially more stable than CSS class names.
          const organicRaw=await page.evaluate(() => {
            const out:any[]=[];
            const seen=new Set<string>();
            for(const a of [...document.querySelectorAll("a[href]")] as HTMLAnchorElement[]){
              const h3=a.querySelector("h3");
              if(!h3) continue;
              let href=a.href||"";
              if(!href) continue;
              try{
                const u=new URL(href);
                if(u.hostname.includes("google.")) continue;
              }catch{continue}
              if(seen.has(href)) continue;
              seen.add(href);
              out.push({title:(h3.textContent||"").trim(),url:href});
              if(out.length>=20) break;
            }
            return out;
          });

          const sponsoredUrls=new Set<string>();
          const cleanSponsored:any[]=[];
          for(const [i,r] of sponsored.entries()){
            const clean=normalizeUrl(r.url);
            if(!clean || sponsoredUrls.has(clean)) continue;
            sponsoredUrls.add(clean);
            cleanSponsored.push({position:cleanSponsored.length+1,title:r.title,url:clean});
          }

          const cleanOrganic:any[]=[];
          const seenOrganic=new Set<string>();
          for(const r of organicRaw){
            const clean=normalizeUrl(r.url);
            if(!clean || sponsoredUrls.has(clean) || seenOrganic.has(clean)) continue;
            seenOrganic.add(clean);
            cleanOrganic.push({position:cleanOrganic.length+1,title:r.title,url:clean});
            if(cleanOrganic.length>=10) break;
          }

          searches.push({
            brand:item.brand,
            domain:new URL(item.website).hostname.replace(/^www\./,""),
            country,
            query,
            googleHost:host,
            status:"ok",
            sponsored:cleanSponsored,
            organic:cleanOrganic
          });

          console.log(`${item.brand} / ${country}: ${cleanSponsored.length} sponsored, ${cleanOrganic.length} organic`);
        }catch(error){
          const message=error instanceof Error?error.message:String(error);
          failures.push({brand:item.brand,country,query,error:message});
          console.error(`${item.brand} / ${country}: ${message}`);
        }finally{
          await context.close();
        }

        // Small pause between brands to reduce burstiness.
        await new Promise(r=>setTimeout(r,1200));
      }
    }
  }finally{
    await browser.close();
  }

  await mkdir(resolve("output"),{recursive:true});
  const stamp=Date.now();
  const file=resolve("output",`google-browser-search-${stamp}.json`);
  const latest=resolve("output","google-browser-search-latest.json");
  const payload={generatedAt:new Date().toISOString(),searches,failures};
  const text=JSON.stringify(payload,null,2);
  await writeFile(file,text);
  await writeFile(latest,text);
  console.log(JSON.stringify({...payload,file,latest},null,2));
}

main()
  .then(()=>process.exit(0))
  .catch(error=>{console.error(error);process.exit(1)});
