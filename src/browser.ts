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
      // Keep the coupon-list tab stable. Reveal clicks often try to navigate the
      // opener to the merchant while opening the code in a same-site popup.
      // Abort only off-site top-level document navigations on the master page.
      await page.route("**/*", async route => {
        const req = route.request();
        if (req.isNavigationRequest() && req.frame() === page!.mainFrame()) {
          try {
            const host = new URL(req.url()).hostname.replace(/^www\./,"");
            if (host !== siteHost) {
              diagnostics.push("Blocked master-tab merchant navigation: "+req.url());
              await route.abort();
              return;
            }
          } catch {}
        }
        await route.continue();
      });
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
      // Fast path: many coupon sites expose a stable reveal URL/offer id in the DOM.
      // Process unique reveal targets directly to avoid affiliate redirects and duplicate clicks.
      const directRevealUrls = await page.evaluate((baseUrl) => {
        const base = new URL(baseUrl);
        const out = new Set<string>();
        const els = Array.from(document.querySelectorAll('a,button,[role="button"],[data-match-id],[data-offer-id],[data-id]'));
        for (const el of els) {
          const text = (el.textContent ?? "") + " " + (el.getAttribute("aria-label") ?? "");
          const attrs = Array.from(el.attributes).map(a => [a.name,a.value] as const);
          const href = el.getAttribute("href");
          if (href) {
            try {
              const u = new URL(href, base);
              if (u.hostname === base.hostname && (u.searchParams.has("visibleMatchId") || u.searchParams.has("seenMatchId"))) out.add(u.toString());
            } catch {}
          }
          if (!/(?:show|reveal|view|unlock|get|copy)\s+(?:(?:promo|coupon|discount|voucher)\s+)?code/i.test(text)) continue;
          for (const [name,value] of attrs) {
            if (!/match.?id|offer.?id|coupon.?id/i.test(name) || !/^\d{5,}$/.test(value)) continue;
            const u = new URL(base);
            u.searchParams.set("seenMatchId",value);
            u.searchParams.set("visibleMatchId",value);
            out.add(u.toString());
          }
        }
        return [...out];
      }, result.url).catch(()=>[] as string[]);
      if (directRevealUrls.length) {
        diagnostics.push("Direct reveal targets: "+directRevealUrls.length);
        const seenTargets = new Set<string>();
        for (const revealUrl of directRevealUrls.slice(0,50)) {
          const id = new URL(revealUrl).searchParams.get("visibleMatchId") ?? revealUrl;
          if (seenTargets.has(id)) continue;
          seenTargets.add(id);
          attemptedClicks++;
          const worker = await context.newPage();
          try {
            await worker.goto(revealUrl,{waitUntil:"domcontentloaded",timeout:8000});
            const got = await readClipboardCode(worker);
            if (!got) {
              const modal = await readAndCloseModal(worker);
              if (modal.codes.length) add(modal.codes);
              diagnostics.push("Direct target "+id+": "+(modal.codes.map(c=>c.code).join(",") || "no code"));
            } else {
              diagnostics.push("Direct target "+id+": clipboard code captured");
            }
          } catch (error) {
            diagnostics.push("Direct target "+id+" failed: "+String(error).slice(0,120));
          } finally {
            if (!worker.isClosed()) await worker.close().catch(()=>{});
          }
        }
      }
      const buttons = page.locator('button,a,[role="button"]').filter({hasText:revealPattern});
      revealButtons = await buttons.count();
      diagnostics.push("Initial reveal candidates: "+revealButtons);
      // Fallback for sites that do not expose reveal targets in markup.
      // Re-query the DOM every iteration and track processed reveal IDs from popups.
      const processedRevealIds = new Set<string>();
      const skipClickFallback = directRevealUrls.length > 0 && codes.size > 0;
      let scanIndex = 0;
      for(let step=0;!skipClickFallback && step<maxClicks;step++) {
        if (new URL(page.url()).hostname !== new URL(result.url).hostname) {
          diagnostics.push("Unexpected master-tab navigation; restoring coupon list");
          await page.goto(result.url,{waitUntil:"domcontentloaded",timeout:8000}).catch(()=>{});
          await delay(120);
        }

        // Fresh locator after every navigation/re-render.
        const freshButtons = page.locator('button,a,[role="button"]').filter({hasText:revealPattern});
        const count = await freshButtons.count();
        if (!count) break;

        let target: ReturnType<typeof freshButtons.nth> | undefined;
        let targetIndex = -1;
        for(let offset=0; offset<count; offset++) {
          const i=(scanIndex+offset)%count;
          const el=freshButtons.nth(i);
          if(!await el.isVisible().catch(()=>false)) continue;
          target=el;targetIndex=i;break;
        }
        if(!target || targetIndex<0) break;
        scanIndex=(targetIndex+1)%Math.max(count,1);
        attemptedClicks++;

        const beforePages = new Set(context.pages());
        try {
          await target.scrollIntoViewIfNeeded().catch(()=>{});
          const popupPromise = page.waitForEvent("popup",{timeout:1200}).catch(()=>undefined);
          await target.dispatchEvent("click");
          const popup = await popupPromise;
          await delay(80);

          const candidate = popup ?? context.pages().find(p=>!beforePages.has(p) && p!==page);
          if(candidate) {
            await candidate.waitForLoadState("domcontentloaded",{timeout:1200}).catch(()=>{});
            const revealId = (()=>{try{return new URL(candidate.url()).searchParams.get("visibleMatchId") ?? new URL(candidate.url()).searchParams.get("seenMatchId") ?? candidate.url();}catch{return candidate.url();}})();
            if(processedRevealIds.has(revealId)) {
              diagnostics.push("Duplicate reveal skipped: "+revealId);
              if(!candidate.isClosed()) await candidate.close().catch(()=>{});
              continue;
            }
            processedRevealIds.add(revealId);
            const gotCode = await readClipboardCode(candidate);
            if(!gotCode) {
              const modal=await readAndCloseModal(candidate);
              if(modal.codes.length) add(modal.codes);
            }
            if(!candidate.isClosed()) await candidate.close().catch(()=>{});
            diagnostics.push("Click "+attemptedClicks+": "+codes.size+" codes");
            continue;
          }

          // Some sites reveal in-place without a popup.
          const gotCode = await readClipboardCode(page);
          if(!gotCode) await readModals();
          diagnostics.push("Click "+attemptedClicks+": "+codes.size+" codes");
        } catch(err) {
          diagnostics.push("Click "+attemptedClicks+" skipped: "+String(err).slice(0,140));
        }
      }
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
    const coupons=[...codes.values()];
    const restricted = httpStatus === 403 || httpStatus === 429;
    return {...base,httpStatus,finalUrl,pageTitle,revealButtons,attemptedClicks,screenshot,diagnostics,coupons,requires_browser:!coupons.length && revealButtons>0,status:coupons.length?"extracted":restricted?"blocked":revealButtons>0?"needs_browser":"no_code"};
  } catch(err) {
    return {...base,httpStatus,finalUrl,pageTitle,revealButtons,attemptedClicks,screenshot,diagnostics:[...diagnostics,String(err)],status:"error",error:err instanceof Error?err.message:String(err)};
  }
}
