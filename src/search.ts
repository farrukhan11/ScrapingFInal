import { z } from "zod";

export const regions = {
  US: { gl: "us", hl: "en", suffix: "coupon code" },
  UK: { gl: "uk", hl: "en", suffix: "discount code" },
  DE: { gl: "de", hl: "de", suffix: "Rabattcode" },
  FR: { gl: "fr", hl: "fr", suffix: "code promo" },
} as const;
export type Region = keyof typeof regions;
export const regionNames = Object.keys(regions) as Region[];

const organicSchema = z.object({
  organic: z.array(z.object({
    title: z.string().optional(),
    link: z.string(),
    position: z.number().optional(),
    snippet: z.string().optional(),
  })).default([]),
});

export type SearchResult = {
  brand: string; country: Region; keyword: string;
  position: number; title: string; url: string; snippet: string;
  officialDomain?: string; isOfficialWebsite?: boolean;
};
export function normalizeUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|gclid$|fbclid$)/i.test(key)) url.searchParams.delete(key);
    }
    return url.toString();
  } catch { return null; }
}
export function buildKeyword(brand: string, country: Region): string {
  return `${brand.trim()} ${regions[country].suffix}`;
}
export function isOfficialHost(hostname: string, domain: string): boolean {
  const host = hostname.toLowerCase().replace(/^www\./, "");
  return host === domain || host.endsWith(`.${domain}`);
}
export function normalizeOfficialDomain(input: string): string {
  const raw = input.trim();
  if (!raw) throw new Error('Website must not be empty');
  const parsed = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname.includes('.')) throw new Error('Invalid official website');
  return parsed.hostname.toLowerCase().replace(/^www\./, '');
}
export async function searchBrand(
  brand: string, country: Region, apiKey: string,
  fetcher: typeof fetch = fetch,
  officialWebsite?: string
): Promise<SearchResult[]> {
  if (!brand.trim()) throw new Error("Brand must not be empty");
  if (!apiKey.trim()) throw new Error("SERPER_API_KEY is required");
  const keyword = buildKeyword(brand, country);
  const officialDomain = officialWebsite ? normalizeOfficialDomain(officialWebsite) : undefined;
  const region = regions[country];
  let response: Response | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      response = await fetcher("https://google.serper.dev/search", {
        method: "POST",
        headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ q: keyword, gl: region.gl, hl: region.hl, num: 10 }),
        signal: AbortSignal.timeout(20000),
      });
      if (response.ok) break;
      if (![429, 500, 502, 503, 504].includes(response.status) || attempt === 2)
        throw new Error(`Serper HTTP ${response.status}`);
    } catch (error) {
      if (attempt === 2) throw error;
      if (response && ![429, 500, 502, 503, 504].includes(response.status)) throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** attempt));
  }
  if (!response?.ok) throw new Error("Serper request failed");
  const parsed = organicSchema.parse(await response.json());
  const seen = new Set<string>();
  return parsed.organic.slice(0, 10).flatMap((item, index) => {
    const url = normalizeUrl(item.link);
    if (!url || seen.has(url)) return [];
    seen.add(url);
    return [{
      brand, country, keyword, position: item.position ?? index + 1,
      title: item.title ?? "", url, snippet: item.snippet ?? "",
      ...(officialDomain ? { officialDomain, isOfficialWebsite: isOfficialHost(new URL(url).hostname, officialDomain) } : {}),
    }];
  });
}
