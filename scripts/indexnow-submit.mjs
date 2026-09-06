#!/usr/bin/env node
/**
 * Canonical per-site submitter. Copy this into a site repo as
 * `scripts/indexnow-submit.mjs` and keep `npm run submit:indexnow` pointing at
 * it, so the command operators already type does not change.
 *
 * Canonical source: push-indexer/scripts/site-submit.mjs. Re-copy to update.
 *
 * WHY THIS REPLACED THE DIRECT PING
 *
 * The previous version POSTed the whole sitemap straight to api.indexnow.org.
 * That delivers, but it leaves no record: nothing can later answer "was this
 * page ever pushed, and what did Bing say?" Routing through push-indexer adds
 * a durable job, per-engine attempt evidence, retries and dead-lettering, a
 * 24h dedupe window, Google/WebSub on the same submission, and a revocable
 * per-site credential. Delivery is unchanged; the evidence is the point.
 *
 * A direct IndexNow ping from here would also still work, because this Mac has
 * residential egress. Do not "simplify" the Worker into calling IndexNow
 * itself: IndexNow returns 429 to Cloudflare's egress range (measured
 * 2026-09-05 across three hosts). That is why a relay exists at all.
 *
 * CREDENTIALS: PUSH_INDEXER_URL, PUSH_INDEXER_SITE, PUSH_INDEXER_KEY, read
 * from the environment or a .env beside the repo root. Never commit .env.
 *
 * USAGE
 *   node scripts/indexnow-submit.mjs                    # sitemap, guarded
 *   node scripts/indexnow-submit.mjs --changed HEAD~1   # only changed pages
 *   node scripts/indexnow-submit.mjs --dry              # print, do not submit
 *   node scripts/indexnow-submit.mjs --force            # bypass the size guard
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Refuse an accidental full-portfolio replay. On 2026-08-27 a ~4,760-URL
 * sitemap replay was queued while the relay runner was asleep; 4,598 rows
 * aged past the dead-letter TTL and were never delivered. Small sitemaps are
 * harmless to replay because push-indexer dedupes them, so the guard only
 * trips on genuinely large sets, and --changed is the real answer for those.
 */
const MAX_URLS_WITHOUT_FORCE = 100;
const CONCURRENCY = 4;
const TIMEOUT_MS = 20_000;

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

/** Minimal .env reader: no dependency, and `--env-file` is not on every Node here. */
async function loadDotEnv() {
  const path = join(repoRoot, '.env');
  if (!existsSync(path)) return;
  for (const line of (await readFile(path, 'utf8')).split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const value = match[2].trim().replace(/^["']|["']$/g, '');
    if (!(match[1] in process.env)) process.env[match[1]] = value;
  }
}

function git(args) {
  try {
    return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

async function sitemapUrls() {
  const candidates = ['sitemap.xml', 'dist/sitemap.xml', 'out/sitemap.xml', 'public/sitemap.xml'];
  const found = candidates.map((c) => join(repoRoot, c)).find((p) => existsSync(p));
  if (!found) fail(`no sitemap found (looked for ${candidates.join(', ')}); build first?`);
  const xml = await readFile(found, 'utf8');
  const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
  if (urls.length === 0) fail(`no <loc> entries in ${found}`);
  return urls;
}

/**
 * Map changed repo files to canonical URLs by intersecting with the sitemap,
 * rather than guessing a path->URL rule. Each site lays its files out
 * differently; the sitemap is the site's own statement of what its URLs are,
 * so anything not in it was never a public page.
 */
function changedUrls(baseRef, allUrls) {
  const diff = git(['diff', '--name-only', `${baseRef}..HEAD`]);
  if (!diff) return [];
  const changedFiles = diff.split('\n').filter(Boolean);
  const bySuffix = new Map();
  for (const url of allUrls) {
    let path = new URL(url).pathname.replace(/^\//, '');
    if (path === '' || path.endsWith('/')) path += 'index.html';
    bySuffix.set(path, url);
  }
  const matched = new Set();
  for (const file of changedFiles) {
    if (bySuffix.has(file)) matched.add(bySuffix.get(file));
  }
  return [...matched];
}

async function submit(url, { base, site, key, deployId }) {
  const response = await fetch(`${base}/v1/submissions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': `${deployId}:${url}`,
    },
    body: JSON.stringify({ site, url, action: 'updated' }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

async function main() {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry');
  const force = args.includes('--force');
  const changedAt = args.indexOf('--changed');
  const baseRef = changedAt !== -1 ? args[changedAt + 1] : null;
  if (changedAt !== -1 && !baseRef) fail('--changed needs a base ref, e.g. --changed HEAD~1');

  await loadDotEnv();
  const base = process.env.PUSH_INDEXER_URL;
  const site = process.env.PUSH_INDEXER_SITE;
  const key = process.env.PUSH_INDEXER_KEY;
  if (!base || !site || !key) {
    fail('PUSH_INDEXER_URL, PUSH_INDEXER_SITE and PUSH_INDEXER_KEY are required (put them in .env)');
  }

  const all = await sitemapUrls();
  let urls = all;
  if (baseRef) {
    urls = changedUrls(baseRef, all);
    if (urls.length === 0) {
      console.log(`no sitemap URLs changed since ${baseRef}; nothing to submit`);
      return;
    }
    console.log(`${urls.length} of ${all.length} URLs changed since ${baseRef}`);
  }

  if (urls.length > MAX_URLS_WITHOUT_FORCE && !force) {
    fail(
      `refusing to submit ${urls.length} URLs at once.\n` +
        `  Use --changed <ref> to submit only what this deploy touched,\n` +
        `  or --force if a full replay is genuinely intended.\n` +
        `  A ${urls.length}-URL replay is what dead-lettered 4,598 rows on 2026-08-27.`
    );
  }

  // A stable deploy id makes the idempotency key meaningful: a re-run of the
  // same deploy replays the same durable jobs instead of minting new ones.
  const deployId = process.env.DEPLOY_ID || git(['rev-parse', '--short', 'HEAD']) || `manual-${Date.now()}`;

  if (dry) {
    console.log(`[dry] would submit ${urls.length} URL(s) for ${site} as deploy ${deployId}:`);
    for (const url of urls) console.log(`  ${url}`);
    return;
  }

  console.log(`submitting ${urls.length} URL(s) for ${site} (deploy ${deployId})`);
  const counts = { accepted: 0, cached: 0, failed: 0 };
  const failures = [];
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, urls.length) }, async () => {
      while (index < urls.length) {
        const url = urls[index++];
        try {
          const body = await submit(url, { base, site, key, deployId });
          body.cached || body.replayed ? (counts.cached += 1) : (counts.accepted += 1);
        } catch (error) {
          counts.failed += 1;
          failures.push(`${url}: ${error.message}`);
        }
      }
    })
  );

  console.log(`accepted=${counts.accepted} cached=${counts.cached} failed=${counts.failed}`);
  // A green deploy with silently missing indexing evidence is worse than a red
  // one, so any failure fails the step.
  if (counts.failed > 0) {
    for (const failure of failures.slice(0, 10)) console.error(`  ${failure}`);
    process.exit(1);
  }
  console.log('IndexNow delivery is asynchronous: these are queued, not yet accepted by Bing.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
