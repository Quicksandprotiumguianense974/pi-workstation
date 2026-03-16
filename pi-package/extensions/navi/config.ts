/**
 * NAVI System — Configuration & Symbols
 * 寺山修司 — Terayama Shuji Aesthetic
 * 
 * Midnight theater, faded carnival posters, wisteria shadows,
 * tarnished gold, moth wings against candlelight,
 * the dream-logic of Tenjo Sajiki.
 */

// ═════════════════════════════════════════════════════════════════════════════
// TrueColor Palette — Terayama Dreamscape
// ═════════════════════════════════════════════════════════════════════════════
export const Colors = {
	// 闇 — Darkness & Stage
	yami: [12, 6, 14] as const,          // #0C060E — theater void
	butai: [20, 12, 18] as const,        // #140C12 — stage dark
	maku: [48, 32, 42] as const,         // #30202A — curtain shadow

	// 紙 — Paper & Moonlight
	nikki: [237, 224, 204] as const,     // #EDE0CC — aged diary paper
	tsuki: [200, 184, 144] as const,     // #C8B890 — moonlight
	sumi: [154, 138, 120] as const,      // #9A8A78 — faded ink
	yuki: [230, 218, 200] as const,      // #E6DAC8 — pale snow

	// 紅 — Crimson & Blood
	kurenai: [224, 72, 72] as const,     // #E04848 — theater curtain
	chi: [152, 32, 32] as const,         // #982020 — dried blood
	bara: [208, 104, 120] as const,      // #D06878 — faded rose

	// 金 — Gold & Amber
	kin: [216, 184, 104] as const,       // #D8B868 — tarnished gold
	kohaku: [204, 160, 80] as const,     // #CCA050 — amber resin
	hotaru: [216, 200, 136] as const,    // #D8C888 — firefly glow

	// 藤 — Purple & Mystery
	fuji: [168, 88, 168] as const,       // #A858A8 — wisteria
	murasaki: [112, 64, 128] as const,   // #704080 — deep twilight

	// 自然 — Nature & Time
	koke: [130, 160, 110] as const,      // #82A06E — temple moss
	aoi: [96, 128, 160] as const,        // #6080A0 — evening sky
	hai: [120, 104, 90] as const,        // #78685A — incense ash

	// 光 — Light Effects
	kemuri: [74, 58, 54] as const,       // #4A3A36 — smoke
	rosoku: [230, 185, 100] as const,    // #E6B964 — candle flame
	kage: [74, 50, 56] as const,         // #4A3238 — shadow border
} as const;

// ═════════════════════════════════════════════════════════════════════════════
// 256-Color Fallbacks — Legacy Terminal Support
// ═════════════════════════════════════════════════════════════════════════════
export const FallbackColors = {
	entity: 223,        // Warm parchment
	xpFill: 167,        // Muted rose
	xpEmpty: 238,       // Dim gray
	hnTitle: 223,        // Warm white
	hnScore: 173,        // Amber
	rssTitle: 223,       // Warm white
	rssSite: 133,        // Muted purple
	wikiTitle: 223,      // Warm white
	wikiMeta: 103,       // Muted gold
	dim: 243,            // Ash gray
	text: 223,           // Parchment
	musicAccent: 167,    // Rose
	musicDim: 243,       // Ash
} as const;

// ═════════════════════════════════════════════════════════════════════════════
// Symbol System — Theatrical & Poetic
// ═════════════════════════════════════════════════════════════════════════════
export const Symbols = {
	// Frame — thin theatrical borders (not heavy chrome)
	frame: {
		tl: "┌", tr: "┐", bl: "└", br: "┘",
		h: "─", v: "│",
		hThin: "╌", vThin: "╎",
		tc: "┬", bc: "┴", lc: "├", rc: "┤",
		cross: "┼",
	},

	// Navigation — subtle pointers
	pointer: "›",
	back: "‹",
	selected: "●",
	unselected: "○",

	// Structure
	hierarchy: "※",     // Japanese reference mark
	level: "◉",
	branch: "✦",
	sync: "◐",

	// Feed icons — evocative single-width symbols
	knowledge: "☽",     // Moon — night knowledge
	signal: "✦",        // Star — distant signal
	flow: "≈",          // Waves — dream flow
	bind: "†",          // Dagger — task/fate

	// Entity stages — moon phases
	stages: ["☽", "◐", "◑", "●"] as const,

	// Indicators
	circle: "●",
	ring: "○",
	plus: "＋",
	cross: "✕",
	star: "★",
	starEmpty: "☆",

	// Terayama — theatrical symbols
	mask: "◎",          // Theater mask
	moon: "☽",
	candle: "†",
	moth: "✧",
	mirror: "◈",
	cage: "▣",
	curtain: "¦",
} as const;

// ═════════════════════════════════════════════════════════════════════════════
// Entity Visual States — Theatrical Mask Patterns
// ═════════════════════════════════════════════════════════════════════════════
export const EntityFrames: Record<string, string[][]> = {
	idle: [
		["  ☽  ", " ·☽· ", "  ○  "],
		[" ·☽· ", "☽ ○ ☽", " ·○· "],
		["·  ☽  ·", "☽  ○  ☽", "·  ·  ·"],
		["☽   ○   ☽", "·   ☽   ·", "○   ·   ○"],
	],
	thinking: [
		["  ◐  ", " ·◐· ", "  ◑  "],
		[" ◐·◑ ", "· ◉ ·", " ◑·◐ "],
		["◐  ·  ◑", "· ◉ · ◉", "◑  ·  ◐"],
		["◐   ◉   ◑", "·   ·   ·", "◑   ◉   ◐"],
	],
	happy: [
		["  ★  ", " ·★· ", "  ☽  "],
		[" ☽★☽ ", "· ● ·", " ·★· "],
		["☽  ★  ☽", "·  ●  ·", "☽  ·  ☽"],
		["☽   ★   ☽", "·   ●   ·", "☽   ★   ☽"],
	],
	sleep: [
		["  ·  ", " ·○· ", "  ·  "],
		[" · · ", "· ○ ·", " · · "],
		["·  ·  ·", "· ○ · ○", "·  ·  ·"],
		["·   ·   ·", "·   ○   ·", "·   ·   ·"],
	],
	excited: [
		["  ✦  ", " ★✦★ ", "  ✦  "],
		[" ✦★✦ ", "★ ● ★", " ✦★✦ "],
		["✦  ★  ✦", "★  ●  ★", "✦  ★  ✦"],
		["✦   ★   ✦", "★   ●   ★", "✦   ★   ✦"],
	],
	coding: [
		["  ※  ", " ·※· ", "  ·  "],
		[" ·※· ", "※ ◉ ※", " ·※· "],
		["·  ※  ·", "※  ◉  ※", "·  ·  ·"],
		["※   ◉   ※", "·   ※   ·", "※   ·   ※"],
	],
	listening: [
		["  ◎  ", " ·◎· ", "  ·  "],
		[" ·◎· ", "◎ ● ◎", " ·◎· "],
		["·  ◎  ·", "◎  ●  ◎", "·  ◎  ·"],
		["◎   ●   ◎", "·   ◎   ·", "◎   ·   ◎"],
	],
	reading: [
		["  ◇  ", " ·◇· ", "  ·  "],
		[" ◇·◇ ", "· ◈ ·", " ◇·◇ "],
		["◇  ·  ◇", "· ◈ · ◈", "◇  ·  ◇"],
		["◇   ◈   ◇", "·   ·   ·", "◇   ◈   ◇"],
	],
} as const;

// ═════════════════════════════════════════════════════════════════════════════
// Status Transmissions — Terayama Aphorisms
// ═════════════════════════════════════════════════════════════════════════════
export const StatusLines: Record<string, string[]> = {
	idle: [
		"· · ·",
		"—— ——",
		"☽ · · ·",
		"○ · ○ · ○",
		"· — ·",
	],
	thinking: [
		"· › · › ·",
		"☽ → ●",
		"◐ · ◑ · ◐",
		"· · · · ·",
		"※ · ※ · ※",
	],
	happy: [
		"—— ✦ ——",
		"★ · ★ · ★",
		"● ● ●",
		"☽ → ★",
		"· ✦ ·",
	],
	sleep: [
		"· · ·",
		"○ · ○",
		"— — —",
		"· ○ ·",
		"· · · ·",
	],
	excited: [
		"✦ ★ ✦ ★ ✦",
		"★ · ★ · ★",
		"● ✦ ● ✦ ●",
		"✦ ✦ ✦ ✦ ✦",
		"★ ★ ★ ★ ★",
	],
	coding: [
		"※ · ※ · ※",
		"· ◉ · ◉ ·",
		"※ › ※ › ※",
		"· · · · ·",
		"◉ · ◉ · ◉",
	],
	listening: [
		"◎ ≈ ◎ ≈ ◎",
		"≈ ≈ ≈ ≈ ≈",
		"· ◎ · ◎ ·",
		"≈ · ≈ · ≈",
		"◎ · ◎ · ◎",
	],
	reading: [
		"◇ · ◇ · ◇",
		"◈ › ◈ › ◈",
		"· ◇ · ◇ ·",
		"◈ · ◈ · ◈",
		"◇ ◈ ◇ ◈ ◇",
	],
} as const;

// ═════════════════════════════════════════════════════════════════════════════
// Level Progression — Terayama Theater Troupe Ranks
// ═════════════════════════════════════════════════════════════════════════════
export const LevelThresholds: number[] = (() => {
	const t: number[] = [];
	let cumulative = 0;
	for (let i = 0; i < 30; i++) {
		cumulative += 50_000 * Math.pow(2, i);
		t.push(cumulative);
	}
	return t;
})();

export const LevelTitles = [
	"○",
	"◐",
	"◑",
	"●",
	"☽",
	"★",
	"✦",
	"◈",
	"◉",
	"※",
] as const;

// ═════════════════════════════════════════════════════════════════════════════
// System Paths
// ═════════════════════════════════════════════════════════════════════════════
export const Paths = {
	shared: `${process.env.HOME || "~"}/.pi/navi-shared.json`,
	rssCache: `${process.env.HOME || "~"}/.pi/rss-cache.json`,
	rssFeeds: `${process.env.HOME || "~"}/.pi/rss-feeds.json`,
} as const;

// ═════════════════════════════════════════════════════════════════════════════
// External Sources
// ═════════════════════════════════════════════════════════════════════════════
export const Sources = {
	opml: "https://gist.githubusercontent.com/emschwartz/e6d2bf860ccc367fe37ff953ba6de66b/raw/426957f043dc0054f95aae6c19de1d0b4ecc2bb2/hn-popular-blogs-2025.opml",
} as const;

// ═════════════════════════════════════════════════════════════════════════════
// Entity Identifiers — Names from Terayama's World
// ═════════════════════════════════════════════════════════════════════════════
export const NodeNames = [
	"†-I", "†-II", "†-III", "†-IV", "†-V",
	"☽-A", "☽-B", "☽-C", "☽-D", "☽-E",
	"★-01", "★-02", "★-03", "★-04", "★-05",
	"◈-i", "◈-ii", "◈-iii", "◉-i", "◉-ii",
] as const;
