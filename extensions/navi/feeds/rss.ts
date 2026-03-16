/**
 * NAVI System — RSS Stream Feed
 * Aggregated blog sources
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { RSSPost, FeedCache, FeedSource } from "../types";
import { Sources, Paths } from "../config";

const cache: FeedCache<RSSPost> = {
	items: [],
	lastFetch: 0,
	index: 0,
	lastRotate: 0,
};

let feedUrls: FeedSource[] = [];

// OPML fetch
export async function fetchOPML(): Promise<FeedSource[]> {
	try {
		const res = await fetch(Sources.opml);
		if (!res.ok) return [];
		const text = await res.text();

		const feeds: FeedSource[] = [];
		const outlineRe = /<outline[^>]+xmlUrl="([^"]+)"[^>]*/g;
		let m: RegExpExecArray | null;

		while ((m = outlineRe.exec(text)) !== null) {
			const xmlUrl = m[1];
			const textM = m[0].match(/\btext="([^"]+)"/);
			feeds.push({ xmlUrl, site: textM ? textM[1] : xmlUrl });
		}

		return dedupeFeeds(feeds);
	} catch {
		return [];
	}
}

// Custom feeds config
export function loadRSSFeedsConfig(): { feeds: FeedSource[]; disabled: string[] } {
	try {
		const raw = JSON.parse(fs.readFileSync(Paths.rssFeeds, "utf-8"));
		return {
			feeds: Array.isArray(raw?.feeds)
				? dedupeFeeds(raw.feeds.filter((f: any) => typeof f?.xmlUrl === "string"))
				: [],
			disabled: Array.isArray(raw?.disabled) ? raw.disabled : [],
		};
	} catch {
		return { feeds: [], disabled: [] };
	}
}

export function saveRSSFeedsConfig(config: { feeds: FeedSource[]; disabled: string[] }) {
	try {
		fs.mkdirSync(path.dirname(Paths.rssFeeds), { recursive: true });
		fs.writeFileSync(Paths.rssFeeds, JSON.stringify(config, null, 2));
	} catch {}
}

function dedupeFeeds(feeds: FeedSource[]): FeedSource[] {
	const seen = new Set<string>();
	return feeds.filter((f) => {
		const key = f.xmlUrl.trim().replace(/\/+$/, "");
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

// RSS parsing
function decodeHtml(text: string): string {
	return text
		.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
		.replace(/<[^>]+>/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&#39;/g, "'")
		.replace(/&quot;/g, '"')
		.replace(/&nbsp;/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function parseRSS(xml: string, site: string): RSSPost[] {
	const posts: RSSPost[] = [];

	// RSS items
	const itemRe = /<item[\s>]([\s\S]*?)<\/item>/gi;
	let im: RegExpExecArray | null;

	while ((im = itemRe.exec(xml)) !== null && posts.length < 3) {
		const body = im[1];
		const t = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
		const l = body.match(/<link[^>]*>([\s\S]*?)<\/link>/i);
		const d = body.match(/<description[^>]*>([\s\S]*?)<\/description>/i) ||
			body.match(/<content:encoded[^>]*>([\s\S]*?)<\/content:encoded>/i);
		const p = body.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i);

		if (t) {
			posts.push({
				title: decodeHtml(t[1]),
				url: l ? decodeHtml(l[1]) : "",
				site,
				summary: d ? decodeHtml(d[1]) : undefined,
				published: p ? decodeHtml(p[1]) : undefined,
			});
		}
	}

	// Atom entries
	const entryRe = /<entry[\s>]([\s\S]*?)<\/entry>/gi;
	while ((im = entryRe.exec(xml)) !== null && posts.length < 3) {
		const body = im[1];
		const t = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
		const l = body.match(/<link[^>]*href="([^"]+)"/i);
		const s = body.match(/<summary[^>]*>([\s\S]*?)<\/summary>/i) ||
			body.match(/<content[^>]*>([\s\S]*?)<\/content>/i);
		const p = body.match(/<published[^>]*>([\s\S]*?)<\/published>/i) ||
			body.match(/<updated[^>]*>([\s\S]*?)<\/updated>/i);

		if (t) {
			posts.push({
				title: decodeHtml(t[1]),
				url: l ? l[1].trim() : "",
				site,
				summary: s ? decodeHtml(s[1]) : undefined,
				published: p ? decodeHtml(p[1]) : undefined,
			});
		}
	}

	return posts;
}

// Ensure feed URLs loaded
async function ensureFeeds(force = false): Promise<FeedSource[]> {
	if (feedUrls.length > 0 && !force) return feedUrls;

	const opml = await fetchOPML();
	const config = loadRSSFeedsConfig();
	const disabled = new Set(config.disabled);

	feedUrls = dedupeFeeds([...config.feeds, ...opml]).filter(
		(f) => !disabled.has(f.xmlUrl.trim().replace(/\/+$/, ""))
	);

	return feedUrls;
}

// Fetch RSS batch
async function fetchRSSBatch(feeds: FeedSource[]): Promise<RSSPost[]> {
	const shuffled = [...feeds].sort(() => Math.random() - 0.5).slice(0, 8);
	const all: RSSPost[] = [];

	await Promise.all(
		shuffled.map(async (f) => {
			try {
				const ac = new AbortController();
				const to = setTimeout(() => ac.abort(), 5000);
				const res = await fetch(f.xmlUrl, { signal: ac.signal });
				clearTimeout(to);

				if (!res.ok) return;
				all.push(...parseRSS(await res.text(), f.site));
			} catch {}
		})
	);

	return all;
}

// Load from cache
function loadCache(): { posts: RSSPost[]; ts: number } | null {
	try {
		return JSON.parse(fs.readFileSync(Paths.rssCache, "utf-8"));
	} catch {
		return null;
	}
}

function saveCache(posts: RSSPost[]) {
	try {
		fs.mkdirSync(path.dirname(Paths.rssCache), { recursive: true });
		fs.writeFileSync(Paths.rssCache, JSON.stringify({ posts, ts: Date.now() }));
	} catch {}
}

// Main refresh
export async function refreshRSS(force = false): Promise<RSSPost | null> {
	const now = Date.now();
	await ensureFeeds(force);

	if (cache.items.length === 0) {
		const cached = loadCache();
		if (cached && now - cached.ts < 30 * 60 * 1000 && !force) {
			cache.items = cached.posts;
			cache.lastFetch = cached.ts;
		}
	}

	if (force || (now - cache.lastFetch > 30 * 60 * 1000 && feedUrls.length > 0)) {
		const posts = await fetchRSSBatch(feedUrls);
		if (posts.length > 0) {
			// Merge and dedupe
			const seen = new Set<string>();
			const merged: RSSPost[] = [];
			for (const p of [...posts, ...cache.items]) {
				const key = p.url || p.title;
				if (!seen.has(key)) {
					seen.add(key);
					merged.push(p);
				}
			}
			cache.items = pickRecent(merged, 50);
			cache.index = 0;
			saveCache(cache.items);
			cache.lastFetch = now;
		}
	}

	if (now - cache.lastRotate > 15_000 && cache.items.length > 0) {
		cache.index = (cache.index + 1) % cache.items.length;
		cache.lastRotate = now;
	}

	return cache.items[cache.index] || null;
}

function pickRecent(posts: RSSPost[], limit: number): RSSPost[] {
	const now = Date.now();
	const sevenDays = 7 * 24 * 60 * 60 * 1000;

	const withTs = posts.map((p) => ({
		post: p,
		ts: p.published ? new Date(p.published).getTime() : 0,
	}));

	const recent = withTs
		.filter((e) => e.ts > 0 && now - e.ts <= sevenDays)
		.sort((a, b) => b.ts - a.ts);

	const older = withTs
		.filter((e) => e.ts === 0 || now - e.ts > sevenDays)
		.sort((a, b) => b.ts - a.ts);

	const head = recent.slice(0, 20).map((e) => e.post);
	const tail = older
		.slice(0, limit - head.length)
		.sort(() => Math.random() - 0.5)
		.map((e) => e.post);

	return [...head, ...tail].slice(0, limit);
}

export function getCurrentRSS(): RSSPost | null {
	return cache.items[cache.index] || null;
}

// Feed management commands
export async function addFeed(url: string, site?: string): Promise<boolean> {
	const trimmed = url.trim();
	if (!trimmed) return false;

	let siteName = site?.trim();
	if (!siteName) {
		try {
			const u = new URL(trimmed);
			siteName = u.hostname.replace(/^www\./, "");
		} catch {
			return false;
		}
	}

	const config = loadRSSFeedsConfig();
	const normalized = trimmed.replace(/\/+$/, "");

	if (config.feeds.some((f) => f.xmlUrl.trim().replace(/\/+$/, "") === normalized)) {
		return false;
	}

	config.feeds.unshift({ xmlUrl: normalized, site: siteName });
	config.disabled = config.disabled.filter((u) => u !== normalized);
	saveRSSFeedsConfig(config);
	feedUrls = [];
	return true;
}

export async function removeFeed(target: string): Promise<boolean> {
	const trimmed = target.trim();
	if (!trimmed) return false;

	const config = loadRSSFeedsConfig();
	const feeds = await ensureFeeds(true);

	let selected: FeedSource | undefined;
	const idx = Number(trimmed);
	if (Number.isFinite(idx) && idx >= 1 && idx <= feeds.length) {
		selected = feeds[idx - 1];
	} else {
		const normalized = trimmed.replace(/\/+$/, "");
		selected = feeds.find((f) => f.xmlUrl.trim().replace(/\/+$/, "") === normalized);
	}

	if (!selected) return false;

	const normalized = selected.xmlUrl.trim().replace(/\/+$/, "");
	const beforeLen = config.feeds.length;
	config.feeds = config.feeds.filter((f) => f.xmlUrl.trim().replace(/\/+$/, "") !== normalized);

	if (config.feeds.length === beforeLen) {
		config.disabled = [...new Set([...config.disabled, normalized])];
	}

	saveRSSFeedsConfig(config);
	feedUrls = [];
	return true;
}
