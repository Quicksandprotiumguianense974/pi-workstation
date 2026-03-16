/**
 * Background Tasks Extension
 *
 * Handles long-running commands (e.g. npm run dev) by running them in the background,
 * with task listing, log tailing, and stop controls.
 *
 * Features:
 * - Intercepts user `!` commands:
 *   - `!bg <command>` => always run in background
 *   - auto-detect long-running commands (npm/pnpm/yarn/bun dev/start/watch)
 * - Provides `bg_task` for LLM-driven task management
 * - `/bg` command family for management
 * - `bg_task` tool for LLM-driven task management
 *
 * Opinionated defaults (no env config):
 * - auto-detect long-running commands and background them immediately
 * - auto-background fallback after a fixed threshold for regular commands
 *
 * Storage:
 *   ~/.pi/agent/background-tasks/tasks.json
 *   ~/.pi/agent/background-tasks/logs/*.log
 *   ~/.pi/agent/background-tasks/exit/*.code
 */

import { spawn } from "node:child_process";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateTail,
} from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";

type TaskStatus = "running" | "exited" | "failed" | "stopped";

interface BackgroundTask {
	id: string;
	command: string;
	cwd: string;
	pid: number;
	status: TaskStatus;
	startedAt: number;
	stoppedAt?: number;
	exitCode?: number;
	logPath: string;
	exitCodePath: string;
	auto: boolean;
}

interface TaskStore {
	version: 1;
	tasks: BackgroundTask[];
}

const BASE_DIR = join(homedir(), ".pi", "agent", "background-tasks");
const LOG_DIR = join(BASE_DIR, "logs");
const EXIT_DIR = join(BASE_DIR, "exit");
const STORE_FILE = join(BASE_DIR, "tasks.json");

const DEFAULT_TAIL_LINES = 80;
const AUTO_BACKGROUND_AFTER_SEC = 30;
const MAX_TASKS_TO_KEEP = 400;

const LONG_RUNNING_PATTERNS: RegExp[] = [
	/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve|watch)\b/i,
	/\b(?:next|nuxt|vite|astro)\s+dev\b/i,
	/\b(?:webpack(?:-dev-server)?|nodemon)\b/i,
	/\btsc\b[^\n]*\b--watch\b/i,
	/\b(?:tail\s+-f|journalctl\s+-f)\b/i,
];

function ensureStorage(): void {
	mkdirSync(BASE_DIR, { recursive: true });
	mkdirSync(LOG_DIR, { recursive: true });
	mkdirSync(EXIT_DIR, { recursive: true });
}

function safeJsonParse<T>(raw: string, fallback: T): T {
	try {
		return JSON.parse(raw) as T;
	} catch {
		return fallback;
	}
}

function loadStore(): TaskStore {
	ensureStorage();
	if (!existsSync(STORE_FILE)) {
		return { version: 1, tasks: [] };
	}
	const raw = readFileSync(STORE_FILE, "utf8");
	const parsed = safeJsonParse<TaskStore>(raw, { version: 1, tasks: [] });
	if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.tasks)) {
		return { version: 1, tasks: [] };
	}
	return { version: 1, tasks: parsed.tasks };
}

function saveStore(store: TaskStore): void {
	ensureStorage();
	// Keep bounded history
	if (store.tasks.length > MAX_TASKS_TO_KEEP) {
		store.tasks = store.tasks.slice(-MAX_TASKS_TO_KEEP);
	}
	const tmp = `${STORE_FILE}.tmp`;
	writeFileSync(tmp, JSON.stringify(store, null, 2), "utf8");
	renameSync(tmp, STORE_FILE);
}

function makeTaskId(): string {
	return `bg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function q(value: string): string {
	return JSON.stringify(value);
}

function isPidAlive(pid: number): boolean {
	if (!Number.isFinite(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err: any) {
		return err?.code === "EPERM";
	}
}

function readExitCode(path: string): number | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const raw = readFileSync(path, "utf8").trim();
		if (!raw) return undefined;
		const n = Number(raw);
		return Number.isFinite(n) ? n : undefined;
	} catch {
		return undefined;
	}
}

function summarizeCommand(command: string, max = 72): string {
	const oneLine = command.replace(/\s+/g, " ").trim();
	if (oneLine.length <= max) return oneLine;
	return `${oneLine.slice(0, max - 1)}…`;
}

function shouldAutoBackground(command: string): boolean {
	const cmd = command.trim();
	if (!cmd) return false;
	if (/\s&\s*$/.test(cmd) || cmd.endsWith("&")) return false;
	if (/^nohup\b/i.test(cmd)) return false;
	return LONG_RUNNING_PATTERNS.some((rx) => rx.test(cmd));
}

function refreshTaskStatus(task: BackgroundTask): boolean {
	if (task.status !== "running") return false;
	const exitCode = readExitCode(task.exitCodePath);
	const alive = isPidAlive(task.pid);
	if (alive && exitCode === undefined) {
		return false;
	}

	// Task is no longer running (or exit code was recorded)
	task.exitCode = exitCode;
	task.stoppedAt = task.stoppedAt ?? Date.now();
	if (task.status !== "stopped") {
		if (exitCode === undefined || exitCode === 0) task.status = "exited";
		else task.status = "failed";
	}
	return true;
}

function syncTasks(): BackgroundTask[] {
	const store = loadStore();
	let changed = false;
	for (const task of store.tasks) {
		if (refreshTaskStatus(task)) changed = true;
	}
	if (changed) saveStore(store);
	return store.tasks;
}

function listTasksSorted(tasks: BackgroundTask[]): BackgroundTask[] {
	return [...tasks].sort((a, b) => b.startedAt - a.startedAt);
}

function resolveTask(tasks: BackgroundTask[], ref: string | undefined, cwd: string): BackgroundTask | undefined {
	const sorted = listTasksSorted(tasks);
	const token = (ref || "").trim();
	if (!token || token === "last" || token === "latest") {
		return (
			sorted.find((t) => t.cwd === cwd && t.status === "running") ||
			sorted.find((t) => t.cwd === cwd) ||
			sorted.find((t) => t.status === "running") ||
			sorted[0]
		);
	}

	const exact = sorted.find((t) => t.id === token);
	if (exact) return exact;

	const prefixMatches = sorted.filter((t) => t.id.startsWith(token));
	if (prefixMatches.length === 1) return prefixMatches[0];

	const asIndex = Number(token);
	if (Number.isInteger(asIndex) && asIndex > 0 && asIndex <= sorted.length) {
		return sorted[asIndex - 1];
	}

	return undefined;
}

function formatTaskLine(task: BackgroundTask, index: number): string {
	const icon = task.status === "running" ? "●" : task.status === "failed" ? "✖" : task.status === "stopped" ? "■" : "○";
	const when = new Date(task.startedAt).toLocaleTimeString();
	const exit = task.exitCode !== undefined ? ` exit=${task.exitCode}` : "";
	return `${index}. ${icon} ${task.id}  ${task.status}${exit}  pid=${task.pid}  ${basename(task.cwd)}  ${when}  ${summarizeCommand(task.command)}`;
}

function formatList(tasks: BackgroundTask[], cwd: string): string {
	if (tasks.length === 0) return "No background tasks.";
	const sorted = listTasksSorted(tasks);
	const running = sorted.filter((t) => t.status === "running");
	const local = sorted.filter((t) => t.cwd === cwd);
	const scope = local.length > 0 ? local : sorted;
	const lines = [
		`Background tasks: ${running.length} running / ${sorted.length} total`,
		...(scope.slice(0, 20).map((t, i) => formatTaskLine(t, i + 1))),
	];
	if (scope.length > 20) lines.push(`... and ${scope.length - 20} more`);
	return lines.join("\n");
}

function tailFile(path: string, lines = DEFAULT_TAIL_LINES, maxBytes = 256 * 1024): string {
	if (!existsSync(path)) return "(log file not found yet)";
	let fd: number | undefined;
	try {
		const st = statSync(path);
		if (st.size <= 0) return "(no log output yet)";
		const bytesToRead = Math.min(st.size, maxBytes);
		const start = st.size - bytesToRead;
		const buffer = Buffer.alloc(bytesToRead);
		fd = openSync(path, "r");
		readSync(fd, buffer, 0, bytesToRead, start);
		let text = buffer.toString("utf8");

		// If we started in the middle, drop first partial line
		if (start > 0) {
			const firstNewline = text.indexOf("\n");
			if (firstNewline >= 0) text = text.slice(firstNewline + 1);
		}

		const arr = text.split("\n").filter((line, idx, src) => !(idx === src.length - 1 && line === ""));
		const tailed = arr.slice(-Math.max(1, lines));
		if (tailed.length === 0) return "(no log output yet)";
		return tailed.join("\n");
	} catch {
		return "(failed to read logs)";
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

function updateFooterStatus(ctx: ExtensionContext, tasks: BackgroundTask[]) {
	const running = tasks.filter((t) => t.status === "running").length;
	ctx.ui.setStatus("bg-tasks", running > 0 ? `bg:${running}` : undefined);
}

function startTask(command: string, cwd: string, auto: boolean): BackgroundTask {
	ensureStorage();

	const id = makeTaskId();
	const logPath = join(LOG_DIR, `${id}.log`);
	const exitCodePath = join(EXIT_DIR, `${id}.code`);
	const startedAt = Date.now();

	writeFileSync(
		logPath,
		`[pi-bg] task=${id} started=${new Date(startedAt).toISOString()} cwd=${cwd}\n[pi-bg] command: ${command}\n\n`,
		"utf8",
	);

	const wrappedScript = [
		`bash -lc ${q(command)} >> ${q(logPath)} 2>&1`,
		"code=$?",
		`echo "[pi-bg] exited code=$code at $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> ${q(logPath)}`,
		`printf "%s" "$code" > ${q(exitCodePath)}`,
		"exit $code",
	].join("\n");

	// Always use bash for the wrapper script (it uses bash syntax like $?, $code)
	const child = spawn("/bin/bash", ["-c", wrappedScript], {
		cwd,
		detached: true,
		stdio: "ignore",
		env: { ...process.env },
	});

	if (!child.pid) {
		throw new Error("failed to spawn background process");
	}

	child.unref();

	const task: BackgroundTask = {
		id,
		command,
		cwd,
		pid: child.pid,
		status: "running",
		startedAt,
		logPath,
		exitCodePath,
		auto,
	};

	const store = loadStore();
	store.tasks.push(task);
	saveStore(store);
	return task;
}

function finalizeAndRemoveTask(taskId: string, removeArtifacts = true): void {
	const store = loadStore();
	const index = store.tasks.findIndex((t) => t.id === taskId);
	if (index < 0) return;
	const [task] = store.tasks.splice(index, 1);
	saveStore(store);
	if (!removeArtifacts) return;
	try {
		rmSync(task.logPath, { force: true });
	} catch {}
	try {
		rmSync(task.exitCodePath, { force: true });
	} catch {}
}

function renderForegroundOutput(task: BackgroundTask): {
	output: string;
	truncated: boolean;
	fullOutputPath?: string;
	details: {
		truncation?: ReturnType<typeof truncateTail>;
		fullOutputPath?: string;
	};
} {
	let text = "";
	try {
		text = readFileSync(task.logPath, "utf8");
	} catch {
		text = "";
	}

	// Strip extension metadata header/trailer
	text = text.replace(/^\[pi-bg\][^\n]*\n\[pi-bg\][^\n]*\n\n?/, "");
	text = text.replace(/\n?\[pi-bg\] exited code=.*(?:\n)?$/m, "");

	const truncation = truncateTail(text, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});

	let output = truncation.content || "(no output)";
	if (truncation.truncated) {
		if (truncation.truncatedBy === "lines") {
			output += `\n\n[Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines. Full output: ${task.logPath}]`;
		} else {
			output += `\n\n[Truncated to ${formatSize(DEFAULT_MAX_BYTES)}. Full output: ${task.logPath}]`;
		}
	}

	return {
		output,
		truncated: truncation.truncated,
		fullOutputPath: truncation.truncated ? task.logPath : undefined,
		details: {
			truncation: truncation.truncated ? truncation : undefined,
			fullOutputPath: truncation.truncated ? task.logPath : undefined,
		},
	};
}

async function runWithThreshold(
	command: string,
	cwd: string,
	auto: boolean,
	thresholdSec: number,
): Promise<
	| {
			mode: "foreground";
			task: BackgroundTask;
			exitCode: number;
			output: string;
			truncated: boolean;
			fullOutputPath?: string;
			details: {
				truncation?: ReturnType<typeof truncateTail>;
				fullOutputPath?: string;
			};
	  }
	| {
			mode: "background";
			task: BackgroundTask;
	  }
> {
	const task = startTask(command, cwd, auto);
	const deadline = Date.now() + Math.max(0.1, thresholdSec) * 1000;

	while (Date.now() < deadline) {
		const exitCode = readExitCode(task.exitCodePath);
		if (exitCode !== undefined) break;
		if (!isPidAlive(task.pid)) break;
		await sleep(200);
	}

	const store = loadStore();
	const current = store.tasks.find((t) => t.id === task.id) ?? task;
	const changed = refreshTaskStatus(current);
	if (changed) saveStore(store);

	if (current.status === "running") {
		return { mode: "background", task: current };
	}

	const rendered = renderForegroundOutput(current);
	const normalizedExitCode =
		typeof current.exitCode === "number"
			? current.exitCode
			: current.status === "failed"
				? 1
				: 0;

	finalizeAndRemoveTask(current.id, !rendered.truncated);

	return {
		mode: "foreground",
		task: current,
		exitCode: normalizedExitCode,
		output: rendered.output,
		truncated: rendered.truncated,
		fullOutputPath: rendered.fullOutputPath,
		details: rendered.details,
	};
}

function signalTask(pid: number, signal: NodeJS.Signals): boolean {
	try {
		process.kill(-pid, signal); // process group first
		return true;
	} catch {}
	try {
		process.kill(pid, signal);
		return true;
	} catch {}
	return false;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function stopTask(task: BackgroundTask): Promise<{ ok: boolean; message: string }> {
	if (task.status !== "running") {
		return { ok: true, message: `${task.id} is already ${task.status}` };
	}

	const signalled = signalTask(task.pid, "SIGTERM");
	if (!signalled) {
		const store = loadStore();
		const target = store.tasks.find((t) => t.id === task.id);
		if (target) {
			target.status = "stopped";
			target.stoppedAt = Date.now();
			target.exitCode = 143;
			saveStore(store);
		}
		return { ok: false, message: `Could not signal pid ${task.pid}; marked as stopped.` };
	}

	await sleep(1200);
	if (isPidAlive(task.pid)) {
		signalTask(task.pid, "SIGKILL");
	}

	const store = loadStore();
	const target = store.tasks.find((t) => t.id === task.id);
	if (target) {
		target.status = "stopped";
		target.stoppedAt = Date.now();
		target.exitCode = 143;
		try {
			writeFileSync(target.exitCodePath, "143", "utf8");
		} catch {}
		saveStore(store);
	}

	return { ok: true, message: `Stopped ${task.id} (pid ${task.pid})` };
}

function cleanupFinishedTasks(): { removed: number; kept: number } {
	const store = loadStore();
	const keep: BackgroundTask[] = [];
	let removed = 0;
	for (const task of store.tasks) {
		if (task.status === "running") {
			keep.push(task);
			continue;
		}
		removed++;
		try {
			rmSync(task.logPath, { force: true });
		} catch {}
		try {
			rmSync(task.exitCodePath, { force: true });
		} catch {}
	}
	store.tasks = keep;
	saveStore(store);
	return { removed, kept: keep.length };
}

function startedMessage(task: BackgroundTask): string {
	const mode = task.auto ? "auto" : "manual";
	return [
		`Started background task (${mode}): ${task.id}`,
		`PID: ${task.pid}`,
		`CWD: ${task.cwd}`,
		`Log: ${task.logPath}`,
		`Use /bg logs ${task.id} (or /bg stop ${task.id})`,
	].join("\n");
}

function commandHelp(): string {
	const lines = [
		"/bg list",
		"/bg start <command>",
		"/bg stop [id|last|all]",
		"/bg logs [id|last] [lines]",
		"/bg clean",
		"Tip: !bg <command> starts directly in background",
		`Auto fallback: commands exceeding ${AUTO_BACKGROUND_AFTER_SEC}s are backgrounded.`,
	];
	return lines.join("\n");
}

function parseLogsArgs(rest: string[]): { ref?: string; lines: number } {
	if (rest.length === 0) return { lines: DEFAULT_TAIL_LINES };
	const maybeLines = rest[rest.length - 1];
	if (/^\d+$/.test(maybeLines)) {
		const lines = Math.max(1, Math.min(500, Number(maybeLines)));
		const ref = rest.slice(0, -1).join(" ").trim() || undefined;
		return { ref, lines };
	}
	return { ref: rest.join(" ").trim() || undefined, lines: DEFAULT_TAIL_LINES };
}

export default function (pi: ExtensionAPI) {
	function refreshAndStatus(ctx: ExtensionContext): BackgroundTask[] {
		const tasks = syncTasks();
		updateFooterStatus(ctx, tasks);
		return tasks;
	}

	// ---- LLM tool for background task management ----
	pi.registerTool({
		name: "bg_task",
		label: "Background Task",
		description: "Manage long-running background tasks: start/list/logs/stop/cleanup",
		promptSnippet: "Start and manage long-running background processes (dev servers, watch tasks).",
		promptGuidelines: [
			"Use this tool instead of bash for commands that keep running (dev servers, watch mode).",
			"After start, use action=logs to verify readiness, and action=stop when done.",
		],
		parameters: Type.Object({
			action: StringEnum(["list", "start", "logs", "stop", "cleanup"] as const),
			command: Type.Optional(Type.String({ description: "Command to run (required for action=start)" })),
			id: Type.Optional(Type.String({ description: "Task ID, prefix, index, or 'last'" })),
			lines: Type.Optional(Type.Number({ description: "Lines for logs", minimum: 1, maximum: 500 })),
		}),
		async execute(_toolCallId, params: any, _signal, _onUpdate, ctx) {
			const action = String(params?.action || "");
			if (action === "list") {
				const tasks = refreshAndStatus(ctx);
				return { content: [{ type: "text", text: formatList(tasks, ctx.cwd) }], details: {} };
			}
			if (action === "start") {
				const command = String(params?.command || "").trim();
				if (!command) {
					return { content: [{ type: "text", text: "Error: missing command for action=start" }], details: {} };
				}
				const task = startTask(command, ctx.cwd, false);
				refreshAndStatus(ctx);
				return { content: [{ type: "text", text: startedMessage(task) }], details: { id: task.id, logPath: task.logPath } };
			}
			if (action === "logs") {
				const tasks = refreshAndStatus(ctx);
				const task = resolveTask(tasks, params?.id ? String(params.id) : undefined, ctx.cwd);
				if (!task) {
					return { content: [{ type: "text", text: "Error: task not found" }], details: {} };
				}
				const lines = Math.max(1, Math.min(500, Number(params?.lines || DEFAULT_TAIL_LINES)));
				const tail = tailFile(task.logPath, lines);
				return {
					content: [{ type: "text", text: `[${task.id}] ${task.command}\n${tail}` }],
					details: { id: task.id, logPath: task.logPath },
				};
			}
			if (action === "stop") {
				const tasks = refreshAndStatus(ctx);
				const ref = params?.id ? String(params.id) : undefined;
				if (ref === "all") {
					const running = tasks.filter((t) => t.status === "running");
					const messages: string[] = [];
					for (const task of running) {
						const r = await stopTask(task);
						messages.push(r.message);
					}
					refreshAndStatus(ctx);
					return { content: [{ type: "text", text: messages.length > 0 ? messages.join("\n") : "No running tasks." }], details: {} };
				}

				const task = resolveTask(tasks, ref, ctx.cwd);
				if (!task) {
					return { content: [{ type: "text", text: "Error: task not found" }], details: {} };
				}
				const result = await stopTask(task);
				refreshAndStatus(ctx);
				return { content: [{ type: "text", text: result.message }], details: { id: task.id } };
			}
			if (action === "cleanup") {
				const result = cleanupFinishedTasks();
				refreshAndStatus(ctx);
				return {
					content: [{ type: "text", text: `Cleaned ${result.removed} finished tasks. Kept ${result.kept} running tasks.` }],
					details: result,
				};
			}

			return { content: [{ type: "text", text: `Error: unknown action: ${action}` }], details: {} };
		},
	});

	// ---- User command: /bg ----
	pi.registerCommand("bg", {
		description: "Manage background tasks: list/start/logs/stop/clean",
		handler: async (args, ctx) => {
			const raw = (args || "").trim();
			if (!raw) {
				const tasks = refreshAndStatus(ctx);
				ctx.ui.notify(formatList(tasks, ctx.cwd), "info");
				return;
			}

			const parts = raw.split(/\s+/).filter(Boolean);
			const sub = (parts[0] || "").toLowerCase();
			const rest = parts.slice(1);

			if (sub === "list" || sub === "ls") {
				const tasks = refreshAndStatus(ctx);
				ctx.ui.notify(formatList(tasks, ctx.cwd), "info");
				return;
			}

			if (sub === "start") {
				const command = raw.slice("start".length).trim();
				if (!command) {
					ctx.ui.notify(commandHelp(), "warning");
					return;
				}
				const task = startTask(command, ctx.cwd, false);
				refreshAndStatus(ctx);
				ctx.ui.notify(startedMessage(task), "info");
				return;
			}

			if (sub === "logs" || sub === "log") {
				const { ref, lines } = parseLogsArgs(rest);
				const tasks = refreshAndStatus(ctx);
				const task = resolveTask(tasks, ref, ctx.cwd);
				if (!task) {
					ctx.ui.notify("Task not found", "warning");
					return;
				}
				const tail = tailFile(task.logPath, lines);
				ctx.ui.notify(`[${task.id}] ${task.command}\n${tail}`, "info");
				return;
			}

			if (sub === "stop") {
				const ref = rest.join(" ").trim() || "last";
				const tasks = refreshAndStatus(ctx);
				if (ref === "all") {
					const running = tasks.filter((t) => t.status === "running");
					if (running.length === 0) {
						ctx.ui.notify("No running tasks.", "info");
						return;
					}
					const ok = await ctx.ui.confirm("Stop all background tasks?", `${running.length} running tasks will be stopped.`);
					if (!ok) return;
					const msgs: string[] = [];
					for (const task of running) {
						const r = await stopTask(task);
						msgs.push(r.message);
					}
					refreshAndStatus(ctx);
					ctx.ui.notify(msgs.join("\n"), "info");
					return;
				}

				const task = resolveTask(tasks, ref, ctx.cwd);
				if (!task) {
					ctx.ui.notify("Task not found", "warning");
					return;
				}
				const result = await stopTask(task);
				refreshAndStatus(ctx);
				ctx.ui.notify(result.message, result.ok ? "info" : "warning");
				return;
			}

			if (sub === "clean" || sub === "cleanup") {
				const result = cleanupFinishedTasks();
				refreshAndStatus(ctx);
				ctx.ui.notify(`Cleaned ${result.removed} finished tasks.`, "info");
				return;
			}

			if (sub === "help") {
				ctx.ui.notify(commandHelp(), "info");
				return;
			}

			// Fallback: /bg <command> means start
			const task = startTask(raw, ctx.cwd, false);
			refreshAndStatus(ctx);
			ctx.ui.notify(startedMessage(task), "info");
		},
	});

	// ---- Intercept user ! commands ----
	pi.on("user_bash", async (event, ctx) => {
		let command = event.command.trim();
		if (!command) return;

		let explicit = false;
		if (command.startsWith("bg ")) {
			explicit = true;
			command = command.slice(3).trim();
		}

		if (!command) {
			return {
				result: {
					output: "Usage: !bg <command>",
					exitCode: 1,
					cancelled: false,
					truncated: false,
				},
			};
		}

		if (explicit || shouldAutoBackground(command)) {
			const task = startTask(command, event.cwd, !explicit);
			refreshAndStatus(ctx);

			return {
				result: {
					output: startedMessage(task),
					exitCode: 0,
					cancelled: false,
					truncated: false,
					fullOutputPath: task.logPath,
				},
			};
		}

		const run = await runWithThreshold(command, event.cwd, true, AUTO_BACKGROUND_AFTER_SEC);
		if (run.mode === "background") {
			refreshAndStatus(ctx);
			return {
				result: {
					output:
						startedMessage(run.task) +
						`\nAuto-backgrounded after ${AUTO_BACKGROUND_AFTER_SEC}s.`,
					exitCode: 0,
					cancelled: false,
					truncated: false,
					fullOutputPath: run.task.logPath,
				},
			};
		}

		return {
			result: {
				output: run.output,
				exitCode: run.exitCode,
				cancelled: false,
				truncated: run.truncated,
				fullOutputPath: run.fullOutputPath,
			},
		};
	});

	// ---- Status lifecycle ----
	pi.on("session_start", async (_event, ctx) => {
		const tasks = refreshAndStatus(ctx);
		const running = tasks.filter((t) => t.status === "running").length;
		if (running > 0) {
			ctx.ui.notify(`background-tasks: ${running} task(s) still running. Use /bg list`, "info");
		}
	});

	pi.on("session_switch", async (_event, ctx) => {
		refreshAndStatus(ctx);
	});

	pi.on("turn_end", async (_event, ctx) => {
		refreshAndStatus(ctx);
	});
}
