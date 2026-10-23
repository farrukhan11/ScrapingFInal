import { load } from "cheerio";
import { isOfficialHost, type SearchResult } from "./search.js";

export type Category = "official" | "coupon" | "community" | "eligibility" | "other";
export type Coupon = { code: string; evidence: string; method: "html" | "json" };
export type Extraction = { url: string; brand: string; country: string; category: Category; status: "extracted" | "needs_browser" | "no_code" | "blocked" | "error" | "skipped"; requires_browser: boolean; coupons: Coupon[]; httpStatus?: number; error?: string };

const couponDomains = ["retailmenot.com","couponfollow.com","savings.com","marieclaire.com","coupons.com","rakuten.com","couponbirds.com"];
const eligibilityDomains = ["studentbeans.com","id.me","unidays.com"];
const communityDomains = ["reddit.com","quora.com"];
const hostMatches = (host: string, domain: string) => host === domain || host.endsWith("." + domain);
export function classify(result: SearchResult): Category {
  const host = new URL(result.url).hostname.toLowerCase();
  if (result.officialDomain && isOfficialHost(host, result.officialDomain)) return "official";
  if (couponDomains.some(d => hostMatches(host,d)) || /coupon|promo code|discount code|gutscheincode|code promo/i.test(result.title)) return "coupon";
  if (eligibilityDomains.some(d => hostMatches(host,d))) return "eligibility";
  if (communityDomains.some(d => hostMatches(host,d))) return "community";
  return "other";
}
const codePattern = /^[A-Z0-9][A-Z0-9_-]{3,24}$/i;
const stop = /^(SHOW|CODE|COUPON|DISCOUNT|WELCOME|PROMO|REVEAL|COPY|APPLY|SAVE|SHOP|OFFER|EXCLUSIVE|BUTTON|SUBMIT|GETCODE)$/i;
export function parseCoupons(html: string): { coupons: Coupon[]; revealDetected: boolean } {
  const $ = load(html);
  const found = new Map<string,Coupon>();
  function add(raw: string | undefined, method: Coupon["method"], evidence: string) {
    const code = (raw ?? "").trim().replace(/^["']|["']$/g,"");
    if (!codePattern.test(code) || stop.test(code) || !/[0-9]/.test(code) && code.length < 6) return;
    if (!found.has(code.toUpperCase())) found.set(code.toUpperCase(), { code, method, evidence });
  }
  $('[data-code], [data-coupon-code], [data-promo-code], [itemprop="discountCode"], .coupon-code, .promo-code').each((_,el) => {
    const node = $(el);
    const value = node.attr("data-code") ?? node.attr("data-coupon-code") ?? node.attr("data-promo-code") ?? node.attr("content") ?? node.text();
    if (value && value.trim().split(/\s+/).length === 1) add(value, "html", "coupon element");
  });
  $('script[type="application/ld+json"],script[type="application/json"],script#__NEXT_DATA__').each((_,el) => {
    const raw = $(el).html() ?? "";
    if (raw.length > 2_000_000) return;
    try {
      const walk = (value: unknown, depth = 0) => {
        if (depth > 18 || value === null || typeof value !== "object") return;
        for (const [key,child] of Object.entries(value)) {
          if (/^(couponCode|promoCode|discountCode|voucherCode)$/i.test(key) && typeof child === "string") add(child,"json",key);
          else walk(child,depth+1);
        }
      };
      walk(JSON.parse(raw));
    } catch { /* malformed embedded JSON */ }
  });
  const revealDetected = $('button,a,[role="button"]').toArray().some(el => /show code|reveal code|get code|unlock code|view code/i.test($(el).text() + " " + ($(el).attr("aria-label") ?? "")));
  return { coupons: [...found.values()], revealDetected };
}
export async function extractPage(result: SearchResult, fetcher: typeof fetch = fetch): Promise<Extraction> {
  const category = classify(result);
  const base = { url: result.url, brand: result.brand, country: result.country, category, requires_browser: false, coupons: [] as Coupon[] };
  if (category === "community" || category === "eligibility") return { ...base, status: "skipped" };
  try {
    const response = await fetcher(result.url, { headers: { "User-Agent": "ScrapingFinal/0.2 (+static coupon research)", Accept: "text/html" }, signal: AbortSignal.timeout(15000), redirect: "follow" });
    if (response.status === 403 || response.status === 429) return { ...base, status: "blocked", httpStatus: response.status };
    if (!response.ok) return { ...base, status: "error", httpStatus: response.status, error: `HTTP ${response.status}` };
    const type = response.headers.get("content-type") ?? "";
    if (!type.includes("text/html")) return { ...base, status: "no_code", httpStatus: response.status };
    const html = (await response.text()).slice(0,2_000_000);
    const { coupons, revealDetected } = parseCoupons(html);
    return { ...base, coupons, requires_browser: revealDetected && coupons.length === 0, status: coupons.length ? "extracted" : revealDetected ? "needs_browser" : "no_code", httpStatus: response.status };
  } catch(error) {
    return { ...base, status: "error", error: error instanceof Error ? error.message : String(error) };
  }
}
