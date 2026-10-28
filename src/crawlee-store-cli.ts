import "dotenv/config";
import { PlaywrightCrawler } from "crawlee";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { type Coupon } from "./extract.js";
import { readAndCloseModal } from "./modal.js";

const revealPattern=/(?:show|reveal|view|unlock|get|copy)\s+(?:(?:promo|coupon|discount|voucher)\s+)?code/i;
const codePatterns=[
  /(?:coupon|promo|discount|voucher)\s+code\s*[:#-]?\s*([A-Z0-9][A-Z0-9_%.-]{1,31})/gi,
  /(?:use|enter|apply)\s+(?:promo\s+|coupon\s+|discount\s+)?code\s*[:#-]?\s*([A-Z0-9][A-Z0-9_%.-]{1,31})\b/gi,
  /(?:rabattcode|gutscheincode)\s*[:#-]?\s*([A-Z0-9][A-Z0-9_%.-]{1,31})/gi,
  /code\s+promo\s*[:#-]?\s*([A-Z0-9][A-Z0-9_%.-]{1,31})/gi
];
const rejected=/^(?:choose|select|your|the|this|offer|offers|deal|deals|shop|shopping|click|here|copy|apply|show|reveal|code|coupon|promo|discount|voucher|save|terms|more|details|now|today|free|shipping|sale|required|strict|for|from|with|product|customer|newsletter|true|false|receive|use|enjoy|during|take)$/i;
const q=(s:string)=>JSON.stringify(s);

async function main(){
  const args=process.argv.slice(2);
  const value=(f:string)=>{const i=args.indexOf(f);return i>=0?args[i+1]:undefined};
  const input=value("--input");
  const brand=value("--brand");
  const concurrency=Math.max(1,Math.min(10,Number(value("--concurrency")??4)));
  if(!input || !brand) throw new Error("Usage: pnpm coupon-crawlee-store --input output/search-123.json --brand \"Dansko\" [--concurrency 4]");

  const brandCompact=brand.toLowerCase().replace(/[^a-z0-9]/g,"");
  const valid=(s:string)=>{
    const v=s.trim();
    if(!/^[a-z0-9][a-z0-9_%.-]{1,31}$/i.test(v) || rejected.test(v)) return false;
    const compact=v.toLowerCase().replace(/[^a-z0-9]/g,"");
    if(compact.length < 2) return false;
    if(compact===brandCompact) return false;
    if(/^\d+%$/.test(v)) return false;
    if(compact===brandCompact+"get" || compact===brandCompact+"free") return false;

    // Letter-only coupon codes are valid only when the source actually displays
    // them as uppercase tokens (e.g. BEST, GIVEAWAY, FREESHIP). This rejects
    // prose words such as October, Ending, Browse, by, is, Get, See, etc.
    if(/^[A-Za-z]+$/.test(v) && v !== v.toUpperCase()) return false;

    // Tiny letter-only fragments are almost always prose/noise.
    if(/^[A-Z]{1,3}$/.test(v)) return false;

    return true;
  };

  const payload:any=JSON.parse(await readFile(resolve(input),"utf8"));
  const searches=Array.isArray(payload.searches)?payload.searches:[];
  const search=searches.find((s:any)=>String(s.brand).toLowerCase()===brand.toLowerCase());
  if(!search) throw new Error("Brand not found in search JSON: "+brand);

  const urls=(search.results??[]).map((r:any)=>String(r.url)).filter(Boolean).slice(0,10);
  if(!urls.length) throw new Error("No URLs for brand: "+brand);

  const records:any[]=[];
  const crawler=new PlaywrightCrawler({
    maxConcurrency:concurrency,
    maxRequestRetries:0,
    navigationTimeoutSecs:35,
    requestHandlerTimeoutSecs:75,
    launchContext:{launchOptions:{headless:true}},
    async requestHandler({request,page,log,response}){
      const originalUrl=request.url;
      const httpStatus=response?.status();
      if(httpStatus===403 || httpStatus===429){
        records.push({url:originalUrl,status:"blocked",codes:[],httpStatus});
        log.warning(`${brand}: ${originalUrl} -> blocked (${httpStatus})`);
        return;
      }
      const host=new URL(originalUrl).hostname.replace(/^www\./,"");
      const sameSite=(p:any)=>{try{return new URL(p.url()).hostname.replace(/^www\./,"")===host}catch{return false}};
      const codes=new Map<string,Coupon>();
      const add=(items:Coupon[])=>{for(const c of items){const v=c.code.trim();if(valid(v))codes.set(v.toUpperCase(),{...c,code:v})}};
      const diagnostics:string[]=[];
      let attemptedClicks=0;
      let revealButtons=0;
      let status="no_code";

      const readPage=async(p:any,evidence:string)=>{
        try{
          const text=await p.locator("body").innerText({timeout:2500}).catch(()=>"");
          for(const re of codePatterns){
            for(const m of text.matchAll(re)) add([{code:m[1],evidence,method:"html"}]);
          }
          const explicit=await p.locator('[data-code],[data-coupon-code],[data-promo-code],[itemprop="discountCode"],.coupon-code,.promo-code').evaluateAll((els:any[])=>els.map(el=>el.getAttribute("data-code")??el.getAttribute("data-coupon-code")??el.getAttribute("data-promo-code")??el.getAttribute("content")??(el.textContent??"").trim()).filter(Boolean)).catch(()=>[]);
          for(const v of explicit) if(valid(String(v).trim())) add([{code:String(v).trim(),evidence:"coupon attribute",method:"html"}]);
        }catch{}
      };

      const readClipboard=async(p:any)=>{
        try{
          const copy=p.locator('button,a,[role="button"]').filter({hasText:/^\s*copy(?: code)?\s*$/i}).first();
          if(await copy.count() && await copy.isVisible().catch(()=>false)){
            await copy.click({force:true,noWaitAfter:true,timeout:1200}).catch(()=>{});
            await p.waitForTimeout(120);
            const v=(await p.evaluate(()=>navigator.clipboard.readText()).catch(()=>"")).trim();
            if(valid(v)){add([{code:v,evidence:"COPY clipboard",method:"html"}]);return true;}
          }
        }catch{}
        return false;
      };

      await page.context().grantPermissions(["clipboard-read","clipboard-write"]).catch(()=>{});
      await page.waitForTimeout(1000);
      const consent=page.getByRole("button",{name:/^(?:accept all|accept cookies|agree|allow all)$/i}).first();
      if(await consent.count() && await consent.isVisible().catch(()=>false)) await consent.click({timeout:1500}).catch(()=>{});

      await readPage(page,"initial page");

      const restoreCouponPage=async()=>{
        if(sameSite(page)) return true;
        diagnostics.push("Same-tab affiliate redirect ignored: "+page.url());
        await page.goBack({waitUntil:"domcontentloaded",timeout:4000}).catch(()=>null);
        if(!sameSite(page)){
          await page.goto(originalUrl,{waitUntil:"domcontentloaded",timeout:8000}).catch(()=>null);
        }
        await page.waitForTimeout(200);
        return sameSite(page);
      };

      const buttons=page.locator('button,a,[role="button"]').filter({hasText:revealPattern});
      revealButtons=await buttons.count().catch(()=>0);

      const readRevealContext=async(target:any)=>{
        try{
          const data=await target.evaluate((node:any)=>{
            let el:any=node;
            const attrs:string[]=[];
            const texts:string[]=[];
            for(let i=0;i<5 && el;i++,el=el.parentElement){
              for(const name of ["data-code","data-coupon-code","data-promo-code","data-discount-code","content"]){
                const value=el.getAttribute?.(name);
                if(value) attrs.push(value);
              }
              const text=(el.textContent??"").replace(/\s+/g," ").trim();
              if(text) texts.push(text.slice(0,1200));
            }
            return {attrs,texts};
          });
          for(const raw of data.attrs??[]) if(valid(String(raw).trim())) {
            add([{code:String(raw).trim(),evidence:"reveal card attribute",method:"html"}]);
          }
          for(const text of data.texts??[]){
            for(const re of codePatterns){
              for(const m of String(text).matchAll(re)){
                add([{code:m[1],evidence:"reveal card text",method:"html"}]);
              }
            }
          }
        }catch{}
      };

      const maxAttempts=Math.min(revealButtons,20);
      const usedRevealIndexes=new Set<number>();
      for(let i=0;i<maxAttempts && codes.size<10;i++){
        await restoreCouponPage();
        const fresh=page.locator('button,a,[role="button"]').filter({hasText:revealPattern});
        const count=await fresh.count().catch(()=>0);
        if(!count) break;

        let target:any=undefined;
        let targetIndex=-1;
        for(let j=0;j<count;j++){
          if(usedRevealIndexes.has(j)) continue;
          const candidate=fresh.nth(j);
          if(!await candidate.isVisible().catch(()=>false)) continue;
          const expired=await candidate.evaluate((node:any)=>{
            let el:any=node;
            for(let n=0;n<5&&el;n++,el=el.parentElement){
              if(/offer expired|expired/i.test((el.textContent??"").replace(/\s+/g," "))) return true;
            }
            return false;
          }).catch(()=>false);
          if(expired) continue;
          target=candidate;
          targetIndex=j;
          break;
        }
        if(!target) break;
        usedRevealIndexes.add(targetIndex);

        await readRevealContext(target);
        attemptedClicks++;
        const popupPromise=page.waitForEvent("popup",{timeout:1800}).catch(()=>undefined);
        await target.scrollIntoViewIfNeeded().catch(()=>{});
        await target.click({force:true,noWaitAfter:true,timeout:1500}).catch(()=>{});
        const popup=await popupPromise;

        if(popup){
          await popup.waitForLoadState("domcontentloaded",{timeout:2500}).catch(()=>{});
          await popup.waitForTimeout(250);
          if(sameSite(popup)){
            await readPage(popup,"reveal popup");
            if(!await readClipboard(popup)){
              const modal=await readAndCloseModal(popup).catch(()=>({codes:[],modalFound:false,closed:false}));
              add(modal.codes??[]);
            }
          }
          await popup.close().catch(()=>{});
        }else{
          await page.waitForTimeout(250);
          await restoreCouponPage();
          await readPage(page,"in-page reveal");
          if(!await readClipboard(page)){
            const modal=await readAndCloseModal(page).catch(()=>({codes:[],modalFound:false,closed:false}));
            add(modal.codes??[]);
          }
          await page.keyboard.press("Escape").catch(()=>{});
        }
      }

      const finalCodes=[...codes.values()].slice(0,10).map(c=>c.code);
      status=finalCodes.length?"extracted":revealButtons?"needs_browser":"no_code";
      records.push({
        url:originalUrl,
        finalUrl:page.url(),
        status,
        codes:finalCodes,
        revealButtons,
        attemptedClicks,
        diagnostics
      });
      log.info(`${brand}: ${originalUrl} -> ${status} (${finalCodes.length} codes)`);
    },
    failedRequestHandler({request,log},error){
      const blocked=/403|429|blocked/i.test(error.message);
      records.push({
        url:request.url,
        status:blocked?"blocked":"error",
        codes:[],
        error:error.message
      });
      if(blocked) log.warning(`${brand}: ${request.url} -> blocked`);
      else log.error(`Failed ${request.url}: ${error.message}`);
    }
  });

  await crawler.run(urls);

  const order = new Map<string, number>(urls.map((u:string,i:number)=>[u,i] as [string, number]));
  records.sort((a,b)=>(order.get(a.url)??999)-(order.get(b.url)??999));

  const uniqueCodes=[...new Set(records.flatMap(r=>r.codes))];
  const result={
    brand:search.brand,
    country:search.country,
    expectedUrlCount:urls.length,
    processedUrlCount:records.length,
    missingUrls:urls.filter((u:string)=>!records.some(r=>r.url===u)),
    allUrlsProcessed:records.length===urls.length && urls.every((u:string)=>records.some(r=>r.url===u)),
    totalUniqueCodes:uniqueCodes.length,
    uniqueCodes,
    results:records
  };

  await mkdir(resolve("output"),{recursive:true});
  const safe=String(search.brand).replace(/[^a-z0-9]+/gi,"-").replace(/^-|-$/g,"").toLowerCase();
  const jsonPath=resolve("output",`crawlee-${safe}-${Date.now()}.json`);
  const csvPath=resolve("output",`crawlee-${safe}-${Date.now()}.csv`);
  await writeFile(jsonPath,JSON.stringify(result,null,2));

  const rows=[["brand","country","source_url","coupon_code","status"]];
  for(const r of records){
    if(r.codes.length) for(const code of r.codes) rows.push([search.brand,search.country,r.url,code,r.status]);
    else rows.push([search.brand,search.country,r.url,"",r.status]);
  }
  const csv=rows.map(row=>row.map((v:any)=>q(String(v))).join(",")).join("\n");
  await writeFile(csvPath,csv);

  console.log(JSON.stringify({...result,jsonPath,csvPath},null,2));
}
main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
