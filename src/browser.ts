import { chromium, type BrowserContext, type Page } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { classify, parseCoupons, type Coupon, type Extraction } from "./extract.js";
import type { SearchResult } from "./search.js";

const revealPattern = /(?:show|reveal|view|unlock|get|copy)\s+(?:(?:promo|coupon|discount|voucher)\s+)?code/i;
const consentPattern = /^(?:accept all|accept cookies|agree|allow all)$/i;
const maxClicks = 12;
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
const safeFile = (name: string) => name.replace(/[^a-z0-9-]/gi, "_").slice(0, 90);
export type BrowserExtraction = Extraction & { finalUrl?: string; pageTitle?: string; revealButtons?: number; attemptedClicks?: number; screenshot?: string; diagnostics?: string[] };

export async function inspectBrowser(result: SearchResult, options: { headed?: boolean; artifactsDir?: string } = {}): Promise<BrowserExtraction> {
  const category = classify(result);
  const base: BrowserExtraction = {url:result.url,brand:result.brand,country:result.country,category,status:"no_code",requires_browser:false,coupons:[],diagnostics:[]};
  if (category === "community" || category === "eligibility") return {...base,status:"skipped"};
  const folder = resolve(options.artifactsDir ?? "output/browser-diagnostics");
  await mkdir(folder,{recursive:true});
  const id = safeFile(new URL(result.url).hostname + "-" + result.position);
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  const codes = new Map<string,Coupon>();
  const add = (items: Coupon[]) => { for(const c of items) codes.set(c.code.toUpperCase(),c); };
  const diagnostics: string[] = [];
  let httpStatus: number | undefined;
  let attemptedClicks = 0;
  let revealButtons = 0;
  let finalUrl = result.url;
  let pageTitle = "";
  let screenshot: string | undefined;
  try {
    const browser = await chromium.launch({headless:!options.headed});
    try {
      context = await browser.newContext({locale:"en-US",viewport:{width:1365,height:900},acceptDownloads:false});
      page = await context.newPage();
      page.on("dialog",dialog=>{ diagnostics.push("Dialog: "+dialog.type()); void dialog.dismiss().catch(()=>{}); });
      page.on("popup",popup=>{ diagnostics.push("Popup opened: "+popup.url()); void popup.close().catch(()=>{}); });
      const response = await page.goto(result.url,{waitUntil:"domcontentloaded",timeout:30000});
      httpStatus = response?.status();
      await page.waitForTimeout(1500);
      finalUrl = page.url();
      pageTitle = await page.title().catch(()=>"");
      if (httpStatus === 403 || httpStatus === 429) diagnostics.push("Access restricted: HTTP "+httpStatus);
      const consent = page.getByRole("button",{name:consentPattern}).first();
      if (await consent.count() && await consent.isVisible().catch(()=>false)) {
        await consent.click({timeout:2000}).catch(()=>{});
      }
      const inspect = async () => {
        const html = await page!.content();
        add(parseCoupons(html).coupons);
        // Only read explicit code-bearing DOM attributes, never guess from arbitrary text.
        const values = await page!.locator("[data-code],[data-coupon-code],[data-promo-code]").evaluateAll(els=>els.flatMap(el=>["data-code","data-coupon-code","data-promo-code"].map(k=>el.getAttribute(k)).filter((v):v is string=>Boolean(v))));
        for(const value of values) {
          if (/^[a-z0-9][a-z0-9_-]{3,24}$/i.test(value)) add([{code:value,evidence:"browser attribute",method:"html"}]);
        }
      };
      await inspect();
      const buttons = page.locator('button,a,[role="button"]').filter({hasText:revealPattern});
      revealButtons = await buttons.count();
      diagnostics.push("Initial reveal candidates: "+revealButtons);
      // Keep track of actual DOM nodes clicked; re-query after every interaction.
      const clicked = new Set<string>();
      for(let step=0;step<maxClicks;step++) {
        const count = await buttons.count();
        let target: ReturnType<typeof buttons.nth> | undefined;
        let key = "";
        for(let i=0;i<Math.min(count,100);i++) {
          const el = buttons.nth(i);
          if (!await el.isVisible().catch(()=>false)) continue;
          const signature = await el.evaluate((node)=> {
            const rect = node.getBoundingClientRect();
            return [node.textContent?.trim().slice(0,100),Math.round(rect.x/15),Math.round(rect.y/15),node.getAttribute("href")].join("|");
          }).catch(()=>"");
          if (!signature || clicked.has(signature)) continue;
          target=el;key=signature;break;
        }
        if(!target) break;
        clicked.add(key);
        attemptedClicks++;
        try {
          await target.click({timeout:4000});
          await delay(900);
          await inspect();
          diagnostics.push("Click "+attemptedClicks+": "+codes.size+" codes");
        } catch(err) { diagnostics.push("Click "+attemptedClicks+" failed: "+String(err).slice(0,180)); }
      }
      screenshot = resolve(folder,id+".png");
      await page.screenshot({path:screenshot,fullPage:false,timeout:8000}).catch(()=>{ screenshot=undefined; });
      await writeFile(resolve(folder,id+".json"),JSON.stringify({url:result.url,finalUrl,pageTitle,httpStatus,revealButtons,attemptedClicks,diagnostics},null,2));
    } finally { await browser.close(); }
    const coupons=[...codes.values()];
    const restricted = httpStatus === 403 || httpStatus === 429;
    return {...base,httpStatus,finalUrl,pageTitle,revealButtons,attemptedClicks,screenshot,diagnostics,coupons,requires_browser:!coupons.length && revealButtons>0,status:coupons.length?"extracted":restricted?"blocked":revealButtons>0?"needs_browser":"no_code"};
  } catch(err) {
    return {...base,httpStatus,finalUrl,pageTitle,revealButtons,attemptedClicks,screenshot,diagnostics:[...diagnostics,String(err)],status:"error",error:err instanceof Error?err.message:String(err)};
  }
}
