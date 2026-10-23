import type { Page } from "playwright";
import type { Coupon } from "./extract.js";

const invalid = /^(?:choose|select|your|the|offer|deals|shop|click|here|copy|apply|show|reveal|code|coupon|promo|discount|voucher|save|terms|details|now|today|shipping|claim)$/i;
const valid = (s: string) => /^[a-z0-9][a-z0-9_-]{3,24}$/i.test(s) && !invalid.test(s) && (/[0-9]/.test(s) || s === s.toUpperCase());
export type ModalResult = { codes: Coupon[]; modalFound: boolean; closed: boolean; preview?: string };

export async function readAndCloseModal(page: Page): Promise<ModalResult> {
  if (page.isClosed()) return {codes:[],modalFound:false,closed:false};
  const raw = await page.evaluate(() => {
    const visible = (el: Element) => {
      const r=el.getBoundingClientRect(), st=getComputedStyle(el);
      return r.width>0 && r.height>0 && st.visibility!=="hidden" && st.display!=="none";
    };
    const selectors=['[role="dialog"]','[aria-modal="true"]','dialog[open]','[class*="modal"]','[class*="Modal"]','[class*="popup"]','[class*="Popup"]'];
    const candidates=Array.from(document.querySelectorAll(selectors.join(","))).filter(visible);
    const modal=candidates.find(el => /\bcopy\b/i.test(el.textContent??"") && /code|coupon|promo|discount/i.test(el.textContent??""))
      ?? candidates.find(el=>/\bcopy\b/i.test(el.textContent??""));
    if(!modal) return {found:false,text:"",tokens:[] as string[]};
    const text=(modal as HTMLElement).innerText.slice(0,3000);
    const tokens:string[]=[];
    for(const el of Array.from(modal.querySelectorAll("button,[role=button],input,[data-code],[class*=code],[class*=Code],span,div"))) {
      if(!visible(el)) continue;
      const value=(el.getAttribute("data-code")??el.getAttribute("data-coupon-code")??el.getAttribute("value")??(el as HTMLElement).innerText??"").trim();
      if(value.length<=30 && value.split(/\s+/).length===1) tokens.push(value);
    }
    return {found:true,text,tokens};
  }).catch(()=>({found:false,text:"",tokens:[] as string[]}));
  if(!raw.found) return {codes:[],modalFound:false,closed:false};
  const candidates = raw.tokens.filter(valid);
  const codes:Coupon[]=[];
  for(const code of new Set(candidates)) {
    // Require the coupon token to appear adjacent to a COPY control in modal text.
    if(!raw.text.includes(code) || !/\bcopy\b/i.test(raw.text)) continue;
    codes.push({code,evidence:"visible reveal modal",method:"html"});
  }
  const close = page.locator('[role="dialog"] button,[aria-modal="true"] button,dialog[open] button,[class*="modal"] button,[class*="Modal"] button').filter({hasText:/^(?:×|x|close)$/i}).first();
  let closed=false;
  if(await close.count() && await close.isVisible().catch(()=>false)) {
    closed=await close.click({timeout:1500}).then(()=>true).catch(()=>false);
  } else {
    const labelled=page.getByRole("button",{name:/^(?:close|dismiss|×)$/i}).first();
    if(await labelled.count() && await labelled.isVisible().catch(()=>false)) closed=await labelled.click({timeout:1500}).then(()=>true).catch(()=>false);
  }
  if(!closed) { await page.keyboard.press("Escape").catch(()=>{}); }
  return {codes,modalFound:true,closed,preview:raw.text.slice(0,500)};
}
