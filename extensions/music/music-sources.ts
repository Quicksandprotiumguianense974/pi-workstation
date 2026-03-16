import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { MusicItem, MusicSection, MusicSource, NtsNowPlaying } from "./music-types";

const execFileAsync = promisify(execFile);

const NTS_STREAMS: Record<"1" | "2", string> = {
	"1": "https://stream-relay-geo.ntslive.net/stream",
	"2": "https://stream-relay-geo.ntslive.net/stream2",
};

interface YtDlpEntry {
	id?: string;
	title?: string;
	webpage_url?: string;
	original_url?: string;
	uploader?: string;
	uploader_id?: string;
	channel?: string;
	artist?: string;
	album?: string;
	album_artist?: string;
	duration?: number;
	thumbnail?: string;
	url?: string;
	tags?: string[];
	entries?: YtDlpEntry[];
}

interface MixcloudCloudcast {
	url: string;
	name: string;
	audio_length?: number;
	pictures?: { large?: string; medium?: string };
	tags?: Array<{ name?: string }>;
	sections?: Array<Record<string, unknown>>;
	user?: {
		username?: string;
		name?: string;
	};
}

interface MixcloudListResponse {
	data: MixcloudCloudcast[];
	paging?: {
		next?: string;
		previous?: string;
	};
}

interface NtsTracklistEntry {
	artist?: string;
	artist_name?: string;
	title?: string;
	track_name?: string;
	offset?: number;
	start_time?: number;
	position?: number;
	seconds?: number;
}

interface NtsScheduleBroadcast {
	broadcast_title?: string;
	links?: Array<{ rel?: string; href?: string }>;
}

interface NtsScheduleDay {
	date?: string;
	broadcasts?: NtsScheduleBroadcast[];
}

interface MixcloudPage {
	items: MusicItem[];
	nextUrl?: string;
	previousUrl?: string;
}

interface CacheEntry<T> {
	value: T;
	expiresAt: number;
}

const ntsScheduleCache = new Map<"1" | "2", Promise<NtsScheduleDay[]>>();
const mixcloudDetailsCache = new Map<string, CacheEntry<MixcloudCloudcast>>();
const mixcloudSectionsCache = new Map<string, CacheEntry<MusicSection[]>>();
const bandcampAccountCache = new Map<string, CacheEntry<MusicItem[]>>();
const bandcampReleaseCache = new Map<string, CacheEntry<MusicItem[]>>();
let ytDlpCheck: Promise<void> | undefined;

const CACHE_TTL = {
	mixcloudDetailsMs: 5 * 60_000,
	mixcloudSectionsMs: 30 * 60_000,
	bandcampAccountMs: 10 * 60_000,
	bandcampReleaseMs: 30 * 60_000,
} as const;

function makeItemId(source: MusicSource, inputUrl: string): string {
	return `${source}:${inputUrl}`.replace(/[^a-zA-Z0-9:_/-]/g, "_");
}

function isUrl(value: string): boolean {
	return /^https?:\/\//i.test(value.trim());
}

function normalizeBandcampAccount(input: string): string {
	const trimmed = input.trim();
	if (!trimmed) throw new Error("Missing Bandcamp account");
	if (isUrl(trimmed)) {
		const url = new URL(trimmed);
		return `https://${url.hostname}/music`;
	}
	const host = trimmed.replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
	const normalizedHost = host.includes(".bandcamp.com") ? host : `${host}.bandcamp.com`;
	return `https://${normalizedHost}/music`;
}

function getBandcampAccountLabel(input: string): string {
	try {
		return new URL(normalizeBandcampAccount(input)).hostname.replace(/\.bandcamp\.com$/i, "");
	} catch {
		return input.trim();
	}
}

function titleFromBandcampUrl(inputUrl: string): string | undefined {
	try {
		const pathname = new URL(inputUrl).pathname;
		const slug = pathname.split("/").filter(Boolean).at(-1);
		if (!slug) return undefined;
		return decodeURIComponent(slug)
			.replace(/[-_]+/g, " ")
			.replace(/\s+/g, " ")
			.trim();
	} catch {
		return undefined;
	}
}

function detectSource(input: string): MusicSource {
	const value = input.trim().toLowerCase();
	if (value === "nts" || value === "nts1" || value === "nts2") return "nts";
	if (value.includes("mixcloud.com")) return "mixcloud";
	if (value.includes("bandcamp.com")) return "bandcamp";
	if (value.includes("youtube.com") || value.includes("youtu.be")) return "youtube";
	return "youtube";
}

async function fetchJson<T>(url: string): Promise<T> {
	const response = await fetch(url, {
		headers: {
			"user-agent": "Mozilla/5.0",
			accept: "application/json",
		},
	});
	if (!response.ok) {
		throw new Error(`Request failed (${response.status}) for ${url}`);
	}
	return (await response.json()) as T;
}

function getCachedValue<T>(cache: Map<string, CacheEntry<T>>, key: string): T | undefined {
	const entry = cache.get(key);
	if (!entry) return undefined;
	if (entry.expiresAt <= Date.now()) {
		cache.delete(key);
		return undefined;
	}
	return entry.value;
}

function setCachedValue<T>(cache: Map<string, CacheEntry<T>>, key: string, value: T, ttlMs: number): T {
	cache.set(key, {
		value,
		expiresAt: Date.now() + ttlMs,
	});
	return value;
}

async function ensureYtDlpAvailable(): Promise<void> {
	ytDlpCheck ??= execFileAsync("yt-dlp", ["--version"], { timeout: 5_000 })
		.then(() => undefined)
		.catch(() => {
			throw new Error("yt-dlp is required for music playback and search. Install it and make sure it is on PATH.");
		});
	return await ytDlpCheck;
}

function getMixcloudApiUrl(inputUrl: string): string {
	return `https://api.mixcloud.com${new URL(inputUrl).pathname.replace(/\/?$/, "/")}`;
}

async function getMixcloudDetails(inputUrl: string): Promise<MixcloudCloudcast> {
	const cached = getCachedValue(mixcloudDetailsCache, inputUrl);
	if (cached) return cached;
	const details = await fetchJson<MixcloudCloudcast>(getMixcloudApiUrl(inputUrl));
	return setCachedValue(mixcloudDetailsCache, inputUrl, details, CACHE_TTL.mixcloudDetailsMs);
}

async function extractPlaylistWithYtDlp(input: string): Promise<YtDlpEntry> {
	await ensureYtDlpAvailable();
	try {
		const { stdout } = await execFileAsync(
			"yt-dlp",
			["-J", "--no-warnings", input],
			{ timeout: 60_000, maxBuffer: 32 * 1024 * 1024 },
		);
		return JSON.parse(stdout) as YtDlpEntry;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`yt-dlp could not load "${input}": ${message}`);
	}
}

async function extractFlatPlaylistWithYtDlp(input: string): Promise<YtDlpEntry> {
	await ensureYtDlpAvailable();
	try {
		const { stdout } = await execFileAsync(
			"yt-dlp",
			["-J", "--flat-playlist", "--no-warnings", input],
			{ timeout: 60_000, maxBuffer: 16 * 1024 * 1024 },
		);
		return JSON.parse(stdout) as YtDlpEntry;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`yt-dlp could not load "${input}": ${message}`);
	}
}

function mapNtsTracklistEntry(entry: NtsTracklistEntry): MusicSection | undefined {
	const title = String(entry.title ?? entry.track_name ?? "").trim();
	if (!title) return undefined;
	const artist = String(entry.artist ?? entry.artist_name ?? "").trim() || undefined;
	const startSeconds = Number(entry.offset ?? entry.start_time ?? entry.position ?? entry.seconds ?? 0);
	return {
		startSeconds: Number.isFinite(startSeconds) ? startSeconds : 0,
		title,
		artist,
	};
}

function getCurrentNtsSection(sections: MusicSection[], startTimestamp: string | undefined): MusicSection | undefined {
	if (sections.length === 0) return undefined;
	if (!startTimestamp) return sections.at(-1);
	const startedAt = Date.parse(startTimestamp);
	if (Number.isNaN(startedAt)) return sections.at(-1);
	const elapsedSeconds = Math.max(0, (Date.now() - startedAt) / 1000);
	let current = sections[0];
	for (const section of sections) {
		if (section.startSeconds <= elapsedSeconds) current = section;
		else break;
	}
	return current;
}

function mapMixcloudSectionEntry(entry: Record<string, unknown>): MusicSection | undefined {
	const startSeconds = Number(entry.start_time ?? entry.start ?? entry.offset ?? entry.position ?? entry.seconds ?? 0);
	const title = String(entry.name ?? entry.song ?? entry.title ?? "").trim();
	const artist = String(entry.artist ?? entry.creator ?? "").trim() || undefined;
	if (!title) return undefined;
	return {
		startSeconds: Number.isFinite(startSeconds) ? startSeconds : 0,
		title,
		artist,
	};
}

function normalizeTitleForMatch(value: string): string {
	return value
		.toLowerCase()
		.replace(/\bwith\b/g, "w")
		.replace(/w\//g, "w")
		.replace(/&amp;/g, "and")
		.replace(/&/g, "and")
		.replace(/[()'".,!?_-]+/g, " ")
		.replace(/\$/g, "s")
		.replace(/\s+/g, " ")
		.trim();
}

function parseMixcloudBroadcastDate(title: string): string | undefined {
	const match = title.match(/ - (\d{1,2})(st|nd|rd|th) ([A-Za-z]+) (\d{4})$/);
	if (!match) return undefined;
	const normalized = `${match[1]} ${match[3]} ${match[4]}`;
	const parsed = new Date(`${normalized} 12:00:00 UTC`);
	if (Number.isNaN(parsed.getTime())) return undefined;
	return parsed.toISOString().slice(0, 10);
}

function stripMixcloudDateSuffix(title: string): string {
	return title.replace(/ - \d{1,2}(st|nd|rd|th) [A-Za-z]+ \d{4}$/, "").trim();
}

async function getNtsSchedule(channel: "1" | "2"): Promise<NtsScheduleDay[]> {
	let request = ntsScheduleCache.get(channel);
	if (!request) {
		request = fetchJson<{ results?: NtsScheduleDay[] }>(`https://www.nts.live/api/v2/radio/schedule/${channel}`).then(
			(result) => result.results || [],
		);
		ntsScheduleCache.set(channel, request);
	}
	return await request;
}

async function getNtsSectionsForMixcloud(item: { title: string; username?: string; inputUrl?: string }, debugLog?: (msg: string) => void): Promise<MusicSection[]> {
	const log = debugLog || (() => {});

	if ((item.username || "").toLowerCase() !== "ntsradio") {
		log("Username is not NTSRadio, skipping NTS lookup");
		return [];
	}

	// Strategy 1: Try to get tracklist directly from NTS episode API
	// Extract show/episode from Mixcloud URL
	if (item.inputUrl) {
		const episodeSections = await getNtsTracklistFromEpisodeUrl(item.inputUrl, log);
		if (episodeSections.length > 0) return episodeSections;
	}

	// Strategy 2: Fall back to schedule-based lookup
	const targetDate = parseMixcloudBroadcastDate(item.title);
	log(`Parsed date from title "${item.title}": ${targetDate || "FAILED"}`);
	if (!targetDate) return [];

	const strippedTitle = stripMixcloudDateSuffix(item.title);
	const targetTitle = normalizeTitleForMatch(strippedTitle);
	log(`Stripped title: "${strippedTitle}"`);
	log(`Normalized for matching: "${targetTitle}"`);

	for (const channel of ["1", "2"] as const) {
		log(`Checking NTS channel ${channel}...`);
		const schedule = await getNtsSchedule(channel);
		const day = schedule.find((entry) => entry.date === targetDate);
		log(`Found day ${targetDate} in schedule: ${day ? "YES" : "NO"}`);
		if (!day) continue;

		log(`Day has ${day.broadcasts?.length || 0} broadcasts`);
		for (const broadcast of day.broadcasts || []) {
			const broadcastTitle = normalizeTitleForMatch(broadcast.broadcast_title || "");
			const sameTitle =
				broadcastTitle === targetTitle ||
				broadcastTitle.startsWith(targetTitle) ||
				targetTitle.startsWith(broadcastTitle);
			log(`Comparing: "${broadcastTitle}" vs "${targetTitle}" -> ${sameTitle ? "MATCH" : "NO MATCH"}`);
			if (!sameTitle) continue;

			const detailUrl = broadcast.links?.find((link) => link.rel === "details")?.href;
			log(`Found matching broadcast, detail URL: ${detailUrl || "N/A"}`);
			if (!detailUrl) continue;

			try {
				const detail = await fetchJson<{ links?: Array<{ rel?: string; href?: string }> }>(detailUrl);
				const tracklistUrl = detail.links?.find((link) => link.rel === "tracklist")?.href;
				log(`Tracklist URL: ${tracklistUrl || "N/A"}`);
				if (!tracklistUrl) continue;

				const tracklist = await fetchJson<{ results?: NtsTracklistEntry[] }>(tracklistUrl);
				const sections = (tracklist.results || [])
					.map(mapNtsTracklistEntry)
					.filter((entry): entry is MusicSection => Boolean(entry))
					.sort((a, b) => a.startSeconds - b.startSeconds);
				log(`Got ${sections.length} sections from tracklist`);
				if (sections.length > 0) return sections;
			} catch (e) {
				log(`Error fetching tracklist: ${e}`);
			}
		}
	}

	log("No tracklist found from NTS API");
	return [];
}

async function getNtsTracklistFromEpisodeUrl(mixcloudUrl: string, log: (msg: string) => void): Promise<MusicSection[]> {
	try {
		// Fetch the Mixcloud page to get the NTS episode URL from description
		const parsed = new URL(mixcloudUrl);
		const apiUrl = `https://api.mixcloud.com${parsed.pathname.replace(/\/?$/, "/")}`;
		log(`Fetching Mixcloud API for NTS link: ${apiUrl}`);

		const mixcloudData = await fetchJson<{
			description?: string;
			name?: string;
			user?: { username?: string };
		}>(apiUrl);

		// Extract NTS episode URL from description
		// Pattern: https://www.nts.live/shows/<show>/episodes/<episode>
		const ntsMatch = mixcloudData.description?.match(/https:\/\/www\.nts\.live\/shows\/([^/]+)\/episodes\/([^/\s]+)/);
		if (!ntsMatch) {
			log("No NTS episode URL found in description");
			return [];
		}

		const [, showAlias, episodeAlias] = ntsMatch;
		log(`Found NTS episode: show=${showAlias}, episode=${episodeAlias}`);

		// Construct NTS API URL
		const ntsApiUrl = `https://www.nts.live/api/v2/shows/${showAlias}/episodes/${episodeAlias}/tracklist`;
		log(`Fetching NTS tracklist: ${ntsApiUrl}`);

		const tracklist = await fetchJson<{
			results?: Array<{
				artist?: string;
				title?: string;
				offset?: number;
				offset_estimate?: number;
			}>;
		}>(ntsApiUrl);

		const sections = (tracklist.results || [])
			.map((entry): MusicSection | undefined => {
				const title = String(entry.title || "").trim();
				if (!title) return undefined;
				const artist = String(entry.artist || "").trim() || undefined;
				const startSeconds = entry.offset ?? entry.offset_estimate ?? 0;
				return {
					startSeconds: Number.isFinite(startSeconds) ? startSeconds : 0,
					title,
					artist,
				};
			})
			.filter((entry): entry is MusicSection => Boolean(entry))
			.sort((a, b) => a.startSeconds - b.startSeconds);

		log(`Got ${sections.length} sections from NTS episode tracklist`);
		return sections;
	} catch (e) {
		log(`Error fetching from NTS episode: ${e}`);
		return [];
	}
}

function mapYtDlpEntry(entry: YtDlpEntry, source: MusicSource): MusicItem | undefined {
	const inputUrl = entry.webpage_url || entry.url;
	if (!inputUrl || !entry.title) return undefined;
	return {
		id: makeItemId(source, inputUrl),
		source,
		title: entry.title,
		artist: entry.artist || entry.uploader || entry.channel,
		album: entry.album,
		genres: [],
		inputUrl,
		streamUrl: source === "youtube" ? undefined : isUrl(entry.url || "") ? entry.url : undefined,
		durationSeconds: entry.duration,
		imageUrl: entry.thumbnail,
		addedAt: Date.now(),
	};
}

export async function resolveStreamUrl(inputUrl: string): Promise<string> {
	await ensureYtDlpAvailable();
	const { stdout } = await execFileAsync(
		"yt-dlp",
		["--get-url", "--no-playlist", inputUrl],
		{ timeout: 30_000, maxBuffer: 1024 * 1024 },
	);
	const streamUrl = stdout.trim().split("\n").find(Boolean);
	if (!streamUrl) {
		throw new Error(`Could not resolve stream URL for ${inputUrl}`);
	}
	return streamUrl;
}

async function extractWithYtDlp(input: string): Promise<YtDlpEntry> {
	await ensureYtDlpAvailable();
	try {
		const { stdout } = await execFileAsync(
			"yt-dlp",
			["-J", "--no-playlist", "--no-warnings", input],
			{ timeout: 30_000, maxBuffer: 8 * 1024 * 1024 },
		);
		return JSON.parse(stdout) as YtDlpEntry;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`yt-dlp could not resolve "${input}": ${message}`);
	}
}

export async function searchYouTube(query: string, limit = 5): Promise<MusicItem[]> {
	const result = await extractWithYtDlp(`ytsearch${limit}:${query}`);
	return (result.entries || [])
		.map((entry) => mapYtDlpEntry(entry, "youtube"))
		.filter((entry): entry is MusicItem => Boolean(entry));
}

export async function searchBandcamp(query: string, limit = 8): Promise<MusicItem[]> {
	const result = await extractWithYtDlp(`bcsearch${limit}:${query}`);
	return (result.entries || [])
		.map((entry) => mapYtDlpEntry(entry, "bandcamp"))
		.filter((entry): entry is MusicItem => Boolean(entry));
}

function mapBandcampBrowseEntry(entry: YtDlpEntry, accountLabel?: string): MusicItem | undefined {
	const inputUrl = entry.webpage_url || entry.url || entry.original_url;
	const title = entry.title || (inputUrl ? titleFromBandcampUrl(inputUrl) : undefined);
	if (!inputUrl || !title) return undefined;
	const nestedEntries = (entry.entries || []).filter(Boolean);
	const nestedDurations = nestedEntries.map((item) => item?.duration).filter((value): value is number => typeof value === "number");
	const nestedTags = nestedEntries.flatMap((item) => item?.tags || []).filter((value): value is string => Boolean(value));
	const genres = Array.from(new Set([...(entry.tags || []), ...nestedTags].filter((value): value is string => Boolean(value))));
	const durationSeconds =
		typeof entry.duration === "number"
			? entry.duration
			: nestedDurations.length > 0
				? nestedDurations.reduce((sum, value) => sum + value, 0)
				: undefined;
	const firstNested = nestedEntries.find((item) => Boolean(item));
	return {
		id: makeItemId("bandcamp", inputUrl),
		source: "bandcamp",
		title,
		artist: entry.artist || entry.album_artist || entry.uploader || accountLabel,
		album: entry.album,
		genres,
		inputUrl,
		streamUrl: inputUrl.includes("/track/") ? (entry.url && isUrl(entry.url) ? entry.url : undefined) : undefined,
		durationSeconds,
		imageUrl: entry.thumbnail || firstNested?.thumbnail,
		addedAt: Date.now(),
	};
}

export async function getBandcampAccountItems(account: string): Promise<MusicItem[]> {
	const accountUrl = normalizeBandcampAccount(account);
	const cached = getCachedValue(bandcampAccountCache, accountUrl);
	if (cached) return cached;
	const accountLabel = getBandcampAccountLabel(accountUrl);
	const result = await extractFlatPlaylistWithYtDlp(accountUrl);
	const items = (result.entries || [])
		.filter((entry): entry is YtDlpEntry => Boolean(entry))
		.map((entry) => mapBandcampBrowseEntry(entry, accountLabel))
		.filter((entry): entry is MusicItem => Boolean(entry));
	return setCachedValue(bandcampAccountCache, accountUrl, items, CACHE_TTL.bandcampAccountMs);
}

export async function getBandcampReleaseTracks(inputUrl: string): Promise<MusicItem[]> {
	const cached = getCachedValue(bandcampReleaseCache, inputUrl);
	if (cached) return cached;
	const result = await extractPlaylistWithYtDlp(inputUrl);
	const fallbackArtist = result.artist || result.album_artist || result.uploader || undefined;
	const fallbackAlbum = result.album || result.title || undefined;
	const fallbackGenres = (result.tags || []).filter((tag): tag is string => Boolean(tag));
	const entries = (result.entries || []).filter((entry): entry is YtDlpEntry => Boolean(entry));
	const tracks: MusicItem[] =
		entries.length > 0
			? entries
					.map((entry): MusicItem | undefined => {
						const track = mapYtDlpEntry(entry, "bandcamp");
						if (!track) return undefined;
						return {
							...track,
							artist: track.artist || fallbackArtist,
							album: track.album || fallbackAlbum,
							genres: track.genres && track.genres.length > 0 ? track.genres : fallbackGenres,
						};
					})
					.filter((entry): entry is MusicItem => Boolean(entry))
			: [mapYtDlpEntry(result, "bandcamp")].filter((entry): entry is MusicItem => Boolean(entry));
	return setCachedValue(bandcampReleaseCache, inputUrl, tracks, CACHE_TTL.bandcampReleaseMs);
}

export { getBandcampAccountLabel, normalizeBandcampAccount };

export async function searchMixcloud(query: string, limit = 8): Promise<MusicItem[]> {
	const url = `https://api.mixcloud.com/search/?q=${encodeURIComponent(query)}&type=cloudcast&limit=${limit}`;
	const result = await fetchJson<{ data: MixcloudCloudcast[] }>(url);
	return result.data.map((entry) => ({
		id: makeItemId("mixcloud", entry.url),
		source: "mixcloud",
		title: entry.name,
		artist: entry.user?.name,
		genres: (entry.tags || []).map((tag) => tag.name).filter((name): name is string => Boolean(name)),
		inputUrl: entry.url,
		durationSeconds: entry.audio_length,
		imageUrl: entry.pictures?.large || entry.pictures?.medium,
		username: entry.user?.username,
		addedAt: Date.now(),
	}));
}

export async function getMixcloudCloudcastsPage(username: string, pageUrl?: string, limit = 20): Promise<MixcloudPage> {
	const clean = username.trim().replace(/^@/, "");
	const url = pageUrl || `https://api.mixcloud.com/${encodeURIComponent(clean)}/cloudcasts/?limit=${limit}`;
	const result = await fetchJson<MixcloudListResponse>(url);
	return {
		items: result.data.map((entry) => ({
			id: makeItemId("mixcloud", entry.url),
			source: "mixcloud",
			title: entry.name,
			artist: entry.user?.name,
			genres: (entry.tags || []).map((tag) => tag.name).filter((name): name is string => Boolean(name)),
			inputUrl: entry.url,
			durationSeconds: entry.audio_length,
			imageUrl: entry.pictures?.large || entry.pictures?.medium,
			username: entry.user?.username || clean,
			addedAt: Date.now(),
		})),
		nextUrl: result.paging?.next,
		previousUrl: result.paging?.previous,
	};
}

export async function getMixcloudCloudcasts(username: string, limit = 20): Promise<MusicItem[]> {
	const page = await getMixcloudCloudcastsPage(username, undefined, limit);
	return page.items;
}

export async function getMixcloudSections(inputUrl: string, debugLog?: (msg: string) => void): Promise<MusicSection[]> {
	const log = debugLog || (() => {});
	const cached = getCachedValue(mixcloudSectionsCache, inputUrl);
	if (cached) {
		log(`Using cached sections (${cached.length})`);
		return cached;
	}
	try {
		const apiUrl = getMixcloudApiUrl(inputUrl);
		log(`Fetching Mixcloud API: ${apiUrl}`);
		const result = await getMixcloudDetails(inputUrl);
		log(`Got mix: "${result.name}", user: ${result.user?.username || "N/A"}`);
		log(`Mixcloud sections count: ${result.sections?.length || 0}`);

		const sections = (result.sections || [])
			.map(mapMixcloudSectionEntry)
			.filter((entry): entry is MusicSection => Boolean(entry))
			.sort((a, b) => a.startSeconds - b.startSeconds);
		if (sections.length > 0) {
			log(`Using ${sections.length} sections from Mixcloud`);
			return setCachedValue(mixcloudSectionsCache, inputUrl, sections, CACHE_TTL.mixcloudSectionsMs);
		}

		log("No sections from Mixcloud, trying NTS API...");
		const ntsSections = await getNtsSectionsForMixcloud(
			{
				title: result.name,
				username: result.user?.username,
				inputUrl,
			},
			log,
		);
		return setCachedValue(mixcloudSectionsCache, inputUrl, ntsSections, CACHE_TTL.mixcloudSectionsMs);
	} catch (e) {
		log(`Error fetching Mixcloud sections: ${e}`);
		return [];
	}
}

export async function resolvePlayable(input: string): Promise<MusicItem> {
	const trimmed = input.trim();
	if (!trimmed) throw new Error("Missing search query or URL");

	if (trimmed === "nts" || trimmed === "nts1" || trimmed === "nts2") {
		const channel = trimmed.endsWith("2") ? "2" : "1";
		const now = await getNtsNowPlaying(channel);
		return {
			id: makeItemId("nts", NTS_STREAMS[channel]),
			source: "nts",
			title: now.showTitle || `NTS ${channel}`,
			artist: now.trackArtist,
			album: now.trackTitle,
			genres: [],
			inputUrl: NTS_STREAMS[channel],
			streamUrl: NTS_STREAMS[channel],
			ntsChannel: channel,
			ntsShowTitle: now.showTitle,
			sections: now.sections,
			addedAt: Date.now(),
		};
	}

	if (!isUrl(trimmed)) {
		const [first] = await searchYouTube(trimmed, 1);
		if (!first) throw new Error(`No playable result for "${trimmed}"`);
		return { ...first, streamUrl: first.inputUrl };
	}

	const source = detectSource(trimmed);
	const extracted = await extractWithYtDlp(trimmed);
	const mixcloudDetails =
		source === "mixcloud"
			? await getMixcloudDetails(trimmed).catch(() => undefined)
			: undefined;
	const item =
		(mixcloudDetails
			? ({
					id: makeItemId("mixcloud", mixcloudDetails.url),
					source: "mixcloud",
					title: mixcloudDetails.name,
					artist: mixcloudDetails.user?.name,
					genres: (mixcloudDetails.tags || []).map((tag) => tag.name).filter((name): name is string => Boolean(name)),
					inputUrl: mixcloudDetails.url,
					durationSeconds: mixcloudDetails.audio_length,
					imageUrl: mixcloudDetails.pictures?.large || mixcloudDetails.pictures?.medium,
					username: mixcloudDetails.user?.username,
					addedAt: Date.now(),
				} satisfies MusicItem)
			: undefined) ||
		mapYtDlpEntry(extracted, source) ||
		({
			id: makeItemId(source, trimmed),
			source,
			title: trimmed,
			genres: [],
			inputUrl: trimmed,
			addedAt: Date.now(),
		} satisfies MusicItem);

	const sections = source === "mixcloud" ? await getMixcloudSections(item.inputUrl) : undefined;

	return {
		...item,
		streamUrl: source === "youtube" ? trimmed : await resolveStreamUrl(trimmed),
		sections: sections && sections.length > 0 ? sections : item.sections,
	};
}


export async function getNtsNowPlaying(channel: "1" | "2"): Promise<NtsNowPlaying> {
	const result = await fetchJson<{
		results?: Array<{
			channel_name?: string;
			now?: {
				broadcast_title?: string;
				start_timestamp?: string;
				end_timestamp?: string;
				embeds?: {
					details?: {
						name?: string;
						links?: Array<{ rel?: string; href?: string }>;
					};
				};
			};
		}>;
	}>("https://www.nts.live/api/v2/live");

	const channelResult = (result.results || []).find((entry) => entry.channel_name === channel);
	const now = channelResult?.now;
	const showTitle = now?.embeds?.details?.name || now?.broadcast_title;

	let trackTitle: string | undefined;
	let trackArtist: string | undefined;
	let sections: MusicSection[] | undefined;
	const tracklistLink = now?.embeds?.details?.links?.find((link) => link.rel === "tracklist")?.href;

	if (tracklistLink) {
		try {
			const tracklist = await fetchJson<{
				results?: NtsTracklistEntry[];
			}>(tracklistLink);
			sections = (tracklist.results || [])
				.map(mapNtsTracklistEntry)
				.filter((entry): entry is MusicSection => Boolean(entry))
				.sort((a, b) => a.startSeconds - b.startSeconds);
			const currentSection = getCurrentNtsSection(sections, now?.start_timestamp);
			trackTitle = currentSection?.title;
			trackArtist = currentSection?.artist;
		} catch {
			// best-effort only
		}
	}

	return {
		channel,
		showTitle,
		trackTitle,
		trackArtist,
		startTimestamp: now?.start_timestamp,
		endTimestamp: now?.end_timestamp,
		sections,
	};
}
