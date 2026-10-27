import { chromium, type Page } from "playwright";
import type { Region } from "./search.js";

export type BrandConfig = { brand:string; website:string; countries:Region[] };
export type DealResult = {
  brand:string; country:Region; website:string;
  sale:{pageUrl?:string;lowestSalePrice?:number;highestSalePrice?:number;currency?:string;minDiscountPercent?:number;maxDiscountPercent?:number;dealText?:string};
  shipping:{found:boolean;sourceUrl?:string;dealText?:string};
  newsletter:{found:boolean;sourceUrl?:string;dealText?:string};
  diagnostics:string[];
};

const priceRe=/([$£€])\s?([0-9]+(?:[.,][0-9]{1,2})?)/g;
const pctRe=/(\d{1,2})%\s*off/i;
const clean=(s:string)=>s.replace(/\s+/g," ").trim();
const money=(text:string)=>[...text.matchAll(priceRe)].map(m=>({currency:m[1],value:Number(m[2].replace(",",""))})).filter(x=>Number.isFinite(x.value));
const clip=(s:string,n=220)=>clean(s).slice(0,n);
const localeByCountry:Record<Region,string>={US:"en-US",CA:"en-CA",UK:"en-GB",DE:"de-DE",FR:"fr-FR"};
const saleLinkRe:Record<Region,RegExp>={
  US:/sale|clearance|offers?|deals?/i,
  CA:/sale|clearance|offers?|deals?/i,
  UK:/sale|clearance|offers?|deals?/i,
  DE:/sale|angebote|rabatt|reduziert|schlussverkauf/i,
  FR:/soldes|promotions?|offres?|réduction/i
};
const shippingLinkRe:Record<Region,RegExp>={
  US:/shipping|delivery/i,
  CA:/shipping|delivery/i,
  UK:/shipping|delivery/i,
  DE:/versand|lieferung/i,
  FR:/livraison|expédition/i
};
const freeShippingRe:Record<Region,RegExp>={
  US:/free\s+(standard\s+)?shipping|free\s+delivery/i,
  CA:/free\s+(standard\s+)?shipping|free\s+delivery/i,
  UK:/free\s+(standard\s+)?shipping|free\s+delivery/i,
  DE:/kostenlos(?:er|e)?\s+versand|versandkostenfrei|kostenlose\s+lieferung/i,
  FR:/livraison\s+gratuite|expédition\s+gratuite/i
};
const signupRe:Record<Region,RegExp>={
  US:/(newsletter|sign up|email|sms|first order|new customer)/i,
  CA:/(newsletter|sign up|email|sms|first order|new customer)/i,
  UK:/(newsletter|sign up|email|sms|first order|new customer)/i,
  DE:/(newsletter|anmelden|e-?mail|sms|erste\s+bestellung|neukunde)/i,
  FR:/(newsletter|inscri(?:vez|ption)|e-?mail|sms|première\s+commande|nouveau\s+client)/i
};

async function dismissCommon(page:Page){
  for(const name of [/accept all/i,/accept cookies/i,/agree/i,/allow all/i]){
    const b=page.getByRole("button",{name}).first();
    if(await b.count()&&await b.isVisible().catch(()=>false)){await b.click({timeout:800}).catch(()=>{});break;}
  }
}
async function firstLink(page:Page,re:RegExp){
  const links=page.locator("a").filter({hasText:re});
  const n=Math.min(await links.count(),30);
  for(let i=0;i<n;i++){const a=links.nth(i);if(!await a.isVisible().catch(()=>false))continue;const href=await a.getAttribute("href");if(href){try{return new URL(href,page.url()).toString()}catch{}}}
}
async function bestSentence(page:Page,re:RegExp){
  const text=await page.locator("body").innerText({timeout:3000}).catch(()=>"");
  const parts=text.split(/(?<=[.!?])\s+|\n+/).map(clean).filter(Boolean);
  return parts.find(s=>re.test(s)&&s.length<260);
}

export async function inspectDeals(config:BrandConfig,country:Region,headed=false):Promise<DealResult>{
  const diagnostics:string[]=[];
  const browser=await chromium.launch({headless:!headed});
  const context=await browser.newContext({locale:localeByCountry[country],viewport:{width:1365,height:900}});
  const page=await context.newPage();
  const result:DealResult={brand:config.brand,country,website:config.website,sale:{},shipping:{found:false},newsletter:{found:false},diagnostics};
  try{
    await page.goto(config.website,{waitUntil:"domcontentloaded",timeout:25000});
    await dismissCommon(page);
    await page.waitForTimeout(1200);

    const homeText=await page.locator("body").innerText({timeout:3000}).catch(()=>"");
    const newsletterHome=homeText.split(/\n+/).map(clean).find(s => signupRe[country].test(s) && /%\s*(?:off|de|réduction)|[$£€]\s*\d+\s*(?:off|de réduction)|discount|save|rabatt|réduction|remise/i.test(s) && s.length < 260);
    if(newsletterHome){result.newsletter={found:true,sourceUrl:page.url(),dealText:clip(newsletterHome)};}

    const saleUrl=await firstLink(page,saleLinkRe[country]);
    if(saleUrl){
      result.sale.pageUrl=saleUrl;
      await page.goto(saleUrl,{waitUntil:"domcontentloaded",timeout:20000}).catch(()=>{});
      await page.waitForTimeout(900);
      const cards=page.locator("article,li,[class*=product],[class*=Product]");
      const n=Math.min(await cards.count(),250);
      const products:{sale:number;original:number;currency:string;discount:number}[]=[];
      for(let i=0;i<n;i++){
        const text=clip(await cards.nth(i).innerText().catch(()=>""),500);
        const prices=money(text);
        if(prices.length<2) continue;
        const vals=prices.map(p=>p.value).filter(v=>v>0);
        if(vals.length<2) continue;
        const original=Math.max(...vals), sale=Math.min(...vals);
        if(!(sale<original)) continue;
        const discount=Math.round((original-sale)/original*100);
        if(discount<=0||discount>=95) continue;
        products.push({sale,original,currency:prices[0].currency,discount});
      }
      if(products.length){
        const bySale=[...products].sort((a,b)=>a.sale-b.sale);
        result.sale.lowestSalePrice=bySale[0].sale;
        result.sale.highestSalePrice=bySale[bySale.length-1].sale;
        result.sale.currency=bySale[0].currency;
        result.sale.minDiscountPercent=Math.min(...products.map(p=>p.discount));
        result.sale.maxDiscountPercent=Math.max(...products.map(p=>p.discount));
        result.sale.dealText=`Save ${result.sale.minDiscountPercent}%–${result.sale.maxDiscountPercent}% on selected ${config.brand} sale items.`;
      } else {
        const body=await page.locator("body").innerText().catch(()=>"");
        const pct=[...body.matchAll(new RegExp(pctRe.source,"gi"))].map(m=>Number(m[1]));
        if(pct.length){result.sale.minDiscountPercent=Math.min(...pct);result.sale.maxDiscountPercent=Math.max(...pct);result.sale.dealText=`Save up to ${result.sale.maxDiscountPercent}% on selected ${config.brand} sale items.`;}
      }
    } else diagnostics.push("Sale page not found");

    await page.goto(config.website,{waitUntil:"domcontentloaded",timeout:15000}).catch(()=>{});
    const shippingUrl=await firstLink(page,shippingLinkRe[country]);
    if(shippingUrl){
      await page.goto(shippingUrl,{waitUntil:"domcontentloaded",timeout:15000}).catch(()=>{});
      const sentence=await bestSentence(page,freeShippingRe[country]);
      if(sentence) result.shipping={found:true,sourceUrl:page.url(),dealText:clip(sentence)};
      else {result.shipping.sourceUrl=page.url();diagnostics.push("Shipping page found, free-shipping text not verified");}
    } else {
      const sentence=await bestSentence(page,freeShippingRe[country]);
      if(sentence) result.shipping={found:true,sourceUrl:page.url(),dealText:clip(sentence)};
    }

    await page.goto(config.website,{waitUntil:"domcontentloaded",timeout:15000}).catch(()=>{});
    await page.waitForTimeout(1800);
    const newsletter=await bestSentence(page,new RegExp(`${signupRe[country].source}.*(%\\s*(?:off|de|réduction)|discount|save|rabatt|réduction|remise)|(%\\s*(?:off|de|réduction)|discount|save|rabatt|réduction|remise).*${signupRe[country].source}`,"i"));
    if(newsletter) result.newsletter={found:true,sourceUrl:page.url(),dealText:clip(newsletter)};
    if(!result.newsletter.found) diagnostics.push("Newsletter/new-customer discount not verified");
  } finally {await browser.close();}
  return result;
}
