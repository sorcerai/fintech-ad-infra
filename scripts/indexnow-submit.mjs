// Submit all sitemap URLs to IndexNow (Bing, Yandex, Seznam, etc.)
import { readdir, readFile } from "node:fs/promises";

// Dynamically locate the IndexNow verification file in root
const rootUrl = new URL("../", import.meta.url);
const files = await readdir(rootUrl);
const keyFile = files.find((f) => /^[a-f0-9]{32}\.txt$/.test(f));
if (!keyFile) throw new Error("IndexNow key file not found in root");

const key = (await readFile(new URL(keyFile, rootUrl), "utf8")).trim();

const xml = await readFile(new URL("sitemap.xml", rootUrl), "utf8");
const urlList = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
if (urlList.length === 0) throw new Error("no <loc> URLs found in sitemap.xml");

const parsed = new URL(urlList[0]);
const host = parsed.host;

console.log(`Submitting ${urlList.length} URLs for ${host} to IndexNow...`);
const res = await fetch("https://api.indexnow.org/indexnow", {
  method: "POST",
  headers: { "Content-Type": "application/json; charset=utf-8" },
  body: JSON.stringify({
    host,
    key,
    keyLocation: `https://${host}/${key}.txt`,
    urlList,
  }),
});

console.log(`Submitted ${urlList.length} URLs → ${res.status} ${res.statusText}`);
const text = await res.text();
if (text) console.log(`Response: ${text}`);
if (!res.ok && res.status !== 202) process.exit(1);
