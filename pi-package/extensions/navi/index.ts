/**
 * NAVI System — Main Interface
 * Presence in the Wired
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import * as path from "node:path";
import { execSync } from "node:child_process";
import * as fs from "node:fs";

import { Entity, getSessionTokens, getVJData } from "./entity";
import { ParticleField } from "./particles";
import { renderNavi } from "./renderer";
import { refreshWiki, refreshHN, refreshRSS, addFeed, removeFeed } from "./feeds";
import { Colors, Symbols, NodeNames } from "./config";

// ANSI helpers
const _rst = "\x1b[0m";
const _fg24 = (r: number, g: number, b: number, s: string) =>
	`\x1b[38;2;${r};${g};${b}m${s}\x1b[0m`;
const _px = (k: keyof typeof Colors, s: string) =>
	_fg24(Colors[k][0], Colors[k][1], Colors[k][2], s);
const _b = (s: string) => `\x1b[1m${s}\x1b[22m`;

export default function naviExtension(pi: ExtensionAPI) {
	const entity = new Entity();
	const particles = new ParticleField();

	let ctx: ExtensionContext | null = null;
	let frame = 0;
	let workingFrame = 0;
	let isWorking = false;
	let marqueeTick = 0;
	let wasMusicPlaying = false;

	// Timers
	let animTimer: ReturnType<typeof setInterval> | null = null;
	let marqueeTimer: ReturnType<typeof setInterval> | null = null;
	let feedPoller: ReturnType<typeof setInterval> | null = null;
	let vjTimer: ReturnType<typeof setInterval> | null = null;
	let workingTimer: ReturnType<typeof setInterval> | null = null;

	let lastRenderedLines = "";

	// Working animation — faster entity cycling during active work
	let workingEntityTick = 0;
	function startWorking() {
		isWorking = true;
		workingFrame = 0;
		workingEntityTick = 0;
		if (workingTimer) clearInterval(workingTimer);
		workingTimer = setInterval(() => {
			workingFrame++;
			workingEntityTick++;
			// Advance entity frame every ~360ms (every 3rd tick) for faster status cycling
			if (workingEntityTick % 3 === 0) {
				entity.nextFrame();
			}
			render();
		}, 120);
	}

	function stopWorking() {
		isWorking = false;
		if (workingTimer) {
			clearInterval(workingTimer);
			workingTimer = null;
		}
	}

	// Marquee animation
	function startMarquee() {
		if (marqueeTimer) return;
		marqueeTimer = setInterval(() => {
			marqueeTick++;
			render();
		}, 450);
	}

	function stopMarquee() {
		if (marqueeTimer) {
			clearInterval(marqueeTimer);
			marqueeTimer = null;
		}
	}

	// Feed polling
	async function refreshFeeds() {
		await refreshWiki();
		await refreshHN();
		await refreshRSS();
		entity.mood = entity.calculateMood();
		render();
	}

	function startFeedPoller() {
		stopFeedPoller();
		refreshFeeds();
		feedPoller = setInterval(refreshFeeds, 15_000);
	}

	function stopFeedPoller() {
		if (feedPoller) {
			clearInterval(feedPoller);
			feedPoller = null;
		}
	}

	// VJ particle animation
	function startVjTimer() {
		if (vjTimer) return;
		vjTimer = setInterval(() => {
			const music = getVJData();
			if (music && !music.paused) {
				particles.update(1, music);
				particles.spawn(music);
			} else if (music && music.paused) {
				particles.update(0.3);
			} else {
				particles.update(0.5);
				particles.spawnAmbient();
			}

			const isPlaying = Boolean(music?.playing);
			if (isPlaying || wasMusicPlaying || particles.particles.length > 0) {
				wasMusicPlaying = isPlaying;
				render();
			}
		}, 100); // 10fps
	}

	function stopVjTimer() {
		if (vjTimer) {
			clearInterval(vjTimer);
			vjTimer = null;
		}
	}

	// Entity animation
	function startAnim() {
		if (animTimer) return;
		animTimer = setInterval(() => {
			entity.nextFrame();
			render();
		}, 800);
	}

	function stopAnim() {
		if (animTimer) {
			clearInterval(animTimer);
			animTimer = null;
		}
	}

	// Main render
	function render() {
		if (!ctx?.hasUI) return;

		const width = process.stdout.columns || 100;
		const lines = renderNavi(entity, particles, width, marqueeTick, workingFrame, isWorking);

		// Anti-flicker
		const sanitized = lines.map((line) =>
			line.endsWith(_rst) ? line : line + _rst
		);
		const linesKey = sanitized.join("\n");

		if (linesKey !== lastRenderedLines) {
			lastRenderedLines = linesKey;
			ctx.ui.setWidget("navi", sanitized, { placement: "belowEditor" });
		}
	}

	// RSS command
	pi.registerCommand("rss", {
		description: "Manage RSS feed streams",
		handler: async (args, c) => {
			const trimmed = (args || "").trim();
			const [cmd, ...restParts] = trimmed.split(/\s+/).filter(Boolean);
			const rest = restParts.join(" ").trim();

			if (!trimmed) {
				// Interactive menu
				const choice = await c.ui.select("RSS Feed Management", [
					"List active feeds",
					"Add feed",
					"Remove feed",
					"Refresh now",
				]);

				if (choice === "List active feeds") {
					// Show feeds
				} else if (choice === "Add feed") {
					const url = await c.ui.input("RSS/Atom feed URL:", "https://example.com/feed.xml");
					if (url?.trim()) {
						const site = (await c.ui.input("Site name (optional):", ""))?.trim();
						const ok = await addFeed(url.trim(), site);
						c.ui.notify(ok ? "Feed added" : "Failed to add feed", ok ? "success" : "error");
					}
				} else if (choice === "Remove feed") {
					// Remove flow
				} else if (choice === "Refresh now") {
					await refreshRSS(true);
					render();
					c.ui.notify("RSS refreshed", "success");
				}
				return;
			}

			switch (cmd) {
				case "add":
					if (rest) {
						const parts = rest.split(/\s+/);
						const ok = await addFeed(parts[0], parts.slice(1).join(" "));
						c.ui.notify(ok ? "Feed added" : "Failed to add feed", ok ? "success" : "error");
						if (ok) { await refreshRSS(true); render(); }
					}
					return;
				case "remove":
				case "rm":
					if (rest) {
						const ok = await removeFeed(rest);
						c.ui.notify(ok ? "Feed removed" : "Failed to remove feed", ok ? "success" : "error");
						if (ok) { await refreshRSS(true); render(); }
					}
					return;
				case "refresh":
					await refreshRSS(true);
					render();
					c.ui.notify("RSS refreshed", "success");
					return;
			}
		},
	});

	// Lifecycle events
	pi.on("session_start", async (_e, c) => {
		ctx = c;
		startAnim();
		startMarquee();
		startFeedPoller();
		startVjTimer();
	});

	pi.on("session_switch", async (_e, c) => {
		ctx = c;
		startAnim();
		startMarquee();
		startFeedPoller();
		startVjTimer();
	});

	pi.on("turn_start", () => {
		entity.setMood("thinking");
		startWorking();
	});

	pi.on("turn_end", () => {
		stopWorking();
		entity.state.totalTurns++;

		const tokens = getSessionTokens(ctx!);
		if (tokens.total > 0) {
			const result = entity.addXP(tokens.total);
			if (result.leveledUp) {
				entity.setMood("excited");
				ctx?.ui.notify(`Entity evolved to L${result.newLevel} — ${entity.getTitle()}`, "info");
				setTimeout(() => {
					if (entity.coreMood === "excited") entity.setMood("idle");
				}, 8000);
			}
			entity.persist();
		}

		if (entity.coreMood !== "excited") {
			entity.setMood("happy");
			setTimeout(() => {
				if (entity.coreMood === "happy") entity.setMood("idle");
			}, 5000);
		}
	});

	pi.on("input", () => {
		if (entity.coreMood === "sleep") entity.setMood("idle");
	});

	pi.on("session_shutdown", async () => {
		stopAnim();
		stopMarquee();
		stopFeedPoller();
		stopVjTimer();
		stopWorking();
	});
}
