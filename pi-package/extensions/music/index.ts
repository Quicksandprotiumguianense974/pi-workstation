import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { getMusicPlayer } from "./music-player";
import {
	getBandcampAccountItems,
	getBandcampAccountLabel,
	getBandcampReleaseTracks,
	getMixcloudCloudcastsPage,
	normalizeBandcampAccount,
	getNtsNowPlaying,
	resolvePlayable,
	searchBandcamp,
	searchMixcloud,
	searchYouTube,
} from "./music-sources";
import {
	addToHistory,
	addBandcampAccount,
	addWatchAccount,
	isFavorite,
	loadLibrary,
	loadRuntime,
	removeBandcampAccount,
	removeWatchAccount,
	saveLibrary,
	saveRuntime,
	toggleFavorite,
} from "./music-store";
import type { MusicItem, MusicLibrary, MusicRuntimeState, MusicSection, NtsNowPlaying, PlayerSnapshot, AudioLevels } from "./music-types";


// ═════════════════════════════════════════════════════════════════════════════
// Icons & Styles — 寺山修司 Theatrical Music Theme
// Midnight carnival, gramophone needles, moth-wing silence
// ═════════════════════════════════════════════════════════════════════════════
const ICONS = {
	// Sources — theatrical symbols
	mixcloud: "☁",
	youtube: "›",
	nts: "✦",
	music: "♪",
	bandcamp: "◇",

	// UI Actions — subtle pointers
	play: "›",
	pause: "‖",
	stop: "■",
	next: "→",
	queue: "≡",
	favorite: "●",
	unfavorite: "○",
	search: "☽",
	browse: "※",
	history: "◷",
	back: "←",
	close: "×",
	add: "+",
	remove: "−",
	loading: "◐",
	current: "›",
	time: "◷",

	// Info — poetic symbols
	artist: "★",
	album: "□",
	genre: "◇",
	track: "†",
	status: "●",
};

// ANSI Color codes — Terayama Dreamscape Palette (TrueColor RGB)
const COLORS = {
	reset: "\x1b[0m",
	bold: "\x1b[1m",
	dim: "\x1b[2m",

	// Paper & Moonlight
	paper: "\x1b[38;2;237;224;204m",        // #EDE0CC — aged diary
	silver: "\x1b[38;2;200;184;144m",       // #C8B890 — moonlight
	chrome: "\x1b[38;2;230;218;200m",       // #E6DAC8 — pale snow
	copper: "\x1b[38;2;204;160;80m",        // #CCA050 — amber
	gold: "\x1b[38;2;216;184;104m",         // #D8B868 — tarnished gold
	blood: "\x1b[38;2;224;72;72m",          // #E04848 — curtain red
	film: "\x1b[38;2;154;138;120m",         // #9A8A78 — faded ink
	kuro: "\x1b[38;2;20;12;18m",            // #140C12 — stage dark
	void: "\x1b[38;2;12;6;14m",             // #0C060E — theater void

	// Terayama Core — warm theatrical tones
	electricBlue: "\x1b[38;2;96;128;160m",  // #6080A0 — twilight blue
	hotPink: "\x1b[38;2;224;72;72m",        // #E04848 — crimson
	acidGreen: "\x1b[38;2;130;160;110m",    // #82A06E — moss
	cyberPurple: "\x1b[38;2;168;88;168m",   // #A858A8 — wisteria
	neonOrange: "\x1b[38;2;204;160;80m",    // #CCA050 — amber
	stamp: "\x1b[38;2;130;160;110m",        // #82A06E — moss
	caseBlue: "\x1b[38;2;96;128;160m",      // #6080A0 — twilight

	// Highlight variants — warm glow
	brightPaper: "\x1b[38;2;245;234;216m",  // Bright parchment
	brightCopper: "\x1b[38;2;220;178;110m", // Bright amber
	brightGold: "\x1b[38;2;235;200;128m",   // Bright gold
	brightCyan: "\x1b[38;2;216;200;136m",   // Firefly glow
	brightGreen: "\x1b[38;2;155;185;138m",  // Bright moss
	brightYellow: "\x1b[38;2;235;200;128m", // Warm gold
	brightMagenta: "\x1b[38;2;208;104;120m", // Faded rose

	// Legacy aliases
	cyan: "\x1b[38;2;96;128;160m",          // twilight
	green: "\x1b[38;2;130;160;110m",        // moss
	yellow: "\x1b[38;2;216;184;104m",       // gold
	magenta: "\x1b[38;2;208;104;120m",      // rose
	white: "\x1b[38;2;237;224;204m",        // paper
	gray: "\x1b[38;2;154;138;120m",         // ink
};

const STYLES = {
	divider: "─".repeat(40),
	bullet: "·",
	arrow: "→",
	separator: "│",
};

export default function musicExtension(pi: ExtensionAPI) {
	const player = getMusicPlayer();
	const PAGE_SIZE = 12;

	let library: MusicLibrary = loadLibrary();
	let runtime: MusicRuntimeState = loadRuntime();
	let pollTimer: ReturnType<typeof setInterval> | undefined;
	let vjTimer: ReturnType<typeof setInterval> | undefined;
	let lastSnapshot: PlayerSnapshot = { idle: true, paused: false };
	let lastNtsNowPlaying: NtsNowPlaying | undefined;
	let activeCtx: ExtensionContext | undefined;
	const sessionContexts = new Set<ExtensionContext>();
	let pollBusy = false;
	let vjBusy = false;
	let consecutiveIdlePolls = 0;
	let removeTerminalShortcutListener: (() => void) | undefined;

	// VJ state — shared via globalThis for pet widget integration
	let vjGain = 1.0;
	let vjSmoothL = 0;
	let vjSmoothR = 0;
	let vjEnergy = 0;
	let vjBeatAccum = 0;
	let vjPeakEnergy = 0;       // fast-tracking peak for transient detection
	let vjTransient = 0;        // 0..1 spike on beats, decays quickly
	let vjPrevRawEnergy = 0;    // for derivative-based beat detection
	let vjSpectralFlux = 0;     // tracks change in energy over time

	const RAW_SHORTCUTS = {
		togglePause: "\x1bp",
		seekBack: "\x1b[",
		seekForward: "\x1b]",
	} as const;

	function persistLibrary(): void {
		saveLibrary(library);
	}

	function persistRuntime(): void {
		saveRuntime(runtime);
	}

	function loadSharedState(): void {
		library = loadLibrary();
		runtime = loadRuntime();
	}

	function syncRuntimeFromDisk(): void {
		runtime = loadRuntime();
	}

	function getFallbackSessionCtx(): ExtensionContext | undefined {
		return sessionContexts.values().next().value as ExtensionContext | undefined;
	}

	function getControlCtx(): ExtensionContext | undefined {
		return activeCtx || getFallbackSessionCtx();
	}

	function setActiveSession(ctx: ExtensionContext): void {
		sessionContexts.add(ctx);
		activeCtx = ctx;
	}

	function registerSessionContext(ctx: ExtensionContext): void {
		installTerminalShortcutFallbacks(ctx);
		activateSessionAndRefreshUi(ctx);
		startPoller();
		void pollPlayback();
	}

	function unregisterSessionContext(ctx: ExtensionContext): void {
		sessionContexts.delete(ctx);
		if (activeCtx === ctx) {
			activeCtx = undefined;
			activeCtx = getFallbackSessionCtx();
		}
		if (ctx.hasUI && sessionContexts.size === 0) {
			ctx.ui.setStatus("music", undefined);
		}
	}

	function currentMixcloudSection(sections: MusicSection[] | undefined, timePosSeconds: number | undefined): string | undefined {
		if (!sections || sections.length === 0 || timePosSeconds === undefined) return undefined;
		let current: MusicSection | undefined;
		for (const section of sections) {
			if (section.startSeconds <= timePosSeconds) current = section;
			else break;
		}
		if (!current) return undefined;
		return current.artist ? `${current.artist} - ${current.title}` : current.title;
	}

	function getSourceIcon(source: MusicItem["source"]): string {
		return ICONS[source as keyof typeof ICONS] || ICONS.music;
	}

	function isBandcampRelease(item: MusicItem | undefined): boolean {
		return Boolean(item && item.source === "bandcamp" && item.bandcampReleaseTracks && item.bandcampReleaseTracks.length > 0);
	}

	function getBandcampReleaseTrackList(item: MusicItem | undefined): MusicItem[] {
		return isBandcampRelease(item) ? item!.bandcampReleaseTracks || [] : [];
	}

	function getBandcampReleaseIndex(item: MusicItem | undefined): number {
		return isBandcampRelease(item) ? Math.max(0, item!.bandcampReleaseIndex || 0) : 0;
	}

	function getBandcampTrackOffset(tracks: MusicItem[], index: number): number {
		return tracks.slice(0, index).reduce((sum, track) => sum + (track.durationSeconds || 0), 0);
	}

	function buildBandcampSections(tracks: MusicItem[]): MusicSection[] {
		let offset = 0;
		return tracks.map((track) => {
			const section = {
				startSeconds: offset,
				title: track.title,
				artist: track.artist,
			};
			offset += track.durationSeconds || 0;
			return section;
		});
	}

	function getDisplayProgress(item: MusicItem | undefined, snapshot?: PlayerSnapshot): { position: number; duration: number } {
		if (!item) return { position: 0, duration: 0 };
		if (isBandcampRelease(item)) {
			const tracks = getBandcampReleaseTrackList(item);
			const offset = getBandcampTrackOffset(tracks, getBandcampReleaseIndex(item));
			return {
				position: snapshot?.timePosSeconds !== undefined ? offset + snapshot.timePosSeconds : runtime.lastPositionSeconds || offset,
				duration: item.durationSeconds || 0,
			};
		}
		return {
			position: snapshot?.timePosSeconds || runtime.lastPositionSeconds || 0,
			duration: snapshot?.durationSeconds || item.durationSeconds || 0,
		};
	}

	function formatProgressBarCompact(position: number, duration: number, width = 8): string {
		if (duration <= 0) return "";
		const ratio = Math.min(1, Math.max(0, position / duration));
		const filled = Math.round(ratio * width);
		const empty = width - filled;
		return "█".repeat(filled) + "░".repeat(empty);
	}

	function setHeaderText(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		// Music info is now shown in the pet HUD widget — clear any old status
		ctx.ui.setStatus("music", undefined);
	}

	function activateSessionAndRefreshUi(ctx: ExtensionContext): void {
		setActiveSession(ctx);
		refreshAllUi();
	}

	function persistAndRefresh(ctx?: ExtensionContext): void {
		persistRuntime();
		if (ctx) activateSessionAndRefreshUi(ctx);
		else refreshAllUi();
	}

	function clearRuntime(options?: { clearQueue?: boolean }): void {
		runtime.current = undefined;
		runtime.paused = false;
		runtime.lastPositionSeconds = undefined;
		consecutiveIdlePolls = 0;
		if (options?.clearQueue) {
			runtime.queue = [];
		}
	}

	function refreshAllUi(): void {
		syncRuntimeFromDisk();
		for (const ctx of sessionContexts) {
			if (ctx.hasUI) setHeaderText(ctx);
		}
	}

	function getCurrentProgramText(): string | undefined {
		if (!runtime.current) return undefined;
		if (runtime.current.source === "nts") {
			return lastNtsNowPlaying?.showTitle || runtime.current.ntsShowTitle || runtime.current.title;
		}
		if (runtime.current.source === "bandcamp" && isBandcampRelease(runtime.current)) {
			return runtime.current.title;
		}
		return runtime.current.title;
	}

	function getCurrentLiveTrackText(): string | undefined {
		if (!runtime.current) return undefined;
		if (runtime.current.source === "nts") {
			return [lastNtsNowPlaying?.trackArtist, lastNtsNowPlaying?.trackTitle].filter(Boolean).join(" - ") || undefined;
		}
		if (runtime.current.source === "mixcloud") {
			return currentMixcloudSection(runtime.current.sections, lastSnapshot.timePosSeconds);
		}
		if (runtime.current.source === "bandcamp" && isBandcampRelease(runtime.current)) {
			return currentMixcloudSection(runtime.current.sections, runtime.lastPositionSeconds);
		}
		return undefined;
	}


	function formatItemLabels(items: MusicItem[], startIndex: number): string[] {
		const rst = COLORS.reset;
		// Silver Case archive palette
		const cIdx = COLORS.film;      // film grain — index
		const cTitle = COLORS.paper;   // aged paper — title
		const cArtist = COLORS.silver;  // silver — artist
		const cDur = COLORS.copper;     // copper — duration
		const cGenre = COLORS.stamp;    // stamp green — genre

		const rows = items.map((item) => {
			let title = item.title;
			const artist = item.artist;
			if (artist && title.toLowerCase().startsWith(artist.toLowerCase())) {
				title = title.slice(artist.length).replace(/^\s*[-–—:]\s*/, "").trim() || title;
			}
			const showArtist = artist && !title.toLowerCase().includes(artist.toLowerCase()) ? artist : "";
			let dur = "";
			if (item.durationSeconds && item.durationSeconds > 0) {
				const mins = Math.floor(item.durationSeconds / 60);
				const secs = Math.floor(item.durationSeconds % 60);
				dur = `${mins}:${String(secs).padStart(2, "0")}`;
			}
			const genre = item.genres?.slice(0, 2).join(", ") ?? "";
			return { icon: getSourceIcon(item.source), title, artist: showArtist, dur, genre };
		});

		const maxTitle = Math.min(50, Math.max(10, ...rows.map((r) => r.title.length)));
		const maxArtist = Math.min(24, Math.max(0, ...rows.map((r) => r.artist.length)));
		const maxDur = Math.max(0, ...rows.map((r) => r.dur.length));

		return rows.map((r, i) => {
			const num = String(startIndex + i + 1).padStart(2, " ");
			const t = r.title.length > maxTitle ? r.title.slice(0, maxTitle - 1) + "…" : r.title.padEnd(maxTitle);
			const a = maxArtist > 0 ? (r.artist.length > maxArtist ? r.artist.slice(0, maxArtist - 1) + "…" : r.artist.padEnd(maxArtist)) : "";
			const d = maxDur > 0 ? r.dur.padStart(maxDur) : "";

			let line = `${cIdx}${num}.${rst} ${r.icon} ${cTitle}${t}${rst}`;
			if (maxArtist > 0) line += `  ${cArtist}${a}${rst}`;
			if (maxDur > 0) line += `  ${cDur}${d}${rst}`;
			if (r.genre) line += `  ${cGenre}${r.genre}${rst}`;
			return line;
		});
	}

	function formatItemLabel(item: MusicItem): string {
		return formatItemLabels([item], 0)[0];
	}

	function describeMusicError(error: unknown): string {
		const message = error instanceof Error ? error.message : String(error);
		if (message.includes("yt-dlp is required") || message.includes("mpv is required")) return message;
		if (message.includes("Could not resolve stream URL")) return "Could not resolve a playable audio stream.";
		if (message.includes("yt-dlp could not resolve")) return message;
		if (message.includes("Missing playback target")) return "This item does not have a playable URL.";
		if (message.includes("timed out")) return "Playback request timed out.";
		return message;
	}

	async function playBandcampReleaseTrack(release: MusicItem, trackIndex: number, ctx: ExtensionContext): Promise<void> {
		const tracks = getBandcampReleaseTrackList(release);
		const track = tracks[trackIndex];
		if (!track) {
			throw new Error("Bandcamp release track not found");
		}
		await player.play(track);
		player.resetAudioFilter();
		runtime.current = {
			...release,
			bandcampReleaseIndex: trackIndex,
		};
		runtime.paused = false;
		runtime.lastPositionSeconds = getBandcampTrackOffset(tracks, trackIndex);
		persistAndRefresh(ctx);
	}

	async function playBandcampRelease(item: MusicItem, ctx: ExtensionContext): Promise<boolean> {
		const tracks = item.bandcampReleaseTracks && item.bandcampReleaseTracks.length > 0 ? item.bandcampReleaseTracks : await getBandcampReleaseTracks(item.inputUrl);
		if (tracks.length === 0) {
			throw new Error("No playable tracks found in this Bandcamp release.");
		}
		const totalDuration = tracks.reduce((sum, track) => sum + (track.durationSeconds || 0), 0);
		const release: MusicItem = {
			...item,
			title: item.title || item.album || tracks[0]?.album || "Bandcamp release",
			artist: item.artist || tracks[0]?.artist,
			album: item.title || item.album,
			durationSeconds: totalDuration > 0 ? totalDuration : undefined,
			sections: buildBandcampSections(tracks),
			bandcampReleaseTracks: tracks,
			bandcampReleaseIndex: 0,
			streamUrl: undefined,
		};
		await playBandcampReleaseTrack(release, 0, ctx);
		library = addToHistory(library, release);
		persistLibrary();
		ctx.ui.notify(`${ICONS.play} Now playing: ${formatShortTitle(release)}`, "success");
		return true;
	}

	async function playItem(item: MusicItem, ctx: ExtensionContext): Promise<boolean> {
		const sourceIcon = getSourceIcon(item.source);
		ctx.ui.notify(`${sourceIcon} Loading...`, "info");
		try {
			if (item.source === "bandcamp" && item.inputUrl.includes("/album/")) {
				return await playBandcampRelease(item, ctx);
			}
			const playable = item.streamUrl ? item : await resolvePlayable(item.inputUrl);
			await player.play(playable);
			player.resetAudioFilter();
			runtime.current = playable;
			runtime.paused = false;
			runtime.lastPositionSeconds = 0;
			consecutiveIdlePolls = 0;
			library = addToHistory(library, playable);
			persistLibrary();
			persistAndRefresh(ctx);
			ctx.ui.notify(`${ICONS.play} Now playing: ${formatShortTitle(playable)}`, "success");
			return true;
		} catch (error) {
			ctx.ui.notify(`${sourceIcon} ${describeMusicError(error)}`, "error");
			return false;
		}
	}

	async function playInput(input: string, ctx: ExtensionContext): Promise<boolean> {
		try {
			const playable = await resolvePlayable(input);
			return await playItem(playable, ctx);
		} catch (error) {
			ctx.ui.notify(`${ICONS.music} ${describeMusicError(error)}`, "error");
			return false;
		}
	}

	function queueItem(item: MusicItem, ctx: ExtensionContext): void {
		runtime.queue = [...runtime.queue, item];
		persistAndRefresh(ctx);
		ctx.ui.notify(`${ICONS.queue} Queued: ${formatShortTitle(item)}`, "info");
	}

	function formatShortTitle(item: MusicItem): string {
		let title = item.title;
		const artist = item.artist;
		if (artist && title.toLowerCase().startsWith(artist.toLowerCase())) {
			title = title.slice(artist.length).replace(/^\s*[-–—:]\s*/, "").trim() || title;
		}
		return title;
	}

	async function skipToNext(ctx: ExtensionContext): Promise<void> {
		if (isBandcampRelease(runtime.current)) {
			const current = runtime.current;
			const tracks = getBandcampReleaseTrackList(current);
			const nextTrackIndex = getBandcampReleaseIndex(current) + 1;
			if (tracks[nextTrackIndex]) {
				await playBandcampReleaseTrack(current!, nextTrackIndex, ctx);
				ctx.ui.notify(`${ICONS.next} ${tracks[nextTrackIndex].title}`, "info");
				return;
			}
		}
		const [next, ...rest] = runtime.queue;
		runtime.queue = rest;
		if (!next) {
			await player.stop();
			clearRuntime();
			persistAndRefresh(ctx);
			ctx.ui.notify(`${ICONS.stop} Playback stopped`, "info");
			return;
		}
		ctx.ui.notify(`${ICONS.next} Playing next...`, "info");
		const started = await playItem(next, ctx);
		if (!started) {
			clearRuntime();
			persistAndRefresh(ctx);
		}
	}

	async function stopPlayback(ctx: ExtensionContext): Promise<void> {
		await player.stop();
		clearRuntime({ clearQueue: true });
		persistAndRefresh(ctx);
		ctx.ui.notify(`${ICONS.stop} Playback stopped`, "info");
	}

	async function togglePause(ctx: ExtensionContext): Promise<void> {
		runtime.paused = await player.togglePause();
		persistAndRefresh(ctx);
	}

	async function chooseActionForItem(item: MusicItem, ctx: ExtensionContext): Promise<"played" | "done"> {
		const isFav = isFavorite(library, item);
		const favIcon = isFav ? ICONS.favorite : ICONS.unfavorite;
		const sourceIcon = ICONS[item.source as keyof typeof ICONS] || ICONS.music;

		const title = formatShortTitle(item);

		// Build colored info lines (not selectable)
		const infoLines: string[] = [];
		infoLines.push(`${COLORS.brightCyan}${COLORS.bold}${sourceIcon} ${title}${COLORS.reset}`);

		if (item.artist) {
			infoLines.push(`${COLORS.green}${ICONS.artist} ${item.artist}${COLORS.reset}`);
		}
		if (item.genres?.length) {
			infoLines.push(`${COLORS.yellow}${ICONS.genre} ${item.genres.slice(0, 3).join(", ")}${COLORS.reset}`);
		}

		// Only actions are selectable
		const options = [
			`${ICONS.play} Play now`,
			`${ICONS.queue} Add to queue`,
			`${favIcon} ${isFav ? "Remove from favorites" : "Add to favorites"}`,
			`${ICONS.back} Back`,
		];

		const fullTitle = infoLines.join("\n");
		const choice = await ctx.ui.select(fullTitle, options);

		if (choice?.includes("Play now")) {
			if (await playItem(item, ctx)) return "played";
			return "done";
		}
		if (choice?.includes("Add to queue")) {
			queueItem(item, ctx);
			return "done";
		}
		if (choice?.includes("favorites")) {
			library = toggleFavorite(library, item);
			persistLibrary();
			const newFav = isFavorite(library, item);
			ctx.ui.notify(`${newFav ? ICONS.favorite : ICONS.unfavorite} ${newFav ? "Added to" : "Removed from"} favorites`, "info");
		}
		return "done";
	}

	async function chooseFromItems(title: string, items: MusicItem[], ctx: ExtensionContext): Promise<boolean> {
		if (items.length === 0) {
			ctx.ui.notify(`${ICONS.music} Nothing to show`, "info");
			return false;
		}

		let page = 0;
		const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));

		while (true) {
			const start = page * PAGE_SIZE;
			const pageItems = items.slice(start, start + PAGE_SIZE);
			const labels = formatItemLabels(pageItems, start);
			const options = [
				...labels,
				...(page > 0 ? ["Previous page"] : []),
				...(page < totalPages - 1 ? ["Next page"] : []),
				"Back",
			];

			const selected = await ctx.ui.select(`${title} (${page + 1}/${totalPages})`, options);
			if (!selected || selected === "Back") return false;
			if (selected === "Previous page") {
				page -= 1;
				continue;
			}
			if (selected === "Next page") {
				page += 1;
				continue;
			}

			const index = labels.indexOf(selected);
			const item = pageItems[index];
			if (item) {
				const action = await chooseActionForItem(item, ctx);
				if (action === "played") return true;
			}
		}
	}

	async function openSearch(ctx: ExtensionContext): Promise<boolean> {
		const source = await ctx.ui.select(`${ICONS.search} Search`, [
			`${ICONS.youtube} YouTube`,
			`${ICONS.mixcloud} Mixcloud`,
			`${ICONS.bandcamp} Bandcamp`,
			`${ICONS.back} Back`,
		]);
		if (!source || source.includes("Back")) return false;

		const isYouTube = source.includes("YouTube");
		const isBandcamp = source.includes("Bandcamp");
		const promptIcon = isYouTube ? ICONS.youtube : isBandcamp ? ICONS.bandcamp : ICONS.mixcloud;
		const query = await ctx.ui.input(`${promptIcon} Search query:`, "");
		if (!query?.trim()) return false;

		const sourceLabel = isYouTube ? "YouTube" : isBandcamp ? "Bandcamp" : "Mixcloud";
		const sourceIcon = isYouTube ? ICONS.youtube : isBandcamp ? ICONS.bandcamp : ICONS.mixcloud;
		ctx.ui.notify(`${ICONS.loading} Searching ${sourceLabel}...`, "info");
		const results = isYouTube
			? await searchYouTube(query.trim(), 8)
			: isBandcamp
				? await searchBandcamp(query.trim(), 8)
				: await searchMixcloud(query.trim(), 8);
		if (results.length === 0) {
			ctx.ui.notify(`No results found`, "warning");
			return false;
		}
		return await chooseFromItems(`${sourceIcon} ${results.length} results`, results, ctx);
	}

	async function openQueue(ctx: ExtensionContext): Promise<boolean> {
		if (runtime.queue.length === 0) {
			ctx.ui.notify(`${ICONS.queue} Queue is empty`, "info");
			return false;
		}

		let page = 0;
		while (true) {
			const totalPages = Math.max(1, Math.ceil(runtime.queue.length / PAGE_SIZE));
			const start = page * PAGE_SIZE;
			const pageItems = runtime.queue.slice(start, start + PAGE_SIZE);
			const labels = formatItemLabels(pageItems, start);
			const options = [
				...labels,
				...(page > 0 ? [`${ICONS.back} Previous page`] : []),
				...(page < totalPages - 1 ? [`${ICONS.next} Next page`] : []),
				`${ICONS.back} Back`,
			];

			const selected = await ctx.ui.select(`${ICONS.queue} Queue ${runtime.queue.length} tracks (${page + 1}/${totalPages})`, options);
			if (!selected || selected.includes("Back")) return false;
			if (selected.includes("Previous page")) {
				page -= 1;
				continue;
			}
			if (selected.includes("Next page")) {
				page += 1;
				continue;
			}

			const index = labels.indexOf(selected);
			const item = pageItems[index];
			if (!item) continue;
			const globalIndex = start + index;

			// Build colored title with info
			const infoLines: string[] = [];
			infoLines.push(`${COLORS.brightCyan}${COLORS.bold}${ICONS.queue} ${formatShortTitle(item)}${COLORS.reset}`);
			if (item.artist) {
				infoLines.push(`${COLORS.green}${ICONS.artist} ${item.artist}${COLORS.reset}`);
			}

			const action = await ctx.ui.select(
				infoLines.join("\n"),
				[`${ICONS.play} Play now`, `${ICONS.remove} Remove from queue`, `${ICONS.back} Back`],
			);
			if (action?.includes("Play now")) {
				runtime.queue = runtime.queue.filter((_, itemIndex) => itemIndex !== globalIndex);
				persistAndRefresh(ctx);
				if (await playItem(item, ctx)) return true;
			}
			if (action?.includes("Remove")) {
				runtime.queue = runtime.queue.filter((_, itemIndex) => itemIndex !== globalIndex);
				persistAndRefresh(ctx);
				ctx.ui.notify(`${ICONS.remove} Removed: ${formatShortTitle(item)}`, "info");
				if (page > 0 && page * PAGE_SIZE >= runtime.queue.length) {
					page -= 1;
				}
			}
		}
	}

	async function openMixcloudWatchlist(ctx: ExtensionContext): Promise<boolean> {
		while (true) {
			const options = [
				`${ICONS.add} Add account`,
				...(library.watchlist.length > 0 ? [`${ICONS.remove} Remove account...`] : []),
				...library.watchlist.map((account) => `${ICONS.mixcloud} @${account}`),
				`${ICONS.back} Back`,
			];
			const selected = await ctx.ui.select(`${ICONS.mixcloud} Mixcloud Watchlist`, options);
			if (!selected || selected.includes("Back")) return false;

			if (selected.includes("Add account")) {
				const username = await ctx.ui.input(`${ICONS.mixcloud} Username:`, "");
				if (!username?.trim()) continue;
				library = addWatchAccount(library, username.trim());
				persistLibrary();
				ctx.ui.notify(`${ICONS.mixcloud} Added @${username.trim()}`, "success");
				continue;
			}

			if (selected.includes("Remove account")) {
				const toRemove = await ctx.ui.select(
					`${ICONS.remove} Remove account`,
					library.watchlist.map((a) => `@${a}`),
				);
				if (!toRemove) continue;
				const acc = toRemove.replace(/^@/, "");
				library = removeWatchAccount(library, acc);
				persistLibrary();
				ctx.ui.notify(`${ICONS.mixcloud} Removed @${acc}`, "info");
				continue;
			}

			const username = selected.replace(/^☁\s*@/, "").replace(/^@/, "");
			ctx.ui.notify(`${ICONS.loading} Loading @${username}...`, "info");
			const played = await openMixcloudAccount(username, ctx);
			if (played) return true;
		}
	}

	async function openBandcampWatchlist(ctx: ExtensionContext): Promise<boolean> {
		while (true) {
			const options = [
				`${ICONS.add} Add account`,
				...(library.bandcampWatchlist.length > 0 ? [`${ICONS.remove} Remove account...`] : []),
				...library.bandcampWatchlist.map((account) => `${ICONS.bandcamp} ${getBandcampAccountLabel(account)}`),
				`${ICONS.back} Back`,
			];
			const selected = await ctx.ui.select(`${ICONS.bandcamp} Bandcamp`, options);
			if (!selected || selected.includes("Back")) return false;

			if (selected.includes("Add account")) {
				const input = await ctx.ui.input(`${ICONS.bandcamp} Account URL or name:`, "");
				if (!input?.trim()) continue;
				const account = normalizeBandcampAccount(input.trim());
				library = addBandcampAccount(library, account);
				persistLibrary();
				ctx.ui.notify(`${ICONS.bandcamp} Added ${getBandcampAccountLabel(account)}`, "success");
				continue;
			}

			if (selected.includes("Remove account")) {
				const toRemove = await ctx.ui.select(
					`${ICONS.remove} Remove Bandcamp account`,
					library.bandcampWatchlist.map((account) => `${ICONS.bandcamp} ${getBandcampAccountLabel(account)}`),
				);
				if (!toRemove) continue;
				const account = library.bandcampWatchlist.find(
					(entry) => `${ICONS.bandcamp} ${getBandcampAccountLabel(entry)}` === toRemove,
				);
				if (!account) continue;
				library = removeBandcampAccount(library, account);
				persistLibrary();
				ctx.ui.notify(`${ICONS.bandcamp} Removed ${getBandcampAccountLabel(account)}`, "info");
				continue;
			}

			const account = library.bandcampWatchlist.find(
				(entry) => `${ICONS.bandcamp} ${getBandcampAccountLabel(entry)}` === selected,
			);
			if (!account) continue;
			ctx.ui.notify(`${ICONS.loading} Loading ${getBandcampAccountLabel(account)}...`, "info");
			const played = await openBandcampAccount(account, ctx);
			if (played) return true;
		}
	}

	async function openBandcampRelease(item: MusicItem, ctx: ExtensionContext): Promise<boolean> {
		const action = await chooseActionForItem(item, ctx);
		return action === "played";
	}

	async function openBandcampAccount(account: string, ctx: ExtensionContext): Promise<boolean> {
		const items = await getBandcampAccountItems(account);
		if (items.length === 0) {
			ctx.ui.notify(`${ICONS.bandcamp} Nothing to show`, "info");
			return false;
		}

		let page = 0;
		const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
		while (true) {
			const start = page * PAGE_SIZE;
			const pageItems = items.slice(start, start + PAGE_SIZE);
			const labels = formatItemLabels(pageItems, start);
			const options = [
				...labels,
				...(page > 0 ? ["Previous page"] : []),
				...(page < totalPages - 1 ? ["Next page"] : []),
				"Back",
			];
			const selected = await ctx.ui.select(
				`${ICONS.bandcamp} ${getBandcampAccountLabel(account)} (${page + 1}/${totalPages})`,
				options,
			);
			if (!selected || selected === "Back") return false;
			if (selected === "Previous page") {
				page -= 1;
				continue;
			}
			if (selected === "Next page") {
				page += 1;
				continue;
			}

			const index = labels.indexOf(selected);
			const item = pageItems[index];
			if (!item) continue;
			if (await openBandcampRelease(item, ctx)) return true;
		}
	}

	async function openMixcloudAccount(username: string, ctx: ExtensionContext): Promise<boolean> {
		let items: MusicItem[] = [];
		let nextUrl: string | undefined;
		let page = 0;
		const ACCOUNT_PAGE_SIZE = 100;

		async function loadMore(): Promise<void> {
			ctx.ui.notify(`${ICONS.loading} Loading more from @${username}...`, "info");
			const result = await getMixcloudCloudcastsPage(username, nextUrl, ACCOUNT_PAGE_SIZE);
			items = [...items, ...result.items];
			nextUrl = result.nextUrl;
		}

		await loadMore();
		if (items.length === 0) {
			ctx.ui.notify(`${ICONS.mixcloud} @${username} has no cloudcasts`, "info");
			return false;
		}

		while (true) {
			const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
			const start = page * PAGE_SIZE;
			const pageItems = items.slice(start, start + PAGE_SIZE);
			const labels = formatItemLabels(pageItems, start);
			const options = [
				...labels,
				...(page > 0 ? [`${ICONS.back} Previous page`] : []),
				...(page < totalPages - 1 ? [`${ICONS.next} Next page`] : []),
				...(page === totalPages - 1 && nextUrl ? [`${ICONS.add} Load more from @${username}`] : []),
				`${ICONS.back} Back`,
			];

			const progress = nextUrl ? `+` : "";
			const selected = await ctx.ui.select(`${ICONS.mixcloud} @${username} ${items.length} casts (${page + 1}/${totalPages}${progress})`, options);
			if (!selected || selected.includes("Back")) return false;
			if (selected.includes("Previous page")) {
				page -= 1;
				continue;
			}
			if (selected.includes("Next page")) {
				page += 1;
				continue;
			}
			if (selected.includes("Load more")) {
				await loadMore();
				continue;
			}

			const index = labels.indexOf(selected);
			const item = pageItems[index];
			if (item) {
				const action = await chooseActionForItem(item, ctx);
				if (action === "played") return true;
			}
		}
	}

	async function openFavorites(ctx: ExtensionContext): Promise<boolean> {
		return await chooseFromItems(`${ICONS.favorite} Favorites (${library.favorites.length})`, library.favorites, ctx);
	}

	async function openHistory(ctx: ExtensionContext): Promise<boolean> {
		return await chooseFromItems(`${ICONS.history} History (${library.history.length})`, library.history, ctx);
	}

	function formatProgressBar(current: number, total: number, width = 20): string {
		const ratio = Math.min(1, Math.max(0, current / total));
		const filled = Math.round(ratio * width);
		const empty = width - filled;
		const filledChar = "█";
		const emptyChar = "░";
		return filledChar.repeat(filled) + emptyChar.repeat(empty);
	}

	function formatTime(seconds: number): string {
		const mins = Math.floor(seconds / 60);
		const secs = Math.floor(seconds % 60);
		return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
	}

	async function openNowPlaying(ctx: ExtensionContext): Promise<void> {
		if (!runtime.current) {
			ctx.ui.notify(`${ICONS.music} Nothing is currently playing`, "info");
			return;
		}

		// Poll fresh snapshot for accurate position
		const snapshot = await player.getSnapshot();
		const { position, duration } = getDisplayProgress(runtime.current, snapshot);

		const sourceIcon = ICONS[runtime.current.source as keyof typeof ICONS] || ICONS.music;
		const currentTrack = getCurrentLiveTrackText();
		const isFav = isFavorite(library, runtime.current);

		// Build the title with color - bright cyan for title
		const title = formatShortTitle(runtime.current);
		const headerTitle = `${COLORS.brightCyan}${COLORS.bold}${sourceIcon} ${title}${COLORS.reset}`;

		// Build info text with colors
		const infoLines: string[] = [];

		// Artist line - green
		if (runtime.current.artist && runtime.current.artist !== runtime.current.title) {
			infoLines.push(`${COLORS.green}${ICONS.artist} ${runtime.current.artist}${COLORS.reset}`);
		}

		// Genres line - yellow
		if (runtime.current.genres && runtime.current.genres.length > 0) {
			infoLines.push(`${COLORS.yellow}${ICONS.genre} ${runtime.current.genres.slice(0, 3).join(", ")}${COLORS.reset}`);
		}

		// Progress bar with color
		if (duration > 0) {
			const progressBar = formatProgressBar(position, duration);
			const timeStr = `${formatTime(position)} / ${formatTime(duration)}`;
			infoLines.push(`${COLORS.cyan}${progressBar}${COLORS.reset} ${COLORS.gray}${timeStr}${COLORS.reset}`);
		} else if (runtime.current.source === "nts" || (runtime.current.source === "mixcloud" && !duration)) {
			infoLines.push(`${COLORS.gray}${ICONS.time} ${formatTime(position)} elapsed${COLORS.reset}`);
		}

		// Current track - magenta highlight
		if (currentTrack) {
			infoLines.push(`${COLORS.brightMagenta}${ICONS.current} ${currentTrack}${COLORS.reset}`);
		}

		// Status line with colors
		const statusParts: string[] = [];
		if (runtime.paused) {
			statusParts.push(`${COLORS.brightYellow}${ICONS.pause} Paused${COLORS.reset}`);
		} else {
			statusParts.push(`${COLORS.brightGreen}${ICONS.play} Playing${COLORS.reset}`);
		}
		if (runtime.queue.length > 0) {
			statusParts.push(`${COLORS.cyan}${ICONS.queue} ${runtime.queue.length}${COLORS.reset}`);
		}
		if (isFav) {
			statusParts.push(`${COLORS.brightYellow}${ICONS.favorite} Fav${COLORS.reset}`);
		}
		infoLines.push(statusParts.join(` ${STYLES.bullet} `));

		// Combine info text
		const infoText = infoLines.join("\n");

		// Only controls are selectable options
		const controls = [
			runtime.paused ? `${ICONS.play} Resume` : `${ICONS.pause} Pause`,
			`${ICONS.back} -10s`,
			`${ICONS.next} +10s`,
			runtime.current.sections && runtime.current.sections.length > 0 ? `${ICONS.track} Tracklist (${runtime.current.sections.length})` : undefined,
			`${ICONS.next} Next`,
			`${ICONS.stop} Stop`,
			isFav ? `${ICONS.unfavorite} Remove Favorite` : `${ICONS.favorite} Add Favorite`,
			`${ICONS.back} Back`,
		].filter(Boolean) as string[];

		// Show info as the title/description, only controls as options
		const fullTitle = infoText ? `${headerTitle}\n${infoText}` : headerTitle;
		const choice = await ctx.ui.select(fullTitle, controls);

		if (!choice || choice.includes("Back")) return;

		if (choice.includes("-10s")) {
			const newPos = Math.max(0, position - 10);
			await player.seek(newPos);
			ctx.ui.notify(`${ICONS.back} Jumped back 10s`, "info");
			return openNowPlaying(ctx);
		}

		if (choice.includes("+10s")) {
			const newPos = duration > 0 ? Math.min(duration, position + 10) : position + 10;
			await player.seek(newPos);
			ctx.ui.notify(`${ICONS.next} Jumped forward 10s`, "info");
			return openNowPlaying(ctx);
		}

		if (choice.includes("Pause") || choice.includes("Resume")) {
			await togglePause(ctx);
			return openNowPlaying(ctx);
		}

		if (choice.includes("Tracklist")) {
			return openCurrentTracklist(ctx);
		}

		if (choice.includes("Next")) {
			return skipToNext(ctx);
		}

		if (choice.includes("Stop")) {
			return stopPlayback(ctx);
		}

		if (choice.includes("Favorite") || choice.includes("Unfavorite")) {
			library = toggleFavorite(library, runtime.current);
			persistLibrary();
			const nowFav = isFavorite(library, runtime.current);
			ctx.ui.notify(`${nowFav ? ICONS.favorite : ICONS.unfavorite} ${nowFav ? "Added to" : "Removed from"} favorites`, "info");
			return openNowPlaying(ctx);
		}
	}

	async function openCurrentTracklist(ctx: ExtensionContext): Promise<void> {
		const current = runtime.current;
		if (!current) {
			ctx.ui.notify(`${ICONS.music} Nothing is currently playing`, "info");
			return;
		}

		const sections = current.sections || [];
		if (sections.length === 0) {
			ctx.ui.notify(`${ICONS.track} No tracklist available`, "info");
			return;
		}

		// Poll fresh position
		const snapshot = await player.getSnapshot();
		const currentPos = getDisplayProgress(current, snapshot).position;

		let page = 0;
		while (true) {
			const totalPages = Math.max(1, Math.ceil(sections.length / PAGE_SIZE));
			const start = page * PAGE_SIZE;
			const pageSections = sections.slice(start, start + PAGE_SIZE);

			const labels = pageSections.map((section, index) => {
				const absoluteIndex = start + index;
				const nextSection = sections[absoluteIndex + 1];
				const isCurrent =
					currentPos !== undefined &&
					section.startSeconds <= currentPos &&
					(!nextSection || nextSection.startSeconds > currentPos);

				const timeStr = formatTime(section.startSeconds);
				const title = section.artist ? `${section.artist} - ${section.title}` : section.title;

				// Color coding: current = bright magenta, others = gray
				if (isCurrent) {
					return `${COLORS.brightMagenta}${ICONS.current} ${timeStr}  ${title}${COLORS.reset}`;
				}
				return `${COLORS.gray}  ${timeStr}  ${title}${COLORS.reset}`;
			});

			const options = [
				...labels,
				...(page > 0 ? [`${ICONS.back} Previous page`] : []),
				...(page < totalPages - 1 ? [`${ICONS.next} Next page`] : []),
				`${ICONS.back} Back`,
			];

			const title = formatShortTitle(current);
			const header = `${ICONS.track} ${COLORS.brightCyan}${title}${COLORS.reset} ${STYLES.bullet} ${sections.length} tracks (${page + 1}/${totalPages})`;
			const selected = await ctx.ui.select(header, options);

			if (!selected || selected.includes("Back")) return;
			if (selected.includes("Previous page")) {
				page -= 1;
				continue;
			}
			if (selected.includes("Next page")) {
				page += 1;
			}
		}
	}

	async function openMusicMenu(ctx: ExtensionContext): Promise<void> {
		while (true) {
			const nowPlayingLine = runtime.current
				? `${ICONS.play} ${formatShortTitle(runtime.current)}${runtime.paused ? ` ${ICONS.pause}` : ""}`
				: `${ICONS.music} Nothing playing`;

			const options = [
				nowPlayingLine,
				`${ICONS.queue} Queue ${runtime.queue.length > 0 ? `(${runtime.queue.length})` : ""}`,
				`${ICONS.search} Search`,
				`${ICONS.browse} Mixcloud ${library.watchlist.length > 0 ? `(${library.watchlist.length})` : ""}`,
				`${ICONS.bandcamp} Bandcamp ${library.bandcampWatchlist.length > 0 ? `(${library.bandcampWatchlist.length})` : ""}`,
				`${ICONS.favorite} Favorites ${library.favorites.length > 0 ? `(${library.favorites.length})` : ""}`,
				`${ICONS.history} History`,
				`${ICONS.close} Close`,
			];

			const selected = await ctx.ui.select(`${ICONS.music} Music`, options);
			if (!selected || selected.includes("Close")) return;
			if (selected.includes("Queue") && (await openQueue(ctx))) return;
			if (selected.includes("Search") && (await openSearch(ctx))) return;
			if (selected.includes("Mixcloud") && (await openMixcloudWatchlist(ctx))) return;
			if (selected.includes("Bandcamp") && (await openBandcampWatchlist(ctx))) return;
			if (selected.includes("Favorites") && (await openFavorites(ctx))) return;
			if (selected.includes("History") && (await openHistory(ctx))) return;
			// First option (Now Playing) opens the now playing screen
			if (selected === nowPlayingLine) {
				await openNowPlaying(ctx);
			}
		}
	}

	function updateRuntimeFromSnapshot(snapshot: PlayerSnapshot): void {
		lastSnapshot = snapshot;
		runtime.paused = snapshot.paused;
		if (!runtime.current) return;
		if (isBandcampRelease(runtime.current)) {
			const tracks = getBandcampReleaseTrackList(runtime.current);
			runtime.lastPositionSeconds =
				getBandcampTrackOffset(tracks, getBandcampReleaseIndex(runtime.current)) + (snapshot.timePosSeconds || 0);
		} else {
			runtime.lastPositionSeconds = snapshot.timePosSeconds;
		}
		consecutiveIdlePolls = snapshot.idle ? consecutiveIdlePolls + 1 : 0;
	}

	async function refreshLiveMetadata(): Promise<void> {
		if (runtime.current?.source === "nts" && runtime.current.ntsChannel) {
			lastNtsNowPlaying = await getNtsNowPlaying(runtime.current.ntsChannel);
			runtime.current = {
				...runtime.current,
				artist: lastNtsNowPlaying.trackArtist || runtime.current.artist,
				album: lastNtsNowPlaying.trackTitle || runtime.current.album,
				ntsShowTitle: lastNtsNowPlaying.showTitle || runtime.current.ntsShowTitle,
				sections:
					lastNtsNowPlaying.sections && lastNtsNowPlaying.sections.length > 0
						? lastNtsNowPlaying.sections
						: runtime.current.sections,
			};
			return;
		}
		lastNtsNowPlaying = undefined;
	}

	async function handleIdlePlayback(ctx: ExtensionContext): Promise<boolean> {
		const current = runtime.current;
		if (!current || !lastSnapshot.idle) return false;

		if (isBandcampRelease(current)) {
			const tracks = getBandcampReleaseTrackList(current);
			const nextTrackIndex = getBandcampReleaseIndex(current) + 1;
			if (tracks[nextTrackIndex]) {
				await playBandcampReleaseTrack(current, nextTrackIndex, ctx);
				return true;
			}
		}

		const shouldKeepLiveRuntime = current.source === "nts" || (current.durationSeconds === undefined && current.source === "mixcloud");
		if (shouldKeepLiveRuntime || consecutiveIdlePolls < 2) {
			persistAndRefresh();
			return true;
		}

		if (runtime.queue.length > 0) {
			await skipToNext(ctx);
			return true;
		}

		clearRuntime();
		persistRuntime();
		return false;
	}

	async function pollPlayback(): Promise<void> {
		const controlCtx = getControlCtx();
		if (pollBusy || !controlCtx) return;
		const socketExists = existsSync(join(homedir(), ".pi", "agent", "music", "mpv.sock"));
		if (!socketExists) return;
		syncRuntimeFromDisk();
		if (!runtime.current) return;
		pollBusy = true;
		try {
			updateRuntimeFromSnapshot(await player.getSnapshot());
			await refreshLiveMetadata();
			if (!(await handleIdlePlayback(controlCtx))) {
				persistRuntime();
			}
		} catch {
			// best-effort — connection may be temporarily unavailable
		} finally {
			// Always refresh every session UI so footers stay in sync
			refreshAllUi();
			pollBusy = false;
		}
	}

	// ── VJ: write shared audio state for pet widget ─────────────────────────

	function writeVjSharedState() {
		const current = runtime.current;
		const g = vjGain;
		const shared: any = {
			playing: Boolean(current),
			paused: runtime.paused,
			smoothL: Math.min(1, vjSmoothL * g),
			smoothR: Math.min(1, vjSmoothR * g),
			energy: Math.min(1, vjEnergy * g),
			beatAccum: vjBeatAccum,
			peakEnergy: Math.min(1, vjPeakEnergy * g),
			transient: vjTransient,
			spectralFlux: vjSpectralFlux,
			ts: Date.now(),
		};
		if (current) {
			shared.title = current.title;
			shared.artist = current.artist;
			shared.genre = current.genres?.find(Boolean);
			shared.source = current.source;
			shared.position = runtime.lastPositionSeconds;
			shared.duration = current.durationSeconds;
			shared.currentTrack = getCurrentLiveTrackText();
			shared.program = getCurrentProgramText();
		}
		(globalThis as any).__piMusicVjData = shared;
	}

	async function vjTick(): Promise<void> {
		if (vjBusy || sessionContexts.size === 0 || !runtime.current) {
			if (!runtime.current) (globalThis as any).__piMusicVjData = undefined;
			return;
		}
		vjBusy = true;
		try {
			if (runtime.paused) {
				writeVjSharedState();
				return;
			}

			const levels = await player.getAudioLevels();
			if (!levels) { writeVjSharedState(); return; }

			// ── Fast-responding smoothed levels ──
			const attackFast = 0.55;   // fast attack for responsiveness
			const decayFast = 0.82;    // moderate decay
			const targetL = Math.max(levels.rmsL, levels.peakL * 0.7);
			const targetR = Math.max(levels.rmsR, levels.peakR * 0.7);

			vjSmoothL = targetL > vjSmoothL ? (vjSmoothL * (1 - attackFast) + targetL * attackFast) : (vjSmoothL * decayFast);
			vjSmoothR = targetR > vjSmoothR ? (vjSmoothR * (1 - attackFast) + targetR * attackFast) : (vjSmoothR * decayFast);

			const rawEnergy = Math.max(vjSmoothL, vjSmoothR);

			// ── Energy: two-speed tracking ──
			// Fast energy follows the music closely
			const energyAttack = rawEnergy > vjEnergy ? 0.25 : 0.12;
			vjEnergy += (rawEnergy - vjEnergy) * energyAttack;
			vjEnergy = Math.max(0, Math.min(1, vjEnergy));

			// Peak energy: very fast attack, slow decay — captures transients
			vjPeakEnergy = rawEnergy > vjPeakEnergy ? rawEnergy : vjPeakEnergy * 0.92;

			// ── Beat / transient detection ──
			// Derivative-based: detect sudden increases in energy
			const energyDelta = rawEnergy - vjPrevRawEnergy;
			vjSpectralFlux = Math.max(0, energyDelta); // only positive changes (onsets)
			vjPrevRawEnergy = rawEnergy;

			// Transient spike: fires on beats, decays quickly
			const isBeat = vjSpectralFlux > 0.06 || (rawEnergy > vjEnergy * 1.25 + 0.04 && vjSpectralFlux > 0.02);
			if (isBeat) {
				vjTransient = Math.min(1, vjTransient + 0.4 + vjSpectralFlux * 2);
				vjBeatAccum += rawEnergy * 0.2 + vjSpectralFlux * 0.5;
			} else {
				vjBeatAccum += 0.005;
			}
			vjTransient *= 0.75; // fast decay

			// ── Auto-gain normalization ──
			if (rawEnergy > 0.001) {
				const targetGain = 0.5 / rawEnergy;
				vjGain += (targetGain - vjGain) * 0.04;
				vjGain = Math.max(0.6, Math.min(2.5, vjGain));
			}

			writeVjSharedState();
		} catch {
			// best-effort
		} finally {
			vjBusy = false;
		}
	}

	function startPoller(): void {
		if (pollTimer) clearInterval(pollTimer);
		// Poll every 3 seconds (persistent socket makes this lightweight)
		pollTimer = setInterval(() => {
			void pollPlayback();
		}, 3000);
		// VJ audio analysis — writes shared state for pet widget
		if (vjTimer) clearInterval(vjTimer);
		vjTimer = setInterval(() => {
			void vjTick();
		}, 83);
	}

	function stopPoller(): void {
		if (pollTimer) clearInterval(pollTimer);
		pollTimer = undefined;
		if (vjTimer) clearInterval(vjTimer);
		vjTimer = undefined;
	}

	// Quick control commands
	const quickCommands: Record<string, (ctx: ExtensionContext) => Promise<void>> = {
		p: async (ctx) => {
			if (!runtime.current) {
				ctx.ui.notify(`${ICONS.music} Nothing is playing`, "info");
				return;
			}
			await togglePause(ctx);
			ctx.ui.notify(`${runtime.paused ? ICONS.pause : ICONS.play} ${runtime.paused ? "Paused" : "Resumed"}`, "info");
		},
		n: async (ctx) => {
			if (runtime.queue.length > 0) {
				await skipToNext(ctx);
			} else {
				ctx.ui.notify(`${ICONS.queue} Queue is empty`, "info");
			}
		},
		s: async (ctx) => {
			if (!runtime.current) {
				ctx.ui.notify(`${ICONS.music} Nothing is playing`, "info");
				return;
			}
			await stopPlayback(ctx);
		},
		t: async (ctx) => {
			if (runtime.current?.sections && runtime.current.sections.length > 0) {
				await openCurrentTracklist(ctx);
			} else {
				ctx.ui.notify(`${ICONS.track} No tracklist available`, "info");
			}
		},
		l: async (ctx) => await seekRelative(ctx, -10),
		r: async (ctx) => await seekRelative(ctx, 10),
		ll: async (ctx) => await seekRelative(ctx, -30),
		rr: async (ctx) => await seekRelative(ctx, 30),
	};

	pi.registerCommand("music", {
		description: "Play music or open the music menu",
		handler: async (args, ctx) => {
			const input = (args || "").trim();
			setActiveSession(ctx);
			if (!input) {
				await openMusicMenu(ctx);
				return;
			}
			if (input === "tracklist") {
				await openCurrentTracklist(ctx);
				return;
			}
			// Quick control: /music p, /music n, /music s, etc.
			if (quickCommands[input]) {
				await quickCommands[input](ctx);
				return;
			}

			ctx.ui.notify(`${ICONS.loading} Resolving...`, "info");
			await playInput(input, ctx);
		},
	});

	// Short alias: /m = /music
	pi.registerCommand("m", {
		description: "Quick music control (alias for /music)",
		handler: async (args, ctx) => {
			// Redirect to music command
			const input = (args || "").trim();
			setActiveSession(ctx);

			if (!input) {
				await openMusicMenu(ctx);
				return;
			}

			// If it's just a quick command letter, execute it
			if (quickCommands[input]) {
				await quickCommands[input](ctx);
				return;
			}

			// Otherwise try to play
			if (input.startsWith("http") || input.includes(" ")) {
				ctx.ui.notify(`${ICONS.loading} Resolving...`, "info");
				await playInput(input, ctx);
				return;
			}

			// Open menu for anything else
			await openMusicMenu(ctx);
		},
	});


	/** Shared music state lives on disk so all pi sessions stay in sync. */
	function ensureRuntimeLoaded(): void {
		syncRuntimeFromDisk();
	}

	async function seekRelative(ctx: ExtensionContext, seconds: number): Promise<void> {
		ensureRuntimeLoaded();
		const current = runtime.current;
		if (!current) return;
		let position = runtime.lastPositionSeconds || 0;
		let duration = current.durationSeconds;
		if (isBandcampRelease(current)) {
			const tracks = getBandcampReleaseTrackList(current);
			const trackIndex = getBandcampReleaseIndex(current);
			position = lastSnapshot.timePosSeconds || 0;
			duration = tracks[trackIndex]?.durationSeconds;
		}
		const target = seconds < 0 ? Math.max(0, position + seconds) : duration ? Math.min(duration, position + seconds) : position + seconds;
		await player.seek(target);
		if (isBandcampRelease(current)) {
			runtime.lastPositionSeconds = getBandcampTrackOffset(getBandcampReleaseTrackList(current), getBandcampReleaseIndex(current)) + target;
		} else {
			runtime.lastPositionSeconds = target;
		}
		persistAndRefresh(ctx);
		ctx.ui.notify(`${seconds < 0 ? ICONS.back : ICONS.next} ${seconds > 0 ? "+" : ""}${seconds}s`, "info");
	}

	function installTerminalShortcutFallbacks(ctx: ExtensionContext): void {
		removeTerminalShortcutListener?.();
		removeTerminalShortcutListener = undefined;
		if (!ctx.hasUI) return;

		// Some terminals report Option sequences as raw escape bytes instead of named alt+ keys.
		// Intercept the exact raw sequences so Alt+p / Alt+[ / Alt+] still work for music controls.
		removeTerminalShortcutListener = ctx.ui.onTerminalInput((data) => {
			ensureRuntimeLoaded();
			if (!runtime.current) return undefined;
			if (data === RAW_SHORTCUTS.togglePause) {
				void togglePause(ctx).catch(() => undefined);
				return { consume: true };
			}
			if (data === RAW_SHORTCUTS.seekBack) {
				void seekRelative(ctx, -10).catch(() => undefined);
				return { consume: true };
			}
			if (data === RAW_SHORTCUTS.seekForward) {
				void seekRelative(ctx, 10).catch(() => undefined);
				return { consume: true };
			}
			return undefined;
		});
	}

	pi.registerShortcut(Key.alt("p"), {
		description: "Toggle music pause",
		handler: async (ctx) => {
			ensureRuntimeLoaded();
			if (!runtime.current) return;
			await togglePause(ctx);
		},
	});

	pi.registerShortcut(Key.alt("["), {
		description: "Seek music backward",
		handler: async (ctx) => {
			ensureRuntimeLoaded();
			if (!runtime.current) return;
			await seekRelative(ctx, -10);
		},
	});

	pi.registerShortcut(Key.alt("]"), {
		description: "Seek music forward",
		handler: async (ctx) => {
			ensureRuntimeLoaded();
			if (!runtime.current) return;
			await seekRelative(ctx, 10);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		loadSharedState();
		registerSessionContext(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		loadSharedState();
		registerSessionContext(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		unregisterSessionContext(ctx);
		removeTerminalShortcutListener?.();
		removeTerminalShortcutListener = undefined;
		// Don't stopPoller() or player.disconnect() here — the player socket and
		// poller are shared singletons. Another session (or session_switch) will
		// take over. Disconnecting here would break the active session's live
		// polling and cause stale progress / broken shortcuts.
	});
}
