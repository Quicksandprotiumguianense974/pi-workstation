import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { MusicItem, MusicLibrary, MusicRuntimeState } from "./music-types";

const MUSIC_DIR = join(homedir(), ".pi", "agent", "music");
const LIBRARY_PATH = join(MUSIC_DIR, "library.json");
const RUNTIME_PATH = join(MUSIC_DIR, "runtime.json");

const MAX_HISTORY_ITEMS = 200;

function ensureDir(): void {
	mkdirSync(MUSIC_DIR, { recursive: true });
}

function readJson<T>(filePath: string, fallback: T): T {
	if (!existsSync(filePath)) return fallback;
	try {
		return JSON.parse(readFileSync(filePath, "utf8")) as T;
	} catch {
		return fallback;
	}
}

function writeJson(filePath: string, value: unknown): void {
	ensureDir();
	const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
	writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	renameSync(tempPath, filePath);
}

function normalizeItem(item: MusicItem): MusicItem {
	return {
		...item,
		addedAt: item.addedAt || Date.now(),
	};
}

function dedupeItems(items: MusicItem[]): MusicItem[] {
	const seen = new Set<string>();
	const out: MusicItem[] = [];
	for (const item of items) {
		const key = item.inputUrl;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(normalizeItem(item));
	}
	return out;
}

export function createEmptyLibrary(): MusicLibrary {
	return {
		version: 1,
		watchlist: [],
		bandcampWatchlist: [],
		favorites: [],
		history: [],
	};
}

export function createEmptyRuntime(): MusicRuntimeState {
	return {
		version: 1,
		queue: [],
		paused: false,
	};
}

export function loadLibrary(): MusicLibrary {
	const library = readJson<MusicLibrary>(LIBRARY_PATH, createEmptyLibrary());
	return {
		version: 1,
		watchlist: Array.from(new Set((library.watchlist || []).map((name) => name.trim()).filter(Boolean))).sort(),
		bandcampWatchlist: Array.from(new Set((library.bandcampWatchlist || []).map((name) => name.trim()).filter(Boolean))).sort(),
		favorites: dedupeItems(library.favorites || []),
		history: dedupeItems(library.history || []).slice(0, MAX_HISTORY_ITEMS),
	};
}

export function saveLibrary(library: MusicLibrary): void {
	writeJson(LIBRARY_PATH, {
		version: 1,
		watchlist: Array.from(new Set(library.watchlist.map((name) => name.trim()).filter(Boolean))).sort(),
		bandcampWatchlist: Array.from(new Set(library.bandcampWatchlist.map((name) => name.trim()).filter(Boolean))).sort(),
		favorites: dedupeItems(library.favorites),
		history: dedupeItems(library.history).slice(0, MAX_HISTORY_ITEMS),
	});
}

export function loadRuntime(): MusicRuntimeState {
	const runtime = readJson<MusicRuntimeState>(RUNTIME_PATH, createEmptyRuntime());
	return {
		version: 1,
		current: runtime.current ? normalizeItem(runtime.current) : undefined,
		queue: dedupeItems(runtime.queue || []),
		paused: Boolean(runtime.paused),
		lastPositionSeconds: runtime.lastPositionSeconds,
	};
}

export function saveRuntime(runtime: MusicRuntimeState): void {
	writeJson(RUNTIME_PATH, {
		version: 1,
		current: runtime.current ? normalizeItem(runtime.current) : undefined,
		queue: dedupeItems(runtime.queue),
		paused: runtime.paused,
		lastPositionSeconds: runtime.lastPositionSeconds,
	});
}

export function addToHistory(library: MusicLibrary, item: MusicItem): MusicLibrary {
	const history = [normalizeItem(item), ...library.history.filter((entry) => entry.inputUrl !== item.inputUrl)].slice(
		0,
		MAX_HISTORY_ITEMS,
	);
	return { ...library, history };
}

export function isFavorite(library: MusicLibrary, item: MusicItem): boolean {
	return library.favorites.some((entry) => entry.inputUrl === item.inputUrl);
}

export function toggleFavorite(library: MusicLibrary, item: MusicItem): MusicLibrary {
	if (isFavorite(library, item)) {
		return {
			...library,
			favorites: library.favorites.filter((entry) => entry.inputUrl !== item.inputUrl),
		};
	}
	return {
		...library,
		favorites: [normalizeItem(item), ...library.favorites.filter((entry) => entry.inputUrl !== item.inputUrl)],
	};
}

export function addWatchAccount(library: MusicLibrary, username: string): MusicLibrary {
	const trimmed = username.trim().replace(/^@/, "");
	if (!trimmed) return library;
	return {
		...library,
		watchlist: Array.from(new Set([...library.watchlist, trimmed])).sort(),
	};
}

export function removeWatchAccount(library: MusicLibrary, username: string): MusicLibrary {
	return {
		...library,
		watchlist: library.watchlist.filter((entry) => entry !== username),
	};
}

export function addBandcampAccount(library: MusicLibrary, account: string): MusicLibrary {
	const trimmed = account.trim();
	if (!trimmed) return library;
	return {
		...library,
		bandcampWatchlist: Array.from(new Set([...library.bandcampWatchlist, trimmed])).sort(),
	};
}

export function removeBandcampAccount(library: MusicLibrary, account: string): MusicLibrary {
	return {
		...library,
		bandcampWatchlist: library.bandcampWatchlist.filter((entry) => entry !== account),
	};
}
