/**
 * tmux-tabs — Pi extension for tmux-based multi-session management
 *
 * Pairs with the `pi-tabs` launcher script. Provides:
 *   /tabs       — list all tmux tabs
 *   /tab [name] — open a new pi tab
 *   /tab-name   — rename current tab
 *   /tab-go     — switch to another tab (selector)
 *   /tab-close  — close current tab
 *
 * Also auto-syncs tmux window name with pi session name.
 * No-op when not running inside tmux.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as path from "node:path";

interface TmuxWindow {
	index: number;
	name: string;
	active: boolean;
}

export default function (pi: ExtensionAPI) {
	// ── Guard: only activate inside tmux ──
	if (!process.env.TMUX) return;

	// ── Helpers ──

	async function tmux(...args: string[]): Promise<string> {
		const r = await pi.exec("tmux", args, { timeout: 3000 });
		return r.stdout.trim();
	}

	async function getWindows(): Promise<TmuxWindow[]> {
		const out = await tmux(
			"list-windows",
			"-F",
			"#{window_index}\t#{window_name}\t#{window_active}",
		);
		if (!out) return [];
		return out
			.split("\n")
			.filter(Boolean)
			.map((line) => {
				const [idx, name, active] = line.split("\t");
				return { index: Number(idx), name: name ?? "", active: active === "1" };
			});
	}

	// ── Commands ──

	pi.registerCommand("tabs", {
		description: "List all tmux tabs",
		handler: async (_args, ctx) => {
			const wins = await getWindows();
			if (wins.length === 0) {
				ctx.ui.notify("No tabs found", "warning");
				return;
			}
			const lines = wins.map(
				(w) => `${w.active ? "▸" : " "} ${w.index}: ${w.name}`,
			);
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("tab", {
		description: "Open a new pi tab  (/tab [name])",
		handler: async (args, ctx) => {
			const tmuxArgs = ["new-window", "-c", ctx.cwd, "pi"];
			const name = args?.trim();
			if (name) tmuxArgs.splice(2, 0, "-n", name);
			await tmux(...tmuxArgs);
		},
	});

	pi.registerCommand("tab-name", {
		description: "Rename current tmux tab",
		handler: async (args, ctx) => {
			const name = args?.trim();
			if (!name) {
				const input = await ctx.ui.input("Tab name:");
				if (!input) return;
				await tmux("rename-window", input);
				ctx.ui.notify(`Tab → ${input}`, "info");
				return;
			}
			await tmux("rename-window", name);
			ctx.ui.notify(`Tab → ${name}`, "info");
		},
	});

	pi.registerCommand("tab-go", {
		description: "Switch to another tmux tab",
		handler: async (_args, ctx) => {
			const wins = await getWindows();
			const others = wins.filter((w) => !w.active);
			if (others.length === 0) {
				ctx.ui.notify("No other tabs open", "info");
				return;
			}
			const choice = await ctx.ui.select(
				"Switch to tab:",
				others.map((w) => `${w.index}: ${w.name}`),
			);
			if (choice !== undefined) {
				await tmux("select-window", "-t", `:${others[choice].index}`);
			}
		},
	});

	pi.registerCommand("tab-close", {
		description: "Close current tmux tab",
		handler: async (_args, ctx) => {
			const wins = await getWindows();
			if (wins.length <= 1) {
				ctx.ui.notify("Last tab — use /quit to exit", "warning");
				return;
			}
			const ok = await ctx.ui.confirm(
				"Close tab?",
				"This will end the pi session in this tab.",
			);
			if (ok) ctx.shutdown();
		},
	});

	// ── Auto-sync tmux window name with pi session name ──

	pi.on("session_start", async (_event, ctx) => {
		const name = pi.getSessionName();
		try {
			await tmux(
				"rename-window",
				name || path.basename(ctx.cwd),
			);
		} catch {
			// Ignore — tmux command may fail if window closed
		}
	});
}
