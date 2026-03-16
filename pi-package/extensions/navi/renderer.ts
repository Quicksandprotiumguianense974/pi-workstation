/**
 * NAVI System — Interface Renderer
 * 寺山修司 — Theatrical Stage Composition
 * 
 * The terminal as a proscenium arch,
 * feeds as whispered rumors from the wings.
 */

import { Colors, Symbols } from "./config";
import { Entity } from "./entity";
import { ParticleField } from "./particles";
import {
	getCurrentWiki,
	getCurrentHN,
	getHNIndex,
	getCurrentRSS,
} from "./feeds";
import { VJData } from "./types";

// ANSI helpers
const _rst = "\x1b[0m";
const _fg24 = (r: number, g: number, b: number, s: string) =>
	`\x1b[38;2;${r};${g};${b}m${s}\x1b[0m`;
const _px = (k: keyof typeof Colors, s: string) =>
	_fg24(Colors[k][0], Colors[k][1], Colors[k][2], s);
const _b = (s: string) => `\x1b[1m${s}\x1b[22m`;

function visWidth(s: string): number {
	const plain = s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\]8;;[^\x07]*\x07/g, "");
	let w = 0;
	for (const ch of plain) {
		const cp = ch.codePointAt(0) || 0;
		if (cp >= 0x1100 && cp <= 0x115f) w += 2;
		else if (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) w += 2;
		else if (cp >= 0xac00 && cp <= 0xd7a3) w += 2;
		else if (cp >= 0xf900 && cp <= 0xfaff) w += 2;
		else if (cp >= 0xfe10 && cp <= 0xfe6f) w += 2;
		else if (cp >= 0xff01 && cp <= 0xff60) w += 2;
		else if (cp >= 0xffe0 && cp <= 0xffe6) w += 2;
		else if (cp >= 0x1f300 && cp <= 0x1fbff) w += 2;
		else w += 1;
	}
	return w;
}

function visPad(styled: string, targetW: number, fill = " "): string {
	const cur = visWidth(styled);
	if (cur >= targetW) return styled;
	return styled + fill.repeat(targetW - cur);
}

function softMarquee(text: string, width: number, tick: number, hold = 5, gap = 8): string {
	if (width <= 0) return "";
	const chars = Array.from(text);
	if (chars.length <= width) return text;

	const padded = [...chars, ...Array.from(" ".repeat(gap))];
	const maxOffset = Math.max(0, padded.length - width);
	const cycle = hold + maxOffset + hold;
	const phase = tick % Math.max(1, cycle);
	const offset = phase < hold ? 0 : phase < hold + maxOffset ? phase - hold : maxOffset;

	return padded.slice(offset, offset + width).join("");
}

function link(url: string, styledText: string): string {
	if (!url) return styledText;
	return `\x1b]8;;${url}\x07${styledText}\x1b]8;;\x07`;
}

export function renderNavi(
	entity: Entity,
	particles: ParticleField,
	width: number,
	marqueeTick: number,
	workingFrame: number,
	isWorking: boolean
): string[] {
	const innerW = Math.max(30, width - 6);
	const music = (globalThis as any).__piMusicVjData as VJData | undefined;
	const isMusicActive = Boolean(music?.playing);

	const lines: string[] = [];
	const S = Symbols;

	// Frame color — beat-reactive: flashes toward candle-glow on transients
	let borderR: number, borderG: number, borderB: number;
	if (isMusicActive && music) {
		const t = music.transient || 0;
		if (t > 0.08) {
			const blend = Math.min(1, t * 2.5);
			const base = Colors.bara;
			const bright = Colors.rosoku;
			borderR = Math.round(base[0] + (bright[0] - base[0]) * blend);
			borderG = Math.round(base[1] + (bright[1] - base[1]) * blend);
			borderB = Math.round(base[2] + (bright[2] - base[2]) * blend);
		} else {
			[borderR, borderG, borderB] = Colors.bara;
		}
	} else {
		[borderR, borderG, borderB] = Colors.kage;
	}
	const nf = (s: string) => _fg24(borderR, borderG, borderB, s);

	// ── Header — theatrical playbill style ─────────────────────────────
	const nameTag = ` ${entity.name} `;
	const levelTag = ` ${entity.getTitle()} `;
	const stageTag = ` ${S.stages[entity.getStage()] || S.stages[0]} `;

	if (isMusicActive && music) {
		const pauseIcon = music.paused ? "‖" : "›";
		const displayTitle = music.currentTrack || (music.artist ? `${music.title} · ${music.artist}` : music.title || "♪");
		const genre = music.genre ? ` · ${music.genre}` : "";
		const progress = music.duration && music.duration > 0
			? ` ${Math.floor((music.position || 0) / 60)}:${String(Math.floor((music.position || 0) % 60)).padStart(2, "0")}/${Math.floor(music.duration / 60)}:${String(Math.floor(music.duration % 60)).padStart(2, "0")}`
			: "";
		const musicTag = ` ${pauseIcon} ${displayTitle}${genre}${progress} `;
		const usedTop = 2 + nameTag.length + 2 + levelTag.length + 2 + stageTag.length + 2 + musicTag.length + 2;
		const topFill = Math.max(0, innerW - usedTop);
		lines.push(`  ${nf(S.frame.tl)}${_px("kurenai", _b(nameTag))}${nf(S.frame.h)}${_px("tsuki", levelTag)}${nf(S.frame.h)}${_px("kin", stageTag)}${nf(S.frame.h.repeat(topFill))}${_px("hotaru", musicTag)}${nf(S.frame.tr)}`);
	} else {
		const usedTop = 2 + nameTag.length + 2 + levelTag.length + 2 + stageTag.length + 2;
		const topFill = Math.max(0, innerW - usedTop);
		lines.push(`  ${nf(S.frame.tl)}${_px("kurenai", _b(nameTag))}${nf(S.frame.h)}${_px("tsuki", levelTag)}${nf(S.frame.h)}${_px("kin", stageTag)}${nf(S.frame.h.repeat(topFill) + S.frame.tr)}`);
	}

	// ── Entity line — mask + XP bar + status ───────────────────────────
	const prog = entity.getProgress();
	const barW = 8;
	const xpFilled = Math.round((prog.current / prog.needed) * barW);
	const xpColor = xpFilled >= barW * 0.8 ? Colors.kurenai : xpFilled >= barW * 0.5 ? Colors.kin : Colors.bara;
	const xpBar = _fg24(xpColor[0], xpColor[1], xpColor[2], S.selected.repeat(xpFilled)) + _px("hai", S.unselected.repeat(barW - xpFilled));

	const sessionTok = (globalThis as any).__piTokenUsageData;
	const sessionTotal = sessionTok ? (sessionTok.input || 0) + (sessionTok.output || 0) : 0;
	const fmtK = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(0)}k` : `${n}`;
	const tokenInfo = sessionTotal > 0 ? `  ${_px("sumi", fmtK(sessionTotal))}` : "";

	const spinnerPhases = ["◐", "◑", "●", "◑", "◐", "○"];
	const spinner = isWorking ? `${_px("rosoku", spinnerPhases[workingFrame % spinnerPhases.length])} ` : "";
	const statusLine = entity.getStatusLine();
	const face = entity.getFrame();

	const contentInner = `${S.pointer} ${_px("kurenai", face)}  ${xpBar}${tokenInfo}  ${spinner}${_px("tsuki", softMarquee(statusLine, Math.max(10, innerW - 40 - (sessionTotal > 0 ? 4 : 0)), marqueeTick, 8, 10))}`;
	lines.push(`  ${nf(S.frame.v)}${visPad(` ${contentInner}`, innerW - 1)}${nf(S.frame.v)}`);

	// ── Particle field — dream dust ────────────────────────────────────
	if (isMusicActive || particles.particles.length > 0) {
		const fieldRows = 3;
		const fieldCols = innerW - 2;
		const particleLines = particles.render(fieldCols, fieldRows, music?.energy || 0, music?.transient || 0);
		for (const pLine of particleLines) {
			lines.push(`  ${nf(S.frame.v)}${visPad(pLine, innerW - 2)}${nf(S.frame.v)}`);
		}
	}

	// ── Footer border ──────────────────────────────────────────────────
	if (isMusicActive && music) {
		const genre = music.genre || "";
		const hints = `${S.back} P ${S.selected} ← →`;
		const bottomContent = [genre, hints].filter(Boolean).join(" · ");
		const bottomTag = bottomContent ? ` ${bottomContent} ` : "";
		const bottomUsed = 2 + bottomTag.length + 2;
		const bottomFill = Math.max(0, innerW - bottomUsed);
		lines.push(`  ${nf(S.frame.bl + S.frame.h.repeat(Math.max(0, Math.floor(bottomFill / 2))))}${_px("tsuki", bottomTag)}${nf(S.frame.h.repeat(Math.max(0, bottomFill - Math.floor(bottomFill / 2))) + S.frame.br)}`);
	} else {
		lines.push(`  ${nf(S.frame.bl + S.frame.h.repeat(Math.max(0, innerW - 2)) + S.frame.br)}`);
	}

	// ── Data feeds — whispers from the wings ───────────────────────────
	const W = process.stdout.columns || 100;

	const wiki = getCurrentWiki();
	if (wiki) {
		const wikiMeta = wiki.description ? ` · ${wiki.description}` : "";
		const wikiBody = `${wiki.title}${wikiMeta}`;
		lines.push(`  ${link(wiki.url, `${_px("fuji", _b(S.knowledge))} ${_px("fuji", "WK")} ${_px("nikki", _b(softMarquee(wikiBody, Math.max(22, W - 11), marqueeTick, 6, 12)))}`)}`);
	} else {
		lines.push(`  ${_px("fuji", _b(S.knowledge))} ${_px("fuji", "WK")} ${_px("sumi", "○ · · ·")}`);
	}

	const hn = getCurrentHN();
	if (hn) {
		const idx = getHNIndex();
		const metaText = [hn.score > 100 ? "▲" : "△", typeof hn.descendants === "number" ? `${hn.descendants}▽` : "", hn.domain || "", hn.by ? `@${hn.by}` : ""].filter(Boolean).join(" ");
		const hnBody = [hn.title, metaText].filter(Boolean).join("  ·  ");
		const hnUrl = hn.url || `https://news.ycombinator.com/item?id=${hn.id}`;
		lines.push(`  ${link(hnUrl, `${_px("kin", _b(S.signal))} ${_px("kin", "HN")} ${_px("nikki", _b(softMarquee(hnBody, Math.max(20, W - idx.length - 13), marqueeTick + 3, 5, 10)))} ${_px("sumi", `${S.level} ${idx}`)}`)}`);
	} else {
		lines.push(`  ${_px("kin", _b(S.signal))} ${_px("kin", "HN")} ${_px("sumi", "○ · · ·")}`);
	}

	const rss = getCurrentRSS();
	if (rss) {
		const dateStr = rss.published ? new Date(rss.published).toISOString().slice(0, 10) : "";
		const meta = [rss.site, dateStr].filter(Boolean).join(" · ");
		const rssBody = [rss.title, meta].filter(Boolean).join("  ·  ");
		lines.push(`  ${link(rss.url, `${_px("koke", _b(S.flow))} ${_px("koke", "RS")} ${_px("nikki", _b(softMarquee(rssBody, Math.max(20, W - 11), marqueeTick + 7, 7, 12)))}`)}`);
	} else {
		lines.push(`  ${_px("koke", _b(S.flow))} ${_px("koke", "RS")} ${_px("sumi", "○ · · ·")}`);
	}

	const pmStatus = (globalThis as any).__piPMStatus as string | undefined;
	if (pmStatus) {
		lines.push(`  ${_px("bara", _b(S.bind))} ${pmStatus}`);
	} else {
		lines.push(`  ${_px("bara", _b(S.bind))} ${_px("bara", "PM")} ${_px("sumi", "· · · —— · · ·")}`);
	}

	return lines;
}
