import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

type ResultRow={url:string;status:string;codes:string[]};
type CrawlResult={brand:string;country:string;results:ResultRow[]};
type BenchmarkSource={urlPrefix:string;status:string;codes:string[]};
type Benchmark={brand:string;country:string;sources:BenchmarkSource[]};

const norm=(s:string)=>s.trim().toUpperCase();

async function main(){
  const args=process.argv.slice(2);
  const value=(f:string)=>{const i=args.indexOf(f);return i>=0?args[i+1]:undefined};
  const actualPath=value("--actual");
  const benchmarkPath=value("--benchmark");
  if(!actualPath || !benchmarkPath) throw new Error("Usage: pnpm coupon-parity --actual output/crawlee-dansko-latest.json --benchmark benchmarks/dansko-gemini.json");

  const actual:CrawlResult=JSON.parse(await readFile(resolve(actualPath),"utf8"));
  const benchmark:Benchmark=JSON.parse(await readFile(resolve(benchmarkPath),"utf8"));

  let tp=0,fp=0,fn=0,statusMatches=0;
  const sources=benchmark.sources.map(source=>{
    const row=actual.results.find(r=>r.url.startsWith(source.urlPrefix));
    const expected=new Set(source.codes.map(norm));
    const got=new Set((row?.codes??[]).map(norm));
    const matched=[...expected].filter(c=>got.has(c));
    const missing=[...expected].filter(c=>!got.has(c));
    const extra=[...got].filter(c=>!expected.has(c));
    tp+=matched.length; fn+=missing.length; fp+=extra.length;
    const statusMatch=(row?.status??"missing")===source.status;
    if(statusMatch) statusMatches++;
    return {
      urlPrefix:source.urlPrefix,
      expectedStatus:source.status,
      actualStatus:row?.status??"missing",
      statusMatch,
      expectedCodes:[...expected],
      actualCodes:[...got],
      matchedCodes:matched,
      missingCodes:missing,
      extraCodes:extra
    };
  });

  const precision=(tp+fp)?tp/(tp+fp):1;
  const recall=(tp+fn)?tp/(tp+fn):1;
  const f1=(precision+recall)?2*precision*recall/(precision+recall):0;
  const result={
    brand:benchmark.brand,
    country:benchmark.country,
    benchmarkSources:benchmark.sources.length,
    statusMatches,
    statusAccuracy:statusMatches/benchmark.sources.length,
    truePositiveCodes:tp,
    falsePositiveCodes:fp,
    falseNegativeCodes:fn,
    precision,
    recall,
    f1,
    exactParity:fp===0 && fn===0 && statusMatches===benchmark.sources.length,
    sources
  };
  console.log(JSON.stringify(result,null,2));
}
main().catch(err=>{console.error(err);process.exit(1)});
