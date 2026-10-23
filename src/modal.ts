import type { Page } from "playwright";
import type { Coupon } from "./extract.js";

const stop = /^(?:choose|select|your|the|offer|deals|shop|click|here|copy|apply|show|reveal|code|coupon|promo|discount|voucher|save|terms|details|now|today|shipping|claim|citizen)$/i;
export const isLikelyCode = (value:string) => /^[a-z0-9][a-z0-9_-]{3,24}$/i.test(value) && !stop.test(value) && (/[0-9]/.test(value) || value === value.toUpperCase());
export type ModalResult = {codes:Coupon[];modalFound:boolean;closed:boolean;preview?:string};

export async function readAndCloseModal(page:Page):Promise<ModalResult> {
 if(page.isClosed()) return {codes:[],modalFound:false,closed:false};
 const raw=await page.evaluate(() => {
   const visible=(el:Element)=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>0&&r.height>0&&s.visibility!=="hidden"&&s.display!=="none"};
   const explicit=Array.from(document.querySelectorAll('[role="dialog"],[aria-modal="true"],dialog[open],[class*="modal"],[class*="Modal"],[class*="popup"],[class*="Popup"]')).filter(visible);
   const copyControls=Array.from(document.querySelectorAll('button,[role="button"],a')).filter(el=>visible(el)&&/^\s*copy(?:\s+code)?\s*$/i.test(el.textContent??""));
   const containers:Element[]=[...explicit];
   // Sites frequently use unlabelled modal divs. Walk upwards from COPY to find a compact coupon panel.
   for(const copy of copyControls) {
     let ancestor:Element|null=copy.parentElement;
     for(let level=0;level<5&&ancestor;level++,ancestor=ancestor.parentElement) {
       const text=(ancestor as HTMLElement).innerText??"";
       const rect=ancestor.getBoundingClientRect();
       if(rect.width>=200&&rect.width<=900&&text.length>=15&&text.length<=1200&&/coupon|code|promo|discount|claim/i.test(text)) {containers.push(ancestor);break;}
     }
   }
   const candidates=containers.filter(el=>visible(el)).map(el=>({el,text:((el as HTMLElement).innerText??"").slice(0,1600)}))
     .filter(x=>/\bcopy\b/i.test(x.text)&&/coupon|code|promo|discount|claim/i.test(x.text))
     .sort((a,b)=>a.text.length-b.text.length);
   const best=candidates[0];
   if(!best) return {found:false,text:"",tokens:[] as string[]};
   const tokens:string[]=[];
   const nodes=Array.from(best.el.querySelectorAll("input,[data-code],[data-coupon-code],[data-promo-code],button,span,div,strong,b"));
   for(const node of nodes) {
     if(!visible(node)) continue;
     const val=(node.getAttribute("data-code")??node.getAttribute("data-coupon-code")??node.getAttribute("data-promo-code")??node.getAttribute("value")??(node as HTMLElement).innerText??"").trim();
     if(val.length>=4&&val.length<=25&&!/\s/.test(val)) tokens.push(val);
   }
   return {found:true,text:best.text,tokens};
 }).catch(()=>({found:false,text:"",tokens:[] as string[]}));
 if(!raw.found) return {codes:[],modalFound:false,closed:false};
 const copyIndex=raw.text.search(/\bCOPY\b/i);
 const prefix=copyIndex>=0?raw.text.slice(0,copyIndex):raw.text;
 const tokens=[...new Set(raw.tokens.filter(t=>isLikelyCode(t)&&prefix.includes(t)))];
 // Prefer code immediately before COPY. Do not emit unrelated tokens from page headers.
 const code=tokens.sort((a,b)=>prefix.lastIndexOf(b)-prefix.lastIndexOf(a))[0];
 const codes:Coupon[]=code?[{code,evidence:"visible coupon modal adjacent to COPY",method:"html"}]:[];
 let closed=false;
 const close=page.getByRole("button",{name:/^(?:close|dismiss|×|x)$/i}).first();
 if(await close.count()&&await close.isVisible().catch(()=>false)) closed=await close.click({timeout:1500}).then(()=>true).catch(()=>false);
 if(!closed) await page.keyboard.press("Escape").catch(()=>{});
 return {codes,modalFound:true,closed,preview:raw.text.slice(0,450)};
}
