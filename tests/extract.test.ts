import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, parseCoupons, extractPage } from "../src/extract.js";
import { isOfficialHost, type SearchResult } from "../src/search.js";
const item: SearchResult = {brand:"Citizen Watch",country:"US",keyword:"Citizen Watch coupon code",position:1,title:"Coupons",url:"https://www.retailmenot.com/view/citizenwatch.com",snippet:"",officialDomain:"citizenwatch.com"};
test("official subdomains but not lookalikes",()=>{
 assert.equal(isOfficialHost("support.citizenwatch.com","citizenwatch.com"),true);
 assert.equal(isOfficialHost("citizenwatch.com.evil.test","citizenwatch.com"),false);
});
test("classifies coupon source",()=>assert.equal(classify(item),"coupon"));
test("extracts explicit HTML and JSON codes",()=>{
 const parsed=parseCoupons('<span data-code="SAVE20"></span><script type="application/ld+json">{"promoCode":"EXTRA15"}</script>');
 assert.deepEqual(parsed.coupons.map(x=>x.code),["SAVE20","EXTRA15"]);
});
test("marks reveal required",async()=>{
 const mock=async()=>new Response('<html><button>Show Code</button></html>',{headers:{"content-type":"text/html"}});
 const result=await extractPage(item,mock as typeof fetch);
 assert.equal(result.status,"needs_browser");
 assert.equal(result.requires_browser,true);
});
