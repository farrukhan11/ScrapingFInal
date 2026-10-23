import { chromium, type BrowserContext, type Page } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { classify, parseCoupons, type Coupon, type Extraction } from "./extract.js";
import type { SearchResult } from "./search.js";
import { readAndCloseModal } from "./modal.js";

const revealPattern = /(?:show|reveal|view|unlock|get|copy)\s+(?:(?:promo|coupon|discount|voucher)\s+)?code/i;
const consentPattern = /^(?:accept all|accept cookies|agree|allow all)$/i;
const maxClicks = 30;
const maxCodesPerSite = 10;
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
            await candidate.waitForLoadState("domcontentloaded",{timeout:1800}).catch(()=>{});
            const copy = candidate.locator('button,a,[role="button"]').filter({hasText:/^\s*copy(?: code)?\s*$/i}).first();
            await copy.waitFor({state:"visible",timeout:2200}).catch(()=>{});
            if(!await copy.count() || !await copy.isVisible().catch(()=>false)) continue;
            await copy.click({timeout:900,noWaitAfter:true,force:true});
            await delay(90);
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
      const directRevealUrls: string[] = [];
      const activeRevealButtons = () => page.locator('button,a,[role="button"]').filter({hasText:revealPattern}).filter({hasNot: page.locator('text=/offer expired|expired/i')});
      const buttons = activeRevealButtons();
      revealButtons = await buttons.count();
      diagnostics.push("Initial active reveal candidates: "+revealButtons+"; max codes: "+maxCodesPerSite);
      // Stable fallback: process reveal buttons sequentially.
      // The popup wait is registered before click, matching Playwright's recommended pattern.
      const processedRevealIds = new Set<string>();
      let scanIndex = 0;
      const maxAttempts = Math.min(Math.max(revealButtons, 12), 30);

      for(let attempt=0; attempt<maxAttempts && codes.size < maxCodesPerSite; attempt++) {
        // Restore coupon list only when the opener actually navigated away.
        if (new URL(page.url()).hostname.replace(/^www\./,"") !== siteHost) {
          const back = await page.goBack({waitUntil:"domcontentloaded",timeout:3000}).catch(()=>null);
          if(!back || new URL(page.url()).hostname.replace(/^www\./,"") !== siteHost) {
            await page.goto(result.url,{waitUntil:"domcontentloaded",timeout:7000}).catch(()=>{});
          }
          await delay(100);
        }

        const freshButtons = activeRevealButtons();
        const count = await freshButtons.count();
        if(!count) break;

        const index = scanIndex % count;
        scanIndex++;
        const target = freshButtons.nth(index);
        if(!await target.isVisible().catch(()=>false)) continue;
        const expired = await target.evaluate(node => {
          let el: Element | null = node;
          for(let i=0;i<5 && el;i++,el=el.parentElement) {
            const text=(el.textContent??"").replace(/\s+/g," ").toLowerCase();
            if(/offer expired|expired/.test(text)) return true;
          }
          return false;
        }).catch(()=>false);
        if(expired) {
          diagnostics.push("Expired offer skipped at index "+index);
          continue;
        }

        attemptedClicks++;
        try {
          const popupPromise = page.waitForEvent("popup",{timeout:2200}).catch(()=>undefined);
          await target.scrollIntoViewIfNeeded().catch(()=>{});
          await target.click({timeout:1200,noWaitAfter:true,force:true});
          const popup = await popupPromise;

          if(!popup) {
            const gotInPlace = await readClipboardCode(page);
            if(!gotInPlace) await readModals();
            diagnostics.push("Click "+attemptedClicks+" in-place: "+codes.size+" codes");
            continue;
          }

          await popup.waitForLoadState("domcontentloaded",{timeout:2200}).catch(()=>{});
          await popup.waitForURL(/visibleMatchId|seenMatchId/,{timeout:1800}).catch(()=>{});
          const revealId = (() => {
            try {
              const u = new URL(popup.url());
              return u.searchParams.get("visibleMatchId")
                ?? u.searchParams.get("seenMatchId")
                ?? u.searchParams.get("u")
                ?? (u.origin + u.pathname + u.hash)
                ?? u.toString();
            } catch { return popup.url(); }
          })();

          if(processedRevealIds.has(revealId)) {
            diagnostics.push("Duplicate reveal skipped: "+revealId);
            if(!popup.isClosed()) await popup.close().catch(()=>{});
            continue;
          }
          processedRevealIds.add(revealId);

          let gotCode = await readClipboardCode(popup);
          if(!gotCode) {
            await delay(350);
            gotCode = await readClipboardCode(popup);
          }
          if(!gotCode) {
            const modal = await readAndCloseModal(popup);
            if(modal.codes.length) add(modal.codes);
          }
          diagnostics.push("Reveal "+revealId+": "+codes.size+" codes");
          if(!popup.isClosed()) await popup.close().catch(()=>{});
        } catch(err) {
          diagnostics.push("Click "+attemptedClicks+" skipped: "+String(err).slice(0,120));
        }
      }

      const skipClickFallback = true;
      if(!skipClickFallback) {
        await delay(80);
        await readClipboardCode();
        await readModals();
      }
      diagnostics.push("Popup count: "+popupPages.length);
      screenshot = resolve(folder,id+".png");
      await page.screenshot({path:screenshot,fullPage:false,timeout:8000}).catch(()=>{ screenshot=undefined; });
      await writeFile(resolve(folder,id+".json"),JSON.stringify({url:result.url,finalUrl,pageTitle,httpStatus,revealButtons,attemptedClicks,popupUrls:popupPages.map(p=>p.url()),codes:[...codes.values()],snapshots:snapshots.slice(-30),diagnostics},null,2));
    } finally { await browser.close(); }
    const coupons=[...codes.values()].slice(0,maxCodesPerSite);
    const restricted = httpStatus === 403 || httpStatus === 429;
    return {...base,httpStatus,finalUrl,pageTitle,revealButtons,attemptedClicks,screenshot,diagnostics,coupons,requires_browser:!coupons.length && revealButtons>0,status:coupons.length?"extracted":restricted?"blocked":revealButtons>0?"needs_browser":"no_code"};
  } catch(err) {
    return {...base,httpStatus,finalUrl,pageTitle,revealButtons,attemptedClicks,screenshot,diagnostics:[...diagnostics,String(err)],status:"error",error:err instanceof Error?err.message:String(err)};
  }
}
