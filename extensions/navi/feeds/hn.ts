/**
 * NAVI System — Hacker News Signal Feed
 * Tech intelligence stream
 */

import { HNStory, FeedCache } from "../types";

const cache: FeedCache<HNStory> = {
	items: [],
	lastFetch: 0,
	index: 0,
	lastRotate: 0,
};

export async function fetchHNStories(): Promise<HNStory[]> {
	try {
		const res = await fetch("https://hacker-news.firebaseio.com/v0/topstories.json");
		if (!res.ok) return [];
		const ids: number[] = await res.json();

		const stories = await Promise.all(
			ids.slice(0, 20).map(async (id) => {
				try {
					const r = await fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`);
					if (!r.ok) return null;
					const i = await r.json();

					let domain: string | undefined;
					try {
						domain = i.url ? new URL(i.url).hostname.replace(/^www\./, "") : undefined;
					} catch {}

					return {
						id: i.id,
						title: i.title,
						score: i.score,
						url: i.url,
						by: i.by,
						descendants: i.descendants,
						domain,
					} as HNStory;
				} catch {
					return null;
				}
			})
		);

		return stories.filter((s): s is HNStory => s !== null);
	} catch {
		return [];
	}
}

export async function refreshHN(): Promise<HNStory | null> {
	const now = Date.now();

	if (now - cache.lastFetch > 15 * 60 * 1000 || cache.items.length === 0) {
		const stories = await fetchHNStories();
		if (stories.length > 0) {
			cache.items = stories;
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

export function getCurrentHN(): HNStory | null {
	return cache.items[cache.index] || null;
}

export function getHNIndex(): string {
	if (cache.items.length === 0) return "0/0";
	return `${cache.index + 1}/${cache.items.length}`;
}
