/**
 * Git Extension — Full interactive git experience
 *
 * /git          — Interactive menu for all operations
 * /git diff     — Full-screen scrollable diff viewer (staged + unstaged)
 * /git status   — Interactive status: stage/unstage/discard per file
 * /git log      — Scrollable commit graph
 * /git commit   — Commit with message prompt
 * /git push     — Push to remote
 * /git pull     — Pull from remote
 * /git stash    — Stash operations (list/push/pop/drop)
 * /git branch   — Branch list/switch/create/delete
 * /git checkout  — Switch branch or restore files
 * /git merge    — Merge a branch
 * /git rebase   — Rebase onto branch
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import {
	Container,
	matchesKey,
	Text,
	truncateToWidth,
} from "@mariozechner/pi-tui";

// ── ANSI helpers ──
const ESC = "\x1b";
const SGR_MOUSE_ON = `${ESC}[?1000h${ESC}[?1006h`;
const SGR_MOUSE_OFF = `${ESC}[?1000l${ESC}[?1006l`;

function enableMouse(tui: any) {
	try { tui.terminal.write(SGR_MOUSE_ON); } catch { try { tui.write?.(SGR_MOUSE_ON); } catch {} }
}
function disableMouse(tui: any) {
	try { tui.terminal.write(SGR_MOUSE_OFF); } catch { try { tui.write?.(SGR_MOUSE_OFF); } catch {} }
}

function parseMouseEvent(data: string): { button: number; col: number; row: number; release: boolean } | null {
	const m = data.match(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
	if (!m) return null;
	return { button: parseInt(m[1]), col: parseInt(m[2]), row: parseInt(m[3]), release: m[4] === "m" };
}
function isScrollUp(data: string) { const e = parseMouseEvent(data); return e ? e.button === 64 : false; }
function isScrollDown(data: string) { const e = parseMouseEvent(data); return e ? e.button === 65 : false; }

function getViewport(tui: any, chrome: number): number {
	const h = tui?.height?.() ?? tui?.getHeight?.() ?? (process.stdout.rows || 24);
	return Math.max(4, h - chrome);
}

// ── Git execution helpers ──

async function gitRoot(pi: ExtensionAPI, cwd: string): Promise<string | null> {
	const r = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd });
	return r.code === 0 ? r.stdout.trim() : null;
}

async function git(pi: ExtensionAPI, args: string[], cwd: string): Promise<{ code: number; out: string; err: string }> {
	const r = await pi.exec("git", args, { cwd });
	return { code: r.code ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

// ── Scrollable viewer (for diff, log, status output) ──

async function showScrollableViewer(
	ctx: ExtensionCommandContext,
	title: string,
	rawText: string,
	styleLine?: (line: string) => string,
) {
	const rawLines = rawText.replace(/\r\n/g, "\n").split("\n");
	// Remove trailing empty line
	if (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") rawLines.pop();
	const CHROME = 4; // top border + title + footer + bottom border

	await ctx.ui.custom<void>((tui, theme, _kb, done) => {
		enableMouse(tui);
		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold(` ${title}`)), 0, 0));
		const body = new Text("", 0, 0);
		container.addChild(body);
		const footer = new Text("", 0, 0);
		container.addChild(footer);
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		let offset = 0;
		const vp = () => getViewport(tui, CHROME);

		const clamp = () => {
			const max = Math.max(0, rawLines.length - vp());
			offset = Math.max(0, Math.min(offset, max));
		};

		const update = (width: number) => {
			clamp();
			const w = Math.max(10, width - 2);
			const slice = rawLines.slice(offset, offset + vp());
			const rendered = slice.map(l => truncateToWidth(styleLine ? styleLine(l) : l, w));
			body.setText(rendered.join("\n"));
			footer.setText(theme.fg("dim",
				`↑↓/j k scroll · PgUp/PgDn · Home/End · q/Esc close · ${offset + 1}–${Math.min(offset + vp(), rawLines.length)}/${rawLines.length}`
			));
		};

		const cleanup = () => disableMouse(tui);

		return {
			render(width: number) { update(width); return container.render(width); },
			invalidate() { container.invalidate(); },
			handleInput(data: string) {
				if (isScrollUp(data)) { offset -= 3; tui.requestRender(); return; }
				if (isScrollDown(data)) { offset += 3; tui.requestRender(); return; }
				if (parseMouseEvent(data)) return;
				if (matchesKey(data, "escape") || matchesKey(data, "enter") || data === "q") { cleanup(); done(undefined); return; }
				if (matchesKey(data, "up") || data === "k") { offset--; tui.requestRender(); return; }
				if (matchesKey(data, "down") || data === "j") { offset++; tui.requestRender(); return; }
				if (matchesKey(data, "pageUp")) { offset -= vp(); tui.requestRender(); return; }
				if (matchesKey(data, "pageDown")) { offset += vp(); tui.requestRender(); return; }
				if (matchesKey(data, "home")) { offset = 0; tui.requestRender(); return; }
				if (matchesKey(data, "end")) { offset = rawLines.length; tui.requestRender(); }
			},
		};
	});
}

// ── Diff line coloring ──

function styleDiffLine(theme: any): (line: string) => string {
	return (line: string) => {
		if (line.startsWith("diff --git") || line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ "))
			return theme.fg("muted", line);
		if (line.startsWith("@@")) return theme.fg("accent", line);
		if (line.startsWith("+")) return theme.fg("toolDiffAdded", line);
		if (line.startsWith("-")) return theme.fg("toolDiffRemoved", line);
		return theme.fg("toolDiffContext", line);
	};
}

// ── Interactive status with staging ──

interface StatusFile { xy: string; path: string; }

function parseStatus(raw: string): StatusFile[] {
	return raw.trim().split("\n").filter(Boolean).map(line => ({
		xy: line.slice(0, 2),
		path: line.slice(3).trim(),
	}));
}

async function showInteractiveStatus(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	root: string,
) {
	// Refresh status
	const refresh = async () => {
		const r = await git(pi, ["status", "--porcelain"], root);
		return parseStatus(r.out);
	};
	let files = await refresh();
	if (files.length === 0) {
		ctx.ui.notify("Working tree clean ✓", "info");
		return;
	}
	const CHROME = 5; // borders + title + footer + action bar

	await ctx.ui.custom<void>(async (tui, theme, _kb, done) => {
		enableMouse(tui);
		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold(" Git Status")), 0, 0));
		const body = new Text("", 0, 0);
		container.addChild(body);
		const footer = new Text("", 0, 0);
		container.addChild(footer);
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		let cursor = 0;
		let offset = 0;

		const vp = () => getViewport(tui, CHROME);

		const formatFile = (f: StatusFile, selected: boolean): string => {
			const x = f.xy[0], y = f.xy[1];
			let statusColor: string;
			if (x === "?" || y === "?") statusColor = "warning";
			else if (x !== " " && y === " ") statusColor = "toolDiffAdded"; // staged
			else if (x === " " && y !== " ") statusColor = "toolDiffRemoved"; // unstaged
			else statusColor = "accent"; // both
			const prefix = selected ? theme.fg("accent", "▸ ") : "  ";
			return `${prefix}${theme.fg(statusColor, theme.bold(f.xy))} ${theme.fg("text", f.path)}`;
		};

		const update = (width: number) => {
			const v = vp();
			// Keep cursor in view
			if (cursor < offset) offset = cursor;
			if (cursor >= offset + v) offset = cursor - v + 1;
			offset = Math.max(0, Math.min(offset, Math.max(0, files.length - v)));

			const w = Math.max(10, width - 2);
			const slice = files.slice(offset, offset + v);
			const rendered = slice.map((f, i) => truncateToWidth(formatFile(f, offset + i === cursor), w));
			body.setText(rendered.join("\n"));
			footer.setText(theme.fg("dim",
				`↑↓ navigate · space stage/unstage · a stage all · d diff · r discard · c commit · q close`
			));
		};

		const cleanup = () => disableMouse(tui);

		return {
			render(width: number) { update(width); return container.render(width); },
			invalidate() { container.invalidate(); },
			async handleInput(data: string) {
				if (isScrollUp(data)) { offset -= 3; tui.requestRender(); return; }
				if (isScrollDown(data)) { offset += 3; tui.requestRender(); return; }
				if (parseMouseEvent(data)) return;

				if (matchesKey(data, "escape") || data === "q") { cleanup(); done(undefined); return; }

				if (matchesKey(data, "up") || data === "k") {
					cursor = Math.max(0, cursor - 1); tui.requestRender(); return;
				}
				if (matchesKey(data, "down") || data === "j") {
					cursor = Math.min(files.length - 1, cursor + 1); tui.requestRender(); return;
				}

				// Space: toggle stage/unstage
				if (data === " " && files[cursor]) {
					const f = files[cursor];
					const x = f.xy[0];
					if (x !== " " && x !== "?") {
						// Staged → unstage
						await git(pi, ["reset", "HEAD", "--", f.path], root);
					} else {
						// Unstaged/untracked → stage
						await git(pi, ["add", "--", f.path], root);
					}
					files = await refresh();
					if (files.length === 0) { cleanup(); done(undefined); ctx.ui.notify("All changes staged/resolved", "info"); return; }
					cursor = Math.min(cursor, files.length - 1);
					tui.requestRender();
					return;
				}

				// a: stage all
				if (data === "a") {
					await git(pi, ["add", "-A"], root);
					files = await refresh();
					if (files.length === 0) { cleanup(); done(undefined); ctx.ui.notify("All staged ✓", "info"); return; }
					tui.requestRender();
					return;
				}

				// d: diff selected file
				if (data === "d" && files[cursor]) {
					const f = files[cursor];
					const diffR = await git(pi, ["diff", "--no-color", "--", f.path], root);
					const stagedR = await git(pi, ["diff", "--no-color", "--cached", "--", f.path], root);
					const combined = [stagedR.out, diffR.out].filter(Boolean).join("\n");
					if (combined.trim()) {
						cleanup();
						done(undefined);
						await showScrollableViewer(ctx, `diff · ${f.path}`, combined, styleDiffLine(theme));
					} else {
						ctx.ui.notify(`No diff for ${f.path}`, "info");
					}
					return;
				}

				// r: discard changes (restore)
				if (data === "r" && files[cursor]) {
					const f = files[cursor];
					const sure = await ctx.ui.confirm("Discard changes?", `Discard all changes in ${f.path}? This cannot be undone.`);
					if (sure) {
						if (f.xy[1] === "?" || f.xy === "??") {
							// Untracked: delete
							await pi.exec("rm", ["-f", f.path], { cwd: root });
						} else {
							await git(pi, ["checkout", "--", f.path], root);
						}
						files = await refresh();
						if (files.length === 0) { cleanup(); done(undefined); ctx.ui.notify("Working tree clean ✓", "info"); return; }
						cursor = Math.min(cursor, files.length - 1);
					}
					tui.requestRender();
					return;
				}

				// c: commit (close status, prompt for message)
				if (data === "c") {
					cleanup();
					done(undefined);
					const msg = await ctx.ui.input("Commit message:", "");
					if (msg?.trim()) {
						const r = await git(pi, ["commit", "-m", msg.trim()], root);
						ctx.ui.notify(r.code === 0 ? (r.out.trim() || "Committed ✓") : (r.err.trim() || r.out.trim() || "Commit failed"), r.code === 0 ? "info" : "error");
					} else {
						ctx.ui.notify("Commit cancelled", "info");
					}
					return;
				}
			},
		};
	});
}

// ── Interactive branch viewer ──

async function showBranchViewer(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	root: string,
) {
	const r = await git(pi, ["branch", "-a", "-v", "--no-color"], root);
	const currentR = await git(pi, ["rev-parse", "--abbrev-ref", "HEAD"], root);
	const currentBranch = currentR.out.trim();

	const branchLines = r.out.trim().split("\n").filter(Boolean);
	if (branchLines.length === 0) {
		ctx.ui.notify("No branches found", "info");
		return;
	}

	const CHROME = 5;

	await ctx.ui.custom<void>((tui, theme, _kb, done) => {
		enableMouse(tui);
		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold(` Branches · current: ${currentBranch}`)), 0, 0));
		const body = new Text("", 0, 0);
		container.addChild(body);
		const footer = new Text("", 0, 0);
		container.addChild(footer);
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		let cursor = 0;
		let offset = 0;
		const vp = () => getViewport(tui, CHROME);

		const update = (width: number) => {
			const v = vp();
			if (cursor < offset) offset = cursor;
			if (cursor >= offset + v) offset = cursor - v + 1;
			offset = Math.max(0, Math.min(offset, Math.max(0, branchLines.length - v)));

			const w = Math.max(10, width - 2);
			const slice = branchLines.slice(offset, offset + v);
			const rendered = slice.map((l, i) => {
				const isCurrent = l.startsWith("*");
				const selected = offset + i === cursor;
				const prefix = selected ? theme.fg("accent", "▸") : " ";
				const color = isCurrent ? "accent" : l.includes("remotes/") ? "muted" : "text";
				return truncateToWidth(`${prefix} ${theme.fg(color, l)}`, w);
			});
			body.setText(rendered.join("\n"));
			footer.setText(theme.fg("dim",
				`↑↓ navigate · enter switch · n new branch · D delete · q close`
			));
		};

		const cleanup = () => disableMouse(tui);

		return {
			render(width: number) { update(width); return container.render(width); },
			invalidate() { container.invalidate(); },
			async handleInput(data: string) {
				if (isScrollUp(data)) { offset -= 3; tui.requestRender(); return; }
				if (isScrollDown(data)) { offset += 3; tui.requestRender(); return; }
				if (parseMouseEvent(data)) return;

				if (matchesKey(data, "escape") || data === "q") { cleanup(); done(undefined); return; }
				if (matchesKey(data, "up") || data === "k") { cursor = Math.max(0, cursor - 1); tui.requestRender(); return; }
				if (matchesKey(data, "down") || data === "j") { cursor = Math.min(branchLines.length - 1, cursor + 1); tui.requestRender(); return; }

				// Enter: switch to selected branch
				if (matchesKey(data, "enter") && branchLines[cursor]) {
					const line = branchLines[cursor];
					const branchName = line.replace(/^\*?\s+/, "").split(/\s+/)[0].replace(/^remotes\/origin\//, "");
					if (branchName === currentBranch) { ctx.ui.notify("Already on this branch", "info"); return; }
					cleanup(); done(undefined);
					const sr = await git(pi, ["checkout", branchName], root);
					ctx.ui.notify(sr.code === 0 ? `Switched to ${branchName}` : (sr.err.trim() || "Switch failed"), sr.code === 0 ? "info" : "error");
					return;
				}

				// n: new branch
				if (data === "n") {
					cleanup(); done(undefined);
					const name = await ctx.ui.input("New branch name:", "");
					if (name?.trim()) {
						const cr = await git(pi, ["checkout", "-b", name.trim()], root);
						ctx.ui.notify(cr.code === 0 ? `Created & switched to ${name.trim()}` : (cr.err.trim() || "Failed"), cr.code === 0 ? "info" : "error");
					}
					return;
				}

				// D: delete branch
				if (data === "D" && branchLines[cursor]) {
					const line = branchLines[cursor];
					const branchName = line.replace(/^\*?\s+/, "").split(/\s+/)[0];
					if (branchName === currentBranch) { ctx.ui.notify("Cannot delete current branch", "error"); return; }
					const sure = await ctx.ui.confirm("Delete branch?", `Delete ${branchName}?`);
					if (sure) {
						cleanup(); done(undefined);
						const dr = await git(pi, ["branch", "-D", branchName], root);
						ctx.ui.notify(dr.code === 0 ? `Deleted ${branchName}` : (dr.err.trim() || "Failed"), dr.code === 0 ? "info" : "error");
					}
					return;
				}
			},
		};
	});
}

// ── Interactive stash viewer ──

async function showStashViewer(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	root: string,
) {
	const r = await git(pi, ["stash", "list", "--format=%gd %gs"], root);
	const stashes = r.out.trim().split("\n").filter(Boolean);

	if (stashes.length === 0) {
		// No stashes — offer to stash current changes
		const status = await git(pi, ["status", "--porcelain"], root);
		if (status.out.trim()) {
			const msg = await ctx.ui.input("Stash message (empty for default):", "");
			const args = msg?.trim() ? ["stash", "push", "-m", msg.trim()] : ["stash", "push"];
			const sr = await git(pi, args, root);
			ctx.ui.notify(sr.code === 0 ? "Stashed ✓" : (sr.err.trim() || "Failed"), sr.code === 0 ? "info" : "error");
		} else {
			ctx.ui.notify("No stashes & working tree clean", "info");
		}
		return;
	}

	const CHROME = 5;

	await ctx.ui.custom<void>((tui, theme, _kb, done) => {
		enableMouse(tui);
		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold(` Stash · ${stashes.length} entries`)), 0, 0));
		const body = new Text("", 0, 0);
		container.addChild(body);
		const footer = new Text("", 0, 0);
		container.addChild(footer);
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		let cursor = 0;
		let offset = 0;
		const vp = () => getViewport(tui, CHROME);

		const update = (width: number) => {
			const v = vp();
			if (cursor < offset) offset = cursor;
			if (cursor >= offset + v) offset = cursor - v + 1;
			offset = Math.max(0, Math.min(offset, Math.max(0, stashes.length - v)));

			const w = Math.max(10, width - 2);
			const slice = stashes.slice(offset, offset + v);
			const rendered = slice.map((l, i) => {
				const selected = offset + i === cursor;
				const prefix = selected ? theme.fg("accent", "▸ ") : "  ";
				return truncateToWidth(`${prefix}${theme.fg("text", l)}`, w);
			});
			body.setText(rendered.join("\n"));
			footer.setText(theme.fg("dim",
				`↑↓ navigate · enter pop · d diff · D drop · s new stash · q close`
			));
		};

		const cleanup = () => disableMouse(tui);

		return {
			render(width: number) { update(width); return container.render(width); },
			invalidate() { container.invalidate(); },
			async handleInput(data: string) {
				if (isScrollUp(data)) { offset -= 3; tui.requestRender(); return; }
				if (isScrollDown(data)) { offset += 3; tui.requestRender(); return; }
				if (parseMouseEvent(data)) return;

				if (matchesKey(data, "escape") || data === "q") { cleanup(); done(undefined); return; }
				if (matchesKey(data, "up") || data === "k") { cursor = Math.max(0, cursor - 1); tui.requestRender(); return; }
				if (matchesKey(data, "down") || data === "j") { cursor = Math.min(stashes.length - 1, cursor + 1); tui.requestRender(); return; }

				const stashRef = stashes[cursor]?.split(" ")[0]; // stash@{0}

				// Enter: pop
				if (matchesKey(data, "enter") && stashRef) {
					cleanup(); done(undefined);
					const pr = await git(pi, ["stash", "pop", stashRef], root);
					ctx.ui.notify(pr.code === 0 ? `Popped ${stashRef}` : (pr.err.trim() || "Failed"), pr.code === 0 ? "info" : "error");
					return;
				}

				// d: show stash diff
				if (data === "d" && stashRef) {
					const dr = await git(pi, ["stash", "show", "-p", "--no-color", stashRef], root);
					if (dr.out.trim()) {
						cleanup(); done(undefined);
						await showScrollableViewer(ctx, `stash · ${stashRef}`, dr.out, styleDiffLine(ctx.ui.theme));
					} else {
						ctx.ui.notify("Empty stash", "info");
					}
					return;
				}

				// D: drop
				if (data === "D" && stashRef) {
					const sure = await ctx.ui.confirm("Drop stash?", `Drop ${stashRef}?`);
					if (sure) {
						cleanup(); done(undefined);
						const dr = await git(pi, ["stash", "drop", stashRef], root);
						ctx.ui.notify(dr.code === 0 ? `Dropped ${stashRef}` : (dr.err.trim() || "Failed"), dr.code === 0 ? "info" : "error");
					}
					return;
				}

				// s: new stash
				if (data === "s") {
					cleanup(); done(undefined);
					const msg = await ctx.ui.input("Stash message (empty for default):", "");
					const args = msg?.trim() ? ["stash", "push", "-m", msg.trim()] : ["stash", "push"];
					const sr = await git(pi, args, root);
					ctx.ui.notify(sr.code === 0 ? "Stashed ✓" : (sr.err.trim() || "Failed"), sr.code === 0 ? "info" : "error");
					return;
				}
			},
		};
	});
}

// ── Log line coloring ──

function styleLogLine(theme: any): (line: string) => string {
	return (line: string) => {
		// Graph characters
		if (/^[*|\/\\ ]+$/.test(line)) return theme.fg("muted", line);
		// Lines with commit hash
		const m = line.match(/^([*|\/\\ ]*)([a-f0-9]{7,12})\s(.*)$/);
		if (m) {
			const [, graph, hash, rest] = m;
			// Check for decorations like (HEAD -> main, origin/main)
			const decM = rest.match(/^(\([^)]+\))\s*(.*)/);
			if (decM) {
				return `${theme.fg("muted", graph)}${theme.fg("accent", hash)} ${theme.fg("warning", decM[1])} ${theme.fg("text", decM[2])}`;
			}
			return `${theme.fg("muted", graph)}${theme.fg("accent", hash)} ${theme.fg("text", rest)}`;
		}
		return theme.fg("text", line);
	};
}

// ── Main extension ──

export default function (pi: ExtensionAPI) {
	pi.registerCommand("git", {
		description: "Interactive git: diff, status, log, commit, push, pull, stash, branch",
		handler: async (args, ctx) => {
			const root = await gitRoot(pi, ctx.cwd);
			if (!root) {
				ctx.ui.notify("Not inside a git repository", "error");
				return;
			}

			const raw = (args || "").trim();
			const sub = raw.split(/\s+/)[0]?.toLowerCase() || "";
			const subArgs = raw.slice(sub.length).trim();

			// ── notify helper ──
			const notify = async (title: string, gitArgs: string[]) => {
				const r = await git(pi, gitArgs, root);
				const out = [r.out, r.err].filter(s => s.trim()).join("\n").trim();
				ctx.ui.notify(out || `${title}: done`, r.code === 0 ? "info" : "error");
			};

			const actions: Record<string, () => Promise<void>> = {
				// ── diff ──
				diff: async () => {
					const diffArgs = ["diff", "--no-color"];
					if (subArgs) diffArgs.push(...subArgs.split(/\s+/));
					else diffArgs.push("HEAD"); // default: diff against HEAD (staged + unstaged)
					const r = await git(pi, diffArgs, root);
					if (!r.out.trim()) {
						ctx.ui.notify("No changes", "info");
						return;
					}
					await showScrollableViewer(ctx, `git diff${subArgs ? " " + subArgs : ""}`, r.out, styleDiffLine(ctx.ui.theme));
				},

				// ── status ──
				status: async () => {
					await showInteractiveStatus(pi, ctx, root);
				},

				// ── log ──
				log: async () => {
					const logArgs = ["log", "--oneline", "--graph", "--decorate", "--no-color", "-50"];
					if (subArgs) logArgs.push(...subArgs.split(/\s+/));
					const r = await git(pi, logArgs, root);
					if (!r.out.trim()) { ctx.ui.notify("No commits", "info"); return; }
					await showScrollableViewer(ctx, "git log", r.out, styleLogLine(ctx.ui.theme));
				},

				// ── commit ──
				commit: async () => {
					// Check if there's anything staged
					const staged = await git(pi, ["diff", "--cached", "--stat"], root);
					if (!staged.out.trim()) {
						const stageAll = await ctx.ui.confirm("Nothing staged", "Stage all changes and commit?");
						if (!stageAll) return;
						await git(pi, ["add", "-A"], root);
					}

					// Step 1: Generate commit message
					let msg = "";

					if (subArgs) {
						// Direct message: /git commit fix typo
						msg = subArgs;
					} else {
						const method = await ctx.ui.select("Commit message", [
							"✍️  Write manually",
							"🤖 Generate with AI",
						]);
						if (!method) { ctx.ui.notify("Commit cancelled", "info"); return; }

						if (method.startsWith("🤖")) {
							// AI: get diff of staged changes, ask LLM
							const diffR = await git(pi, ["diff", "--cached", "--no-color"], root);
							const statR = await git(pi, ["diff", "--cached", "--stat", "--no-color"], root);
							const diffText = diffR.out.trim();
							if (!diffText) {
								ctx.ui.notify("No staged changes to describe", "info");
								return;
							}

							const maxDiffLen = 8000;
							const truncated = diffText.length > maxDiffLen
								? diffText.slice(0, maxDiffLen) + "\n... (truncated)"
								: diffText;

							ctx.ui.setWorkingMessage("Generating commit message…");
							pi.sendUserMessage(
								`Generate a concise git commit message for the following staged changes. Reply with ONLY the commit message text, nothing else — no quotes, no markdown, no explanation. Use conventional commit format (e.g. feat:, fix:, refactor:, docs:, chore:).\n\nFiles changed:\n${statR.out.trim()}\n\nDiff:\n${truncated}`,
							);
							await ctx.waitForIdle();
							ctx.ui.setWorkingMessage();

							// Extract the AI response from session
							const entries = ctx.sessionManager.getBranch();
							for (let i = entries.length - 1; i >= 0; i--) {
								const e = entries[i];
								if (e.type === "assistant") {
									const content = (e as any).content;
									if (Array.isArray(content)) {
										for (const block of content) {
											if (block.type === "text" && block.text) {
												msg = block.text.trim();
												break;
											}
										}
									} else if (typeof content === "string") {
										msg = content.trim();
									}
									break;
								}
							}
							// Strip markdown wrapping
							msg = msg.replace(/^```[^\n]*\n?/, "").replace(/\n?```$/, "").replace(/^["']|["']$/g, "").trim();

							if (!msg) {
								ctx.ui.notify("Failed to generate message", "error");
								return;
							}
						}
					}

					// Step 2: Edit / confirm message
					const finalMsg = await ctx.ui.editor("Commit message (edit & save to commit, Esc to cancel):", msg);
					if (!finalMsg?.trim()) { ctx.ui.notify("Commit cancelled", "info"); return; }

					// Step 3: Commit
					await notify("commit", ["commit", "-m", finalMsg.trim()]);
				},

				// ── add ──
				add: async () => {
					const target = subArgs || ".";
					await notify("add", ["add", ...target.split(/\s+/)]);
				},

				// ── push ──
				push: async () => {
					const pushArgs = ["push"];
					if (subArgs) pushArgs.push(...subArgs.split(/\s+/));
					await notify("push", pushArgs);
				},

				// ── pull ──
				pull: async () => {
					const pullArgs = ["pull"];
					if (subArgs) pullArgs.push(...subArgs.split(/\s+/));
					await notify("pull", pullArgs);
				},

				// ── stash ──
				stash: async () => {
					if (subArgs) {
						// Direct subcommand: /git stash pop, /git stash drop stash@{1}, etc.
						await notify("stash", ["stash", ...subArgs.split(/\s+/)]);
					} else {
						await showStashViewer(pi, ctx, root);
					}
				},

				// ── branch ──
				branch: async () => {
					if (subArgs) {
						await notify("branch", ["branch", ...subArgs.split(/\s+/)]);
					} else {
						await showBranchViewer(pi, ctx, root);
					}
				},

				// ── checkout ──
				checkout: async () => {
					if (!subArgs) { ctx.ui.notify("Usage: /git checkout <branch|file>", "info"); return; }
					await notify("checkout", ["checkout", ...subArgs.split(/\s+/)]);
				},

				// ── switch ──
				switch: async () => {
					if (!subArgs) { ctx.ui.notify("Usage: /git switch <branch>", "info"); return; }
					await notify("switch", ["switch", ...subArgs.split(/\s+/)]);
				},

				// ── merge ──
				merge: async () => {
					if (!subArgs) { ctx.ui.notify("Usage: /git merge <branch>", "info"); return; }
					await notify("merge", ["merge", ...subArgs.split(/\s+/)]);
				},

				// ── rebase ──
				rebase: async () => {
					if (!subArgs) { ctx.ui.notify("Usage: /git rebase <branch>", "info"); return; }
					await notify("rebase", ["rebase", ...subArgs.split(/\s+/)]);
				},

				// ── reset ──
				reset: async () => {
					if (!subArgs) { ctx.ui.notify("Usage: /git reset <args>", "info"); return; }
					await notify("reset", ["reset", ...subArgs.split(/\s+/)]);
				},

				// ── restore ──
				restore: async () => {
					if (!subArgs) { ctx.ui.notify("Usage: /git restore <file>", "info"); return; }
					await notify("restore", ["restore", ...subArgs.split(/\s+/)]);
				},
			};

			// Direct subcommand
			if (sub && actions[sub]) {
				await actions[sub]();
				return;
			}

			// ── Interactive menu ──
			const choice = await ctx.ui.select("Git", [
				"📊 diff — Working tree changes",
				"📋 status — Stage/unstage/discard files",
				"📜 log — Commit graph",
				"💾 commit — Commit staged changes",
				"⬆️  push — Push to remote",
				"⬇️  pull — Pull from remote",
				"📦 stash — Stash manager",
				"🌿 branch — Branch manager",
			]);
			if (!choice) return;
			const cmd = choice.split(" ")[1]?.toLowerCase();
			if (cmd && actions[cmd]) {
				await actions[cmd]();
			}
		},
	});

	// ── Keyboard shortcut: Ctrl+G for quick git status ──
	pi.registerShortcut("ctrl+shift+g", {
		description: "Git status (interactive)",
		handler: async (ctx) => {
			const root = await gitRoot(pi, ctx.cwd);
			if (!root) { ctx.ui.notify("Not in a git repo", "error"); return; }
			await showInteractiveStatus(pi, ctx as ExtensionCommandContext, root);
		},
	});
}
