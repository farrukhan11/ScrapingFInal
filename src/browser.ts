import { chromium, type BrowserContext, type Page } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { classify, parseCoupons, type Coupon, type Extraction } from "./extract.js";
import type { SearchResult } from "./search.js";
import { readAndCloseModal } from "./modal.js";

const revealPattern = /(?:show|reveal|view|unlock|get|copy)\s+(?:(?:promo|coupon|discount|voucher)\s+)?code/i;
const consentPattern = /^(?:accept all|accept cookies|agree|allow all)$/i;
const maxClicks = 12;
const codeNearLabel = /(?:coupon|promo|discount|voucher)\s+code\s*[:#-]\s*([A-Z0-9][A-Z0-9_-]{3,24})/gi;
const rejectedTokens = /^(?:choose|select|your|the|this|offer|offers|deal|deals|shop|shopping|click|here|copy|apply|show|reveal|code|coupon|promo|discount|voucher|save|terms|more|details|now|today|free|shipping)$/i;
const validCode = (code: string) => /^[a-z0-9][a-z0-9_-]{3,24}$/i.test(code) && !rejectedTokens.test(code) && (/[0-9]/.test(code) || /[A-Z]/.test(code.slice(1)));
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
  const add = (items: Coupon[]) => { for(const c of items) if(validCode(c.code)) codes.set(c.code.toUpperCase(),c); };
  const diagnostics: string[] = [];
  let httpStatus: number | undefined;
  let attemptedClicks = 0;
  let revealButtons = 0;
  let finalUrl = result.url;
  let pageTitle = "";
  let screenshot: string | undefined;
  const popupPages: Page[] = [];
  const siteHost = new URL(result.url).hostname.replace(/^www\./,"");
  const sameCouponSite = (p: Page) => { try { const h=new URL(p.url()).hostname;return h===siteHost || h==="www."+siteHost; } catch {return false;} };
  const snapshots: Array<{url:string;visibleText:string;dialogText:string[]}> = [];
  try {
    const browser = await chromium.launch({headless:!options.headed});
    try {
      context = await browser.newContext({locale:"en-US",viewport:{width:1365,height:900},acceptDownloads:false,permissions:["clipboard-read","clipboard-write"]});
      page = await context.newPage();
      page.on("dialog",dialog=>{ diagnostics.push("Dialog: "+dialog.type()); void dialog.dismiss().catch(()=>{}); });
      context.on("page", popup => {
        if (popup === page) return;
        popupPages.push(popup);
        diagnostics.push("Popup opened: "+popup.url());
        popup.on("domcontentloaded",()=>{ if(!sameCouponSite(popup)) { diagnostics.push("Affiliate tab: "+popup.url()); void popup.close().catch(()=>{}); } });
        popup.on("dialog",dialog=>void dialog.dismiss().catch(()=>{}));
      });
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
      const readClipboardCode = async (preferred?: Page) => {
        const candidates = preferred
          ? [preferred]
          : [page!, ...popupPages].filter(p => !p.isClosed() && sameCouponSite(p)).slice(-1);
        for(const candidate of candidates) {
          if(candidate.isClosed() || !sameCouponSite(candidate)) continue;
          try {
            await candidate.waitForLoadState("domcontentloaded",{timeout:1200}).catch(()=>{});
            const copy = candidate.locator('button,a,[role="button"]').filter({hasText:/^\s*copy(?: code)?\s*$/i}).first();
            if(!await copy.count() || !await copy.isVisible().catch(()=>false)) continue;
            await copy.click({timeout:700,noWaitAfter:true});
            await delay(60);
            const value=(await candidate.evaluate(()=>navigator.clipboard.readText()).catch(()=>"")).trim();
            if(validCode(value)) {
              add([{code:value,evidence:"coupon COPY clipboard",method:"html"}]);
              diagnostics.push("Clipboard code on "+candidate.url()+": "+value);
              if(candidate !== page && !candidate.isClosed()) await candidate.close().catch(()=>{});
              return true;
            }
          } catch(error) {
            diagnostics.push("Clipboard read skipped: "+String(error).slice(0,100));
          }
        }
        return false;
      };
      const readModals = async () => {
        for(const candidate of [page!, ...popupPages]) {
          if(candidate.isClosed() || !sameCouponSite(candidate)) continue;
          const modal=await readAndCloseModal(candidate);
          if(modal.modalFound) {
            add(modal.codes);
            diagnostics.push("Modal on "+candidate.url()+": "+modal.codes.map(c=>c.code).join(",")+" closed="+modal.closed+" preview="+(modal.preview??"").slice(0,140));
          }
        }
      };
      const inspect = async () => {
        for (const candidate of [page!, ...popupPages]) {
          if (candidate.isClosed() || !sameCouponSite(candidate)) continue;
          try {
            await candidate.waitForLoadState("domcontentloaded",{timeout:3500}).catch(()=>{});
            const html = await candidate.content();
            add(parseCoupons(html).coupons);
            const visibleText = await candidate.locator("body").innerText({timeout:3000}).catch(()=>"");
            const dialogText = await candidate.locator('[role="dialog"],[aria-modal="true"]').allInnerTexts().catch(()=>[]);
            snapshots.push({url:candidate.url(),visibleText:visibleText.slice(0,12000),dialogText:dialogText.map(t=>t.slice(0,4000))});
            for(const text of [visibleText,...dialogText]) {
              for(const match of text.matchAll(codeNearLabel)) {
                const code=match[1];
                if(validCode(code))
                  add([{code,evidence:"visible coupon label",method:"html"}]);
              }
            }
            const values = await candidate.locator("[data-code],[data-coupon-code],[data-promo-code]").evaluateAll(els=>els.flatMap(el=>["data-code","data-coupon-code","data-promo-code"].map(k=>el.getAttribute(k)).filter((v):v is string=>Boolean(v))));
            for(const value of values) {
              if (/^[a-z0-9][a-z0-9_-]{3,24}$/i.test(value)) add([{code:value,evidence:"browser attribute",method:"html"}]);
            }
            diagnostics.push("Inspected "+candidate.url()+"; codes so far: "+codes.size);
          } catch (error) { diagnostics.push("Inspect failed: "+String(error).slice(0,120)); }
        }
      };
      await inspect();
      const buttons = page.locator('button,a,[role="button"]').filter({hasText:revealPattern});
      revealButtons = await buttons.count();
      diagnostics.push("Initial reveal candidates: "+revealButtons);
      // Keep track of actual DOM nodes clicked; re-query after every interaction.
      const clicked = new Set<string>();
      let popupCountBefore = 0;
      for(let step=0;step<maxClicks;step++) {
        if (new URL(page.url()).hostname !== new URL(result.url).hostname) {
          diagnostics.push("Merchant redirect detected; returning to coupon list");
          await page.goto(result.url,{waitUntil:"domcontentloaded",timeout:20000}).catch(()=>{});
          await delay(250);
        }
        const count = await buttons.count();
        let target: ReturnType<typeof buttons.nth> | undefined;
        let key = "";
        for(let i=0;i<Math.min(count,100);i++) {
          const el = buttons.nth(i);
          if (!await el.isVisible().catch(()=>false)) continue;
          const signature = await el.evaluate((node)=> {
            const rect = node.getBoundingClientRect();
            const href=node.getAttribute("href") ?? "";
            const parent=node.closest("[data-id],[data-offer-id],[data-coupon-id]");
            const stableId=parent?.getAttribute("data-id") ?? parent?.getAttribute("data-offer-id") ?? parent?.getAttribute("data-coupon-id") ?? "";
            return [stableId,href,node.textContent?.trim().slice(0,80),Math.round(rect.y/50)].join("|");
          }).catch(()=>"");
          if (!signature || clicked.has(signature)) continue;
          target=el;key=signature;break;
        }
        if(!target) break;
        clicked.add(key);
        attemptedClicks++;
        try {
          popupCountBefore = popupPages.length;
          await target.click({timeout:1800,noWaitAfter:true});
          await delay(250);
          const latestPopup = popupPages.length > popupCountBefore ? popupPages[popupPages.length-1] : undefined;
          const gotCode = await readClipboardCode(latestPopup);
          if(!gotCode) await readModals();
          diagnostics.push("Click "+attemptedClicks+": "+codes.size+" codes");
          for(let i=popupPages.length-1;i>=0;i--) if(popupPages[i].isClosed()) popupPages.splice(i,1);
        } catch(err) {
          diagnostics.push("Click "+attemptedClicks+" interrupted: "+String(err).slice(0,180));
          await delay(180);
          const latestPopup = popupPages.length ? popupPages[popupPages.length-1] : undefined;
          const gotCode = await readClipboardCode(latestPopup);
          if(!gotCode) await readModals();
          for(let i=popupPages.length-1;i>=0;i--) if(popupPages[i].isClosed()) popupPages.splice(i,1);
        }
      }
      await delay(150);
      await readClipboardCode();
      await readModals();
      diagnostics.push("Popup count: "+popupPages.length);
      screenshot = resolve(folder,id+".png");
      await page.screenshot({path:screenshot,fullPage:false,timeout:8000}).catch(()=>{ screenshot=undefined; });
      await writeFile(resolve(folder,id+".json"),JSON.stringify({url:result.url,finalUrl,pageTitle,httpStatus,revealButtons,attemptedClicks,popupUrls:popupPages.map(p=>p.url()),codes:[...codes.values()],snapshots:snapshots.slice(-30),diagnostics},null,2));
    } finally { await browser.close(); }
    const coupons=[...codes.values()];
    const restricted = httpStatus === 403 || httpStatus === 429;
    return {...base,httpStatus,finalUrl,pageTitle,revealButtons,attemptedClicks,screenshot,diagnostics,coupons,requires_browser:!coupons.length && revealButtons>0,status:coupons.length?"extracted":restricted?"blocked":revealButtons>0?"needs_browser":"no_code"};
  } catch(err) {
    return {...base,httpStatus,finalUrl,pageTitle,revealButtons,attemptedClicks,screenshot,diagnostics:[...diagnostics,String(err)],status:"error",error:err instanceof Error?err.message:String(err)};
  }
}
