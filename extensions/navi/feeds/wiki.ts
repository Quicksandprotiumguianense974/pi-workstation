/**
 * NAVI System — Wikipedia Knowledge Feed
 * Random article discovery
 */

import { WikiEntry, FeedCache } from "../types";

const cache: FeedCache<WikiEntry> = {
	items: [],
	lastFetch: 0,
	index: 0,
	lastRotate: 0,
};

export async function fetchWikiEntries(): Promise<WikiEntry[]> {
	const out: WikiEntry[] = [];
	const seen = new Set<string>();

	for (let i = 0; i < 4; i++) {
		try {
			const res = await fetch("https://en.wikipedia.org/api/rest_v1/page/random/summary");
			if (!res.ok) continue;
			const data = await res.json();

			const title = typeof data?.title === "string" ? data.title.trim() : "";
			const description = typeof data?.description === "string" ? data.description.trim() : "";
			const url = typeof data?.content_urls?.desktop?.page === "string"
				? data.content_urls.desktop.page
				: title ? `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/\s+/g, "_"))}`
				: "";

			if (!title || !url || seen.has(url)) continue;
			seen.add(url);
			out.push({ title, description, url });
		} catch {}
	}
	return out;
}

export async function refreshWiki(force = false): Promise<WikiEntry | null> {
	const now = Date.now();

	if (force || cache.items.length === 0 || now - cache.lastFetch > 60 * 60 * 1000) {
		const entries = await fetchWikiEntries();
		if (entries.length > 0) {
			cache.items = entries;
			cache.index = 0;
			cache.lastFetch = now;
		}
	}

	if (now - cache.lastRotate > 20_000 && cache.items.length > 0) {
		cache.index = (cache.index + 1) % cache.items.length;
		cache.lastRotate = now;
	}

	return cache.items[cache.index] || null;
}

export function getCurrentWiki(): WikiEntry | null {
	return cache.items[cache.index] || null;
}
