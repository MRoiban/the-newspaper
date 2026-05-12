import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import puppeteer from "puppeteer";

const configPath = process.argv[2];
if (!configPath) {
  throw new Error("Usage: bun scripts/render-feed.mjs <config-path>");
}

const config = YAML.parse(await fs.readFile(configPath, "utf8"));
const publishedDir = config.publishedDir || "published";
const outputPath = path.join(publishedDir, `${feedSlug(config)}.xml`);
const maxItems = config.maxItems ?? 30;
const maxPages = config.pagination?.maxPages ?? 1;

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--disable-setuid-sandbox"]
});

try {
  const page = await browser.newPage();
  await page.setUserAgent("cloudrss-github-actions-renderer");
  await page.setViewport({ width: 1440, height: 1200 });

  const items = [];
  const seenItems = new Set();
  const seenPages = new Set();
  let pageUrl = config.url;

  for (let pageCount = 0; pageUrl && pageCount < maxPages && items.length < maxItems; pageCount += 1) {
    if (seenPages.has(pageUrl)) {
      break;
    }

    seenPages.add(pageUrl);
    await page.goto(pageUrl, { waitUntil: "networkidle2", timeout: 60000 });
    await waitForSelectorIfConfigured(page, config.waitFor || config.post.article);

    const result = await page.evaluate((cfg) => {
      const fieldValue = (root, rule, fallbackAttr) => {
        if (!rule) return undefined;
        const selector = typeof rule === "string" ? rule : rule.selector;
        const attr = typeof rule === "string" ? fallbackAttr : rule.attr ?? fallbackAttr;
        const element = root.querySelector(selector);
        if (!element) return undefined;
        if (attr) return element.getAttribute(attr) || undefined;
        return element.textContent?.replace(/\s+/g, " ").trim() || undefined;
      };

      const absolute = (value, base) => {
        if (!value) return undefined;
        try { return new URL(value, base).toString(); } catch { return undefined; }
      };

      const posts = Array.from(document.querySelectorAll(cfg.post.article)).map((article) => ({
        title: fieldValue(article, cfg.post.title),
        link: absolute(fieldValue(article, cfg.post.link, "href"), location.href),
        description: fieldValue(article, cfg.post.description),
        date: fieldValue(article, cfg.post.date),
        image: absolute(fieldValue(article, cfg.post.image, "src"), location.href)
      }));

      let nextUrl;
      if (cfg.pagination?.next) {
        nextUrl = absolute(fieldValue(document, cfg.pagination.next, "href"), location.href);
      }

      return { posts, nextUrl };
    }, config);

    for (const item of result.posts) {
      const title = cleanText(item.title);
      const link = cleanText(item.link);
      if (!title || !link || seenItems.has(link)) continue;

      seenItems.add(link);
      items.push({
        title,
        link,
        description: cleanText(item.description),
        pubDate: normalizeDate(item.date),
        image: cleanText(item.image)
      });

      if (items.length >= maxItems) break;
    }

    pageUrl = result.nextUrl && !seenPages.has(result.nextUrl) ? result.nextUrl : undefined;
  }

  if (items.length === 0) {
    throw new Error(`${configPath} produced no RSS items`);
  }

  await fs.mkdir(publishedDir, { recursive: true });
  await fs.writeFile(outputPath, buildRss(config, items), "utf8");
  console.log(`Wrote ${outputPath} with ${items.length} item(s)`);
} finally {
  await browser.close();
}

async function waitForSelectorIfConfigured(page, selector) {
  if (!selector) return;
  try {
    await page.waitForSelector(selector, { timeout: 30000 });
  } catch {
    await page.waitForNetworkIdle({ idleTime: 1000, timeout: 10000 }).catch(() => undefined);
  }
}

function buildRss(config, items) {
  const lastBuildDate = latestItemDate(items);
  const lastBuildDateTag = lastBuildDate ? `    <lastBuildDate>${escapeXml(lastBuildDate)}</lastBuildDate>\n` : "";
  const rssItems = items.map((item) => {
    const description = item.description ? `      <description>${escapeXml(item.description)}</description>\n` : "";
    const pubDate = item.pubDate ? `      <pubDate>${escapeXml(item.pubDate)}</pubDate>\n` : "";
    const media = item.image ? `      <media:content url="${escapeXml(item.image)}" medium="image" />\n` : "";

    return [
      "    <item>",
      `      <title>${escapeXml(item.title)}</title>`,
      `      <link>${escapeXml(item.link)}</link>`,
      `      <guid isPermaLink="true">${escapeXml(item.link)}</guid>`,
      description.trimEnd(),
      pubDate.trimEnd(),
      media.trimEnd(),
      "    </item>"
    ].filter(Boolean).join("\n");
  }).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">
  <channel>
    <title>${escapeXml(config.name)}</title>
    <link>${escapeXml(config.url)}</link>
    <description>${escapeXml(config.description ?? `Generated feed for ${config.name}`)}</description>
${lastBuildDateTag}${rssItems}
  </channel>
</rss>
`;
}

function feedSlug(config) {
  return (config.slug ?? config.name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeDate(input) {
  const cleaned = cleanText(input);
  if (!cleaned) return undefined;
  const date = new Date(cleaned);
  return Number.isNaN(date.getTime()) ? undefined : date.toUTCString();
}

function latestItemDate(items) {
  let latest = 0;
  for (const item of items) {
    if (!item.pubDate) continue;
    const time = new Date(item.pubDate).getTime();
    if (!Number.isNaN(time) && time > latest) latest = time;
  }
  return latest > 0 ? new Date(latest).toUTCString() : undefined;
}

function cleanText(input) {
  const cleaned = String(input ?? "").replace(/\s+/g, " ").trim();
  return cleaned || undefined;
}

function escapeXml(input) {
  return String(input)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
