/**
 * Project Manager Extension (Linear-lite MVP+)
 *
 * Current spec:
 * - Board file: <repo>/.pi/project-board.json
 * - Statuses: backlog | in_progress | done
 * - IDs: PM-1, PM-2, ...
 * - Agent tool supports: list/get/add/remove/update/move
 * - remove is direct (no confirmation)
 * - /pm supports interactive add/edit and richer board details
 *
 * Phase-2 reserve:
 * - resolveBoardPath(cwd, scope) supports scope="repo" | "cwd"
 */

import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Key, Markdown, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { execSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

type IssueStatus = "backlog" | "in_progress" | "done";

interface Issue {
	id: string;
	title: string;
	status: IssueStatus;
	description?: string;
	labels?: string[];
	assignee?: string;
	dueDate?: string; // YYYY-MM-DD
	createdAt: number;
	updatedAt: number;
}

interface Board {
	version: 1;
	nextId: number;
	issues: Issue[];
	updatedAt: number;
}

interface BoardCounts {
	backlog: number;
	inProgress: number;
	done: number;
	total: number;
}

interface ToolDetails {
	action: string;
	boardPath: string;
	counts: BoardCounts;
	issue?: Issue;
	issues?: Issue[];
	nextUp?: Issue[];
	error?: string;
}

interface UIState {
	activeColumn: number;
	selectedIndex: number;
}

interface IssueInput {
	title: string;
	status?: IssueStatus;
	description?: string;
	labels?: string[];
	assignee?: string;
	dueDate?: string;
}

interface IssuePatch {
	title?: string;
	status?: IssueStatus;
	description?: string;
	labels?: string[];
	assignee?: string;
	dueDate?: string;
}

type PMAction =
	| { type: "exit"; state: UIState }
	| { type: "add"; state: UIState }
	| { type: "remove"; id: string; state: UIState }
	| { type: "move"; id: string; status: IssueStatus; state: UIState }
	| { type: "show"; id: string; state: UIState }
	| { type: "edit"; id: string; state: UIState };

const STATUS_ORDER: IssueStatus[] = ["backlog", "in_progress", "done"];
const STATUS_LABEL: Record<IssueStatus, string> = {
	backlog: "Backlog",
	in_progress: "In Progress",
	done: "Done",
};


const PMToolParams = Type.Object({
	action: StringEnum(["list", "get", "add", "remove", "update", "move"] as const),
	id: Type.Optional(Type.String({ description: "Issue ID, e.g. PM-1" })),
	title: Type.Optional(Type.String({ description: "Issue title" })),
	description: Type.Optional(Type.String({ description: "Issue description" })),
	labels: Type.Optional(Type.Array(Type.String(), { description: "Labels" })),
	assignee: Type.Optional(Type.String({ description: "Assignee" })),
	dueDate: Type.Optional(Type.String({ description: "Due date (YYYY-MM-DD)" })),
	status: Type.Optional(
		StringEnum(["backlog", "in_progress", "done", "in-progress", "inprogress", "todo", "doing"] as const),
	),
	patch: Type.Optional(
		Type.Object({
			title: Type.Optional(Type.String()),
			description: Type.Optional(Type.String()),
			labels: Type.Optional(Type.Array(Type.String())),
			assignee: Type.Optional(Type.String()),
			dueDate: Type.Optional(Type.String()),
					status: Type.Optional(
				StringEnum(["backlog", "in_progress", "done", "in-progress", "inprogress", "todo", "doing"] as const),
			),
		}),
	),
});

function createEmptyBoard(): Board {
	return {
		version: 1,
		nextId: 1,
		issues: [],
		updatedAt: Date.now(),
	};
}

function getRepoRoot(cwd: string): string {
	try {
		const out = execSync("git rev-parse --show-toplevel", {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		return out || cwd;
	} catch {
		return cwd;
	}
}

function resolveBoardPath(cwd: string, scope: "repo" | "cwd" = "repo"): string {
	const root = scope === "cwd" ? cwd : getRepoRoot(cwd);
	return join(root, ".pi", "project-board.json");
}

function normalizeStatus(input?: string): IssueStatus | undefined {
	if (!input) return undefined;
	const normalized = input.trim().toLowerCase();
	if (normalized === "backlog" || normalized === "todo") return "backlog";
	if (normalized === "in_progress" || normalized === "in-progress" || normalized === "inprogress" || normalized === "doing") {
		return "in_progress";
	}
	if (normalized === "done") return "done";
	return undefined;
}

function normalizeDueDate(input?: string): string | undefined {
	if (input === undefined) return undefined;
	const value = input.trim();
	if (!value) return undefined;
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
		throw new Error("dueDate must be YYYY-MM-DD");
	}
	const [y, m, d] = value.split("-").map((n) => Number(n));
	const dt = new Date(Date.UTC(y, m - 1, d));
	if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
		throw new Error("dueDate is not a valid calendar date");
	}
	return value;
}

function normalizeLabels(input?: string[]): string[] | undefined {
	if (input === undefined) return undefined;
	const out = Array.from(new Set(input.map((l) => l.trim()).filter(Boolean)));
	return out.length > 0 ? out : undefined;
}

function normalizeAssignee(input?: string): string | undefined {
	if (input === undefined) return undefined;
	const v = input.trim();
	return v || undefined;
}

function normalizeDescription(input?: string): string | undefined {
	if (input === undefined) return undefined;
	const v = input.trim();
	return v || undefined;
}

function validateBoard(raw: unknown): Board {
	if (!raw || typeof raw !== "object") throw new Error("Board JSON is not an object");
	const data = raw as Partial<Board> & { issues?: unknown[] };
	if (data.version !== 1) throw new Error(`Unsupported board version: ${String(data.version)}`);
	if (!Array.isArray(data.issues)) throw new Error("Board.issues must be an array");
	if (typeof data.nextId !== "number" || !Number.isFinite(data.nextId) || data.nextId < 1) {
		throw new Error("Board.nextId must be a positive number");
	}

	const issues: Issue[] = data.issues.map((issue, i) => {
		if (!issue || typeof issue !== "object") throw new Error(`Issue at index ${i} is invalid`);
		const item = issue as Partial<Issue>;
		const status = normalizeStatus(item.status);
		if (!item.id || typeof item.id !== "string") throw new Error(`Issue ${i} missing id`);
		if (!item.title || typeof item.title !== "string") throw new Error(`Issue ${item.id} missing title`);
		if (!status) throw new Error(`Issue ${item.id} has invalid status`);
		if (typeof item.createdAt !== "number") throw new Error(`Issue ${item.id} missing createdAt`);
		if (typeof item.updatedAt !== "number") throw new Error(`Issue ${item.id} missing updatedAt`);

		const labels = normalizeLabels(Array.isArray(item.labels) ? item.labels : undefined);
		const description = normalizeDescription(item.description);
		const assignee = normalizeAssignee(item.assignee);
		const dueDate = normalizeDueDate(item.dueDate);

		return {
			id: item.id,
			title: item.title,
			status,
			description,
			labels,
			assignee,
			dueDate,
			createdAt: item.createdAt,
			updatedAt: item.updatedAt,
		};
	});

	return {
		version: 1,
		nextId: data.nextId,
		issues,
		updatedAt: typeof data.updatedAt === "number" ? data.updatedAt : Date.now(),
	};
}

function loadBoard(boardPath: string): Board {
	if (!existsSync(boardPath)) return createEmptyBoard();
	const json = readFileSync(boardPath, "utf8");
	const parsed = JSON.parse(json);
	return validateBoard(parsed);
}

function saveBoard(boardPath: string, board: Board): void {
	mkdirSync(dirname(boardPath), { recursive: true });
	board.updatedAt = Date.now();
	const tempFile = `${boardPath}.tmp-${process.pid}-${Date.now()}`;
	writeFileSync(tempFile, `${JSON.stringify(board, null, 2)}\n`, "utf8");
	renameSync(tempFile, boardPath);
}

function getCounts(board: Board): BoardCounts {
	let backlog = 0;
	let inProgress = 0;
	let done = 0;
	for (const issue of board.issues) {
		if (issue.status === "backlog") backlog++;
		else if (issue.status === "in_progress") inProgress++;
		else done++;
	}
	return { backlog, inProgress, done, total: board.issues.length };
}

function getIssue(board: Board, id: string): Issue {
	const issue = board.issues.find((item) => item.id.toLowerCase() === id.toLowerCase());
	if (!issue) throw new Error(`Issue not found: ${id}`);
	return issue;
}

function addIssue(board: Board, input: IssueInput): Issue {
	const title = input.title.trim();
	if (!title) throw new Error("title is required");

	const now = Date.now();
	const issue: Issue = {
		id: `PM-${board.nextId}`,
		title,
		status: input.status ?? "backlog",
		description: normalizeDescription(input.description),
		labels: normalizeLabels(input.labels),
		assignee: normalizeAssignee(input.assignee),
		dueDate: normalizeDueDate(input.dueDate),
		createdAt: now,
		updatedAt: now,
	};

	board.nextId += 1;
	board.issues.push(issue);
	return issue;
}

function updateIssue(board: Board, id: string, patch: IssuePatch): Issue {
	const issue = getIssue(board, id);
	let changed = false;

	if (patch.title !== undefined) {
		const title = patch.title.trim();
		if (!title) throw new Error("title cannot be empty");
		issue.title = title;
		changed = true;
	}
	if (patch.status !== undefined) {
		issue.status = patch.status;
		changed = true;
	}
	if (patch.description !== undefined) {
		issue.description = normalizeDescription(patch.description);
		changed = true;
	}
	if (patch.labels !== undefined) {
		issue.labels = normalizeLabels(patch.labels);
		changed = true;
	}
	if (patch.assignee !== undefined) {
		issue.assignee = normalizeAssignee(patch.assignee);
		changed = true;
	}
	if (patch.dueDate !== undefined) {
		issue.dueDate = normalizeDueDate(patch.dueDate);
		changed = true;
	}

	if (!changed) throw new Error("update requires at least one field");
	issue.updatedAt = Date.now();
	return issue;
}

function moveIssue(board: Board, id: string, status: IssueStatus): Issue {
	const issue = getIssue(board, id);
	issue.status = status;
	issue.updatedAt = Date.now();
	return issue;
}

function removeIssue(board: Board, id: string): Issue {
	const idx = board.issues.findIndex((item) => item.id.toLowerCase() === id.toLowerCase());
	if (idx < 0) throw new Error(`Issue not found: ${id}`);
	const [removed] = board.issues.splice(idx, 1);
	return removed;
}

function parseIssueId(value: string | undefined): string {
	if (!value) throw new Error("id is required");
	return value.trim();
}

function formatTs(ts: number): string {
	try {
		return new Date(ts).toLocaleString();
	} catch {
		return String(ts);
	}
}

function formatIssue(issue: Issue): string {
	return [`${issue.id}`, `[${STATUS_LABEL[issue.status]}]`, issue.title].join(" ");
}

function formatIssueDetails(issue: Issue): string {
	const lines: string[] = [];
	lines.push(formatIssue(issue));
	lines.push(`Assignee: ${issue.assignee ?? "-"}`);
	lines.push(`Due: ${issue.dueDate ?? "-"}`);
	lines.push(`Labels: ${issue.labels && issue.labels.length > 0 ? issue.labels.join(", ") : "-"}`);
	lines.push(`Created: ${formatTs(issue.createdAt)}`);
	lines.push(`Updated: ${formatTs(issue.updatedAt)}`);
	lines.push("Description:");
	lines.push(issue.description ?? "(empty)");
	return lines.join("\n");
}

function statusRank(status: IssueStatus): number {
	switch (status) {
		case "in_progress": return 0;
		case "backlog": return 1;
		case "done": return 2;
	}
}

function sortIssuesForAction(issues: Issue[]): Issue[] {
	return [...issues].sort((a, b) => {
		const sr = statusRank(a.status) - statusRank(b.status);
		if (sr !== 0) return sr;
		return b.updatedAt - a.updatedAt;
	});
}

function getNextUp(board: Board, limit = 6): Issue[] {
	return sortIssuesForAction(board.issues.filter((issue) => issue.status !== "done")).slice(0, limit);
}

function formatBoard(board: Board): string {
	const lines: string[] = [];
	for (const status of STATUS_ORDER) {
		const group = sortIssuesForAction(board.issues.filter((issue) => issue.status === status));
		lines.push(`${STATUS_LABEL[status]} (${group.length})`);
		if (group.length === 0) {
			lines.push("  (empty)");
			continue;
		}
		for (const issue of group) {
			lines.push(`  - ${issue.id} ${issue.title}`);
		}
		lines.push("");
	}
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines.join("\n");
}

function statusSummary(theme: Theme, board: Board): string {
	const counts = getCounts(board);
	const nextUp = getNextUp(board, 2);

	let s = theme.fg("accent", "PM");
	if (counts.total === 0) return s + " " + theme.fg("dim", "empty");
	s += " " + theme.fg("dim", `B:${counts.backlog} P:${counts.inProgress} D:${counts.done}`);
	if (nextUp.length > 0) {
		const summary = nextUp.map((issue) => `${issue.id}:${issue.title}`).join(" · ");
		s += " " + theme.fg("muted", `| ${summary}`);
	}
	return s;
}

function startTicker(_ctx: ExtensionContext, _boardPath: string): void {}

function stopTicker(): void {}

function refreshFooterStatus(ctx: ExtensionContext, boardPath: string): void {
	try {
		const board = loadBoard(boardPath);
		const summary = statusSummary(ctx.ui.theme, board);
		ctx.ui.setStatus("project-manager", summary);
		(globalThis as any).__piPMStatus = summary;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		ctx.ui.setStatus("project-manager", ctx.ui.theme.fg("warning", `PM error: ${message}`));
		(globalThis as any).__piPMStatus = undefined;
	}
}

function details(action: string, boardPath: string, board: Board, issue?: Issue, error?: string): ToolDetails {
	return {
		action,
		boardPath,
		counts: getCounts(board),
		issue,
		nextUp: getNextUp(board),
		error,
	};
}

function parseLabelsCsv(text: string): string[] | undefined {
	return normalizeLabels(text.split(","));
}

function padToWidth(input: string, width: number): string {
	const truncated = truncateToWidth(input, width);
	const pad = Math.max(0, width - visibleWidth(truncated));
	return truncated + " ".repeat(pad);
}

function getStatusIssues(board: Board, status: IssueStatus): Issue[] {
	return sortIssuesForAction(board.issues.filter((issue) => issue.status === status));
}

function nextStatus(status: IssueStatus): IssueStatus {
	if (status === "backlog") return "in_progress";
	if (status === "in_progress") return "done";
	return "backlog";
}

async function pickStatus(ctx: ExtensionContext, current: IssueStatus): Promise<IssueStatus | undefined> {
	const ordered = [current, ...STATUS_ORDER.filter((s) => s !== current)];
	const labels = ordered.map((s) => `${STATUS_LABEL[s]}${s === current ? " (current)" : ""}`);
	const selected = await ctx.ui.select("Status", labels);
	if (!selected) return undefined;
	const idx = labels.indexOf(selected);
	return ordered[idx >= 0 ? idx : 0];
}

async function promptIssueForm(
	ctx: ExtensionContext,
	seed: {
		title?: string;
		status?: IssueStatus;
		description?: string;
		labels?: string[];
		assignee?: string;
		dueDate?: string;
	},
	mode: "create" | "edit",
): Promise<IssueInput | undefined> {
	if (!ctx.hasUI) return undefined;

	const title = await ctx.ui.input(mode === "create" ? "Issue title:" : "Issue title (edit):", seed.title ?? "");
	if (title === undefined) return undefined;
	if (!title.trim()) {
		ctx.ui.notify("Title cannot be empty", "error");
		return undefined;
	}

	const description = await ctx.ui.editor(
		mode === "create" ? "Description (optional):" : "Description (edit, optional):",
		seed.description ?? "",
	);
	if (description === undefined) return undefined;

	const status = await pickStatus(ctx, seed.status ?? "backlog");
	if (!status) return undefined;

	const assignee = await ctx.ui.input("Assignee (optional):", seed.assignee ?? "");
	if (assignee === undefined) return undefined;

	const dueDateRaw = await ctx.ui.input("Due date (YYYY-MM-DD, optional):", seed.dueDate ?? "");
	if (dueDateRaw === undefined) return undefined;

	const labelsRaw = await ctx.ui.input("Labels (comma-separated, optional):", (seed.labels ?? []).join(", "));
	if (labelsRaw === undefined) return undefined;

	const dueDate = normalizeDueDate(dueDateRaw);

	return {
		title: title.trim(),
		description,
		status,
		assignee,
		dueDate,
		labels: parseLabelsCsv(labelsRaw) ?? [],
	};
}

function sendDisplay(pi: ExtensionAPI, text: string): void {
	pi.sendMessage({ customType: "pm-log", content: text, display: true }, { triggerTurn: false });
}

export default function projectManagerExtension(pi: ExtensionAPI) {
	pi.registerMessageRenderer("pm-log", (message, _options, theme) => {
		const content = typeof message.content === "string" ? message.content : String(message.content ?? "");
		return {
			render(width: number) {
				return content.split("\n").map((line) => truncateToWidth(`${theme.fg("accent", "[pm] ")}${line}`, width));
			},
			invalidate() {},
		};
	});

	pi.registerTool({
		name: "project_manager",
		label: "Project Manager",
		description:
			"Manage the local task board in <repo>/.pi/project-board.json. Use this proactively for daily task tracking: " +
			"capture review findings, convert plans into executable tasks, reprioritize work, inspect what to do now, and keep progress current. " +
			"Actions: list, get, add, remove, update, move.",
		parameters: PMToolParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const boardPath = resolveBoardPath(ctx.cwd, "repo");

			try {
				const board = loadBoard(boardPath);
				switch (params.action) {
					case "list": {
						const text = board.issues.length > 0 ? formatBoard(board) : "No issues";
						return {
							content: [{ type: "text", text }],
							details: { ...details("list", boardPath, board), issues: [...board.issues] },
						};
					}
					case "get": {
						const issue = getIssue(board, parseIssueId(params.id));
						return {
							content: [{ type: "text", text: formatIssueDetails(issue) }],
							details: details("get", boardPath, board, issue),
						};
					}
					case "add": {
						if (!params.title) throw new Error("title is required for add");
						const input: IssueInput = {
							title: params.title,
							status: normalizeStatus(params.status),
							description: params.description,
							labels: normalizeLabels(params.labels) ?? [],
							assignee: params.assignee,
							dueDate: params.dueDate,
						};
						const issue = addIssue(board, input);
						saveBoard(boardPath, board);
						refreshFooterStatus(ctx, boardPath);
						return {
							content: [{ type: "text", text: `Added ${formatIssue(issue)}` }],
							details: details("add", boardPath, board, issue),
						};
					}
					case "update": {
						const id = parseIssueId(params.id);
						const p = params.patch ?? {};
						const patch: IssuePatch = {
							title: p.title ?? params.title,
							status: normalizeStatus(p.status ?? params.status),
							description: p.description ?? params.description,
							labels: normalizeLabels(p.labels ?? params.labels),
							assignee: p.assignee ?? params.assignee,
							dueDate: p.dueDate ?? params.dueDate,
						};
						const issue = updateIssue(board, id, patch);
						saveBoard(boardPath, board);
						refreshFooterStatus(ctx, boardPath);
						return {
							content: [{ type: "text", text: `Updated ${formatIssue(issue)}` }],
							details: details("update", boardPath, board, issue),
						};
					}
					case "move": {
						const id = parseIssueId(params.id);
						const status = normalizeStatus(params.status ?? params.patch?.status);
						if (!status) throw new Error("status is required for move");
						const issue = moveIssue(board, id, status);
						saveBoard(boardPath, board);
						refreshFooterStatus(ctx, boardPath);
						return {
							content: [{ type: "text", text: `Moved ${issue.id} to ${STATUS_LABEL[status]}` }],
							details: details("move", boardPath, board, issue),
						};
					}
					case "remove": {
						const issue = removeIssue(board, parseIssueId(params.id));
						saveBoard(boardPath, board);
						refreshFooterStatus(ctx, boardPath);
						return {
							content: [{ type: "text", text: `Removed ${issue.id}` }],
							details: details("remove", boardPath, board, issue),
						};
					}
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const fallbackBoard = existsSync(boardPath)
					? (() => {
							try {
								return loadBoard(boardPath);
							} catch {
								return createEmptyBoard();
							}
						})()
					: createEmptyBoard();

				return {
					content: [{ type: "text", text: `Error: ${message}` }],
					details: details(params.action, boardPath, fallbackBoard, undefined, message),
				};
			}

			return {
				content: [{ type: "text", text: "Unknown action" }],
				details: details("unknown", boardPath, createEmptyBoard(), undefined, "Unknown action"),
			};
		},
		renderCall(args, theme) {
			const action = String(args.action ?? "");
			let text = theme.fg("toolTitle", theme.bold("project_manager "));
			text += theme.fg("muted", action);
			if (args.id) text += " " + theme.fg("accent", String(args.id));
			if (args.title) text += " " + theme.fg("dim", `\"${truncateToWidth(String(args.title), 52)}\"`);
			if (args.status) text += " " + theme.fg("dim", String(args.status));
			return {
				render(width: number) {
					return [truncateToWidth(text, width)];
				},
				invalidate() {},
			};
		},
		renderResult(result, options, theme) {
			const d = result.details as ToolDetails | undefined;
			if (!d) {
				const text = result.content[0];
				const out = text?.type === "text" ? text.text : "";
				return new Markdown(out, 0, 0, getMarkdownTheme());
			}

			const counts = d.counts;
			const lines: string[] = [];
			if (d.error) {
				lines.push(theme.fg("error", `Error: ${d.error}`));
			} else {
				lines.push(theme.fg("success", "✓ ") + theme.fg("muted", d.action));
				if (d.issue) {
					lines.push(`${theme.fg("accent", d.issue.id)} ${d.issue.title}`);
					lines.push(theme.fg("dim", `${STATUS_LABEL[d.issue.status]}`));
					if (options.expanded && d.issue.description) lines.push("");
				}

				if (d.action === "list" && d.issues) {
					const active = sortIssuesForAction(d.issues.filter((issue) => issue.status !== "done"));
					if (active.length > 0) {
						lines.push("");
						lines.push(theme.fg("accent", "Next tasks"));
						for (const issue of active.slice(0, options.expanded ? active.length : 8)) {
							const marker = issue.status === "in_progress" ? theme.fg("success", "▶") : theme.fg("muted", "•");
							const state = theme.fg("dim", issue.status === "in_progress" ? "NOW" : "NEXT");
							lines.push(`${marker} ${theme.fg("accent", issue.id)} ${state} ${issue.title}`);
						}
					}
				}

				if (options.expanded && d.issues) {
					lines.push("");
					lines.push(theme.fg("dim", "All tasks"));
					for (const issue of sortIssuesForAction(d.issues)) {
						lines.push(`- ${issue.id} [${STATUS_LABEL[issue.status]}] ${issue.title}`);
					}
				}
				lines.push("");
				lines.push(theme.fg("muted", `B:${counts.backlog} P:${counts.inProgress} D:${counts.done}`));
			}

			if (options.expanded && d.issue?.description) {
				const mdTheme = getMarkdownTheme();
				const mdComponent = new Markdown(d.issue.description, 0, 0, mdTheme);
				return {
					render(width: number) {
						return [...lines.map((line) => truncateToWidth(line, width)), ...mdComponent.render(width)];
					},
					invalidate() {
						mdComponent.invalidate();
					},
				};
			}

			return {
				render(width: number) {
					return lines.map((line) => truncateToWidth(line, width));
				},
				invalidate() {},
			};
		},
	});

	async function executeVisualBoard(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI) {
			const boardPath = resolveBoardPath(ctx.cwd, "repo");
			const board = loadBoard(boardPath);
			sendDisplay(pi, formatBoard(board));
			return;
		}

		const boardPath = resolveBoardPath(ctx.cwd, "repo");
		let uiState: UIState = { activeColumn: 0, selectedIndex: 0 };

		while (true) {
			let board: Board;
			try {
				board = loadBoard(boardPath);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`PM load error: ${message}`, "error");
				return;
			}

			const action = await ctx.ui.custom<PMAction>((tui, theme, _kb, done) => {
				const state: UIState = {
					activeColumn: uiState.activeColumn,
					selectedIndex: uiState.selectedIndex,
				};

				const getColumnIssues = (status: IssueStatus) => getStatusIssues(board, status);
				const selectedStatus = () => STATUS_ORDER[state.activeColumn] ?? "backlog";
				const selectedIssue = (): Issue | undefined => {
					const issues = getColumnIssues(selectedStatus());
					return issues[state.selectedIndex];
				};

				const clampSelection = () => {
					const issues = getColumnIssues(selectedStatus());
					if (issues.length === 0) {
						state.selectedIndex = 0;
						return;
					}
					if (state.selectedIndex < 0) state.selectedIndex = 0;
					if (state.selectedIndex > issues.length - 1) state.selectedIndex = issues.length - 1;
				};

				clampSelection();

				return {
					render(width: number) {
						const lines: string[] = [];
						lines.push(truncateToWidth(theme.fg("accent", theme.bold("Project Manager")), width));
						lines.push(truncateToWidth(statusSummary(theme, board), width));
						lines.push("");

						const gap = "  ";
						const colWidth = Math.max(18, Math.floor((width - gap.length * 2) / 3));

						const cols = STATUS_ORDER.map((status, colIndex) => {
							const issues = getColumnIssues(status);
							const isActiveCol = colIndex === state.activeColumn;
							const title = `${isActiveCol ? "▶" : " "} ${STATUS_LABEL[status]} (${issues.length})`;
							const colLines: string[] = [isActiveCol ? theme.fg("accent", title) : theme.fg("muted", title)];
							if (issues.length === 0) {
								colLines.push(theme.fg("dim", "  (empty)"));
							} else {
								const maxVisibleIssues = 12;
								const selectedIndex = isActiveCol ? state.selectedIndex : 0;
								const start = Math.max(0, Math.min(selectedIndex - Math.floor(maxVisibleIssues / 2), issues.length - maxVisibleIssues));
								const end = Math.min(issues.length, start + maxVisibleIssues);
								if (start > 0) {
									colLines.push(theme.fg("dim", `  … ${start} above`));
								}
								for (let i = start; i < end; i++) {
									const issue = issues[i];
									const selected = isActiveCol && i === state.selectedIndex;
									const prefix = selected ? theme.fg("accent", "› ") : "  ";
									colLines.push(`${prefix}${issue.id} ${issue.title}`);
								}
								if (end < issues.length) {
									colLines.push(theme.fg("dim", `  … +${issues.length - end} more`));
								}
							}
							return colLines;
						});

						const rowCount = Math.max(cols[0].length, cols[1].length, cols[2].length);
						for (let row = 0; row < rowCount; row++) {
							const left = padToWidth(cols[0][row] ?? "", colWidth);
							const mid = padToWidth(cols[1][row] ?? "", colWidth);
							const right = padToWidth(cols[2][row] ?? "", colWidth);
							lines.push(truncateToWidth(`${left}${gap}${mid}${gap}${right}`, width));
						}

						lines.push("");
						const sel = selectedIssue();
						if (sel) {
							lines.push(truncateToWidth(theme.fg("accent", theme.bold(`Details: ${sel.id}`)), width));
							lines.push(
								truncateToWidth(theme.fg("muted", `${STATUS_LABEL[sel.status]} • ${sel.assignee ?? "unassigned"}`), width),
							);
							lines.push(truncateToWidth(theme.fg("muted", `Due: ${sel.dueDate ?? "-"}`), width));
							lines.push(
								truncateToWidth(theme.fg("muted", `Labels: ${sel.labels && sel.labels.length > 0 ? sel.labels.join(", ") : "-"}`), width),
							);
							lines.push(truncateToWidth(theme.fg("muted", `Created: ${formatTs(sel.createdAt)}`), width));
							lines.push(truncateToWidth(theme.fg("muted", `Updated: ${formatTs(sel.updatedAt)}`), width));
							lines.push(truncateToWidth(theme.fg("muted", "Description:"), width));

							const wrapped = wrapTextWithAnsi(sel.description ?? "(empty)", Math.max(10, width - 2));
							const maxDescLines = 6;
							for (let i = 0; i < Math.min(maxDescLines, wrapped.length); i++) {
								lines.push(truncateToWidth(`  ${wrapped[i]}`, width));
							}
							if (wrapped.length > maxDescLines) {
								lines.push(truncateToWidth(theme.fg("dim", "  ..."), width));
							}
						}

						lines.push("");
						lines.push(
							truncateToWidth(
								theme.fg(
									"dim",
									"↑↓ select • ←→ column • a add • e edit • m move(next) • d done • x remove • enter show • esc exit",
								),
								width,
							),
						);
						return lines;
					},
					invalidate() {},
					handleInput(data: string) {
						if (matchesKey(data, Key.escape) || data === "q") {
							done({ type: "exit", state });
							return;
						}

						if (matchesKey(data, Key.left)) {
							state.activeColumn = Math.max(0, state.activeColumn - 1);
							clampSelection();
							tui.requestRender();
							return;
						}
						if (matchesKey(data, Key.right)) {
							state.activeColumn = Math.min(2, state.activeColumn + 1);
							clampSelection();
							tui.requestRender();
							return;
						}
						if (matchesKey(data, Key.up)) {
							state.selectedIndex = Math.max(0, state.selectedIndex - 1);
							clampSelection();
							tui.requestRender();
							return;
						}
						if (matchesKey(data, Key.down)) {
							state.selectedIndex += 1;
							clampSelection();
							tui.requestRender();
							return;
						}

						if (data === "a") {
							done({ type: "add", state });
							return;
						}

						const issue = selectedIssue();
						if (!issue) return;

						if (data === "e") {
							done({ type: "edit", id: issue.id, state });
							return;
						}
						if (data === "x") {
							done({ type: "remove", id: issue.id, state });
							return;
						}
						if (data === "d") {
							done({ type: "move", id: issue.id, status: "done", state });
							return;
						}
						if (data === "m") {
							done({ type: "move", id: issue.id, status: nextStatus(issue.status), state });
							return;
						}
						if (matchesKey(data, Key.enter)) {
							done({ type: "show", id: issue.id, state });
						}
					},
				};
			});

			uiState = action.state;

			if (action.type === "exit") {
				refreshFooterStatus(ctx, boardPath);
				return;
			}

			if (action.type === "add") {
				try {
					const form = await promptIssueForm(ctx, {}, "create");
					if (!form) continue;
					const boardNow = loadBoard(boardPath);
					addIssue(boardNow, form);
					saveBoard(boardPath, boardNow);
					refreshFooterStatus(ctx, boardPath);
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				}
				continue;
			}

			if (action.type === "show") {
				const boardNow = loadBoard(boardPath);
				try {
					const issue = getIssue(boardNow, action.id);
					ctx.ui.notify(formatIssue(issue), "info");
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				}
				continue;
			}

			if (action.type === "edit") {
				const boardNow = loadBoard(boardPath);
				try {
					const current = getIssue(boardNow, action.id);
					const form = await promptIssueForm(ctx, current, "edit");
					if (!form) continue;
					updateIssue(boardNow, action.id, {
						title: form.title,
						description: form.description,
						status: form.status,
						labels: form.labels,
						assignee: form.assignee,
						dueDate: form.dueDate,
					});
					saveBoard(boardPath, boardNow);
					refreshFooterStatus(ctx, boardPath);
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				}
				continue;
			}

			if (action.type === "move") {
				const boardNow = loadBoard(boardPath);
				try {
					moveIssue(boardNow, action.id, action.status);
					saveBoard(boardPath, boardNow);
					refreshFooterStatus(ctx, boardPath);
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				}
				continue;
			}

			if (action.type === "remove") {
				const boardNow = loadBoard(boardPath);
				try {
					removeIssue(boardNow, action.id);
					saveBoard(boardPath, boardNow);
					refreshFooterStatus(ctx, boardPath);
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				}
			}
		}
	}

	pi.registerCommand("pm", {
		description: "Open Project Manager board (all operations are in the /pm UI)",
		handler: async (args, ctx) => {
			const input = (args || "").trim();
			if (!ctx.hasUI) {
				throw new Error("/pm requires interactive UI mode");
			}
			if (input) {
				ctx.ui.notify("Subcommands are disabled. Use /pm and operate via the board UI.", "info");
			}
			await executeVisualBoard(ctx);
		},
	});

	const refreshFromCtx = (ctx: ExtensionContext) => {
		const boardPath = resolveBoardPath(ctx.cwd, "repo");
		refreshFooterStatus(ctx, boardPath);
		startTicker(ctx, boardPath);
	};

	pi.on("session_start", async (_event, ctx) => refreshFromCtx(ctx));
	pi.on("session_switch", async (_event, ctx) => refreshFromCtx(ctx));
	pi.on("session_fork", async (_event, ctx) => refreshFromCtx(ctx));
	pi.on("session_tree", async (_event, ctx) => refreshFromCtx(ctx));

	pi.on("session_shutdown", async (_event, ctx) => {
		stopTicker();
		const boardPath = resolveBoardPath(ctx.cwd, "repo");
		const tempPrefix = `${boardPath}.tmp-`;
		const dir = dirname(boardPath);
		if (!existsSync(dir)) return;

		try {
			const entries = readdirSync(dir);
			for (const file of entries) {
				const full = join(dir, file);
				if (full.startsWith(tempPrefix)) {
					rmSync(full, { force: true });
				}
			}
		} catch {
			// ignore cleanup errors
		}
	});
}
