/**
 * Files Extension - IDE-like File Browser
 *
 * Features:
 * - /files: Tree-based file browser with git status
 * - /find: Fuzzy file finder (Ctrl+P style)
 * - /grep: Full-text search across files
 * - File preview with syntax highlighting
 * - Inline file editing in TUI
 * - Terminal diff viewer
 * - Quick actions: open, reveal, add to prompt, etc.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@mariozechner/pi-coding-agent";
import { DynamicBorder, getLanguageFromPath, getMarkdownTheme, highlightCode } from "@mariozechner/pi-coding-agent";
import {
	Container,
	fuzzyFilter,
	getEditorKeybindings,
	Input,
	Markdown,
	matchesKey,
	type SelectItem,
	SelectList,
	Spacer,
	Text,
	truncateToWidth,
} from "@mariozechner/pi-tui";

/* ──────────────────────── Types ──────────────────────── */

type ContentBlock = {
	type?: string;
	text?: string;
	arguments?: Record<string, unknown>;
};

type FileReference = {
	path: string;
	display: string;
	exists: boolean;
	isDirectory: boolean;
};

type FileEntry = {
	canonicalPath: string;
	resolvedPath: string;
	displayPath: string;
	exists: boolean;
	isDirectory: boolean;
	status?: string;
	inRepo: boolean;
	isTracked: boolean;
	isReferenced: boolean;
	hasSessionChange: boolean;
	lastTimestamp: number;
};

type GitStatusEntry = {
	status: string;
	exists: boolean;
	isDirectory: boolean;
};

type FileToolName = "write" | "edit";

type SessionFileChange = {
	operations: Set<FileToolName>;
	lastTimestamp: number;
};

type FileTreeNode = {
	id: string;
	name: string;
	displayPath: string;
	isDirectory: boolean;
	file: FileEntry | null;
	children: FileTreeNode[];
	hasDirty: boolean;
	hasSessionChange: boolean;
	hasReferenced: boolean;
};

type FileTreeRow = {
	node: FileTreeNode;
	depth: number;
};

type GrepMatch = {
	filePath: string;
	displayPath: string;
	lineNumber: number;
	lineText: string;
};

/* ──────────────────────── Regex ──────────────────────── */

const FILE_TAG_REGEX = /<file\s+name=["']([^"']+)["']>/g;
const FILE_URL_REGEX = /file:\/\/[^\s"'<>]+/g;
const PATH_REGEX = /(?:^|[\s"'`([{<])((?:~|\/)[^\s"'`<>)}\]]+)/g;

/* ──────────────────────── Reference extraction ──────────────────────── */

const extractFileReferencesFromText = (text: string): string[] => {
	const refs: string[] = [];

	for (const match of text.matchAll(FILE_TAG_REGEX)) {
		refs.push(match[1]);
	}

	for (const match of text.matchAll(FILE_URL_REGEX)) {
		refs.push(match[0]);
	}

	for (const match of text.matchAll(PATH_REGEX)) {
		refs.push(match[1]);
	}

	return refs;
};

const extractPathsFromToolArgs = (args: unknown): string[] => {
	if (!args || typeof args !== "object") {
		return [];
	}

	const refs: string[] = [];
	const record = args as Record<string, unknown>;
	const directKeys = ["path", "file", "filePath", "filepath", "fileName", "filename"] as const;
	const listKeys = ["paths", "files", "filePaths"] as const;

	for (const key of directKeys) {
		const value = record[key];
		if (typeof value === "string") {
			refs.push(value);
		}
	}

	for (const key of listKeys) {
		const value = record[key];
		if (Array.isArray(value)) {
			for (const item of value) {
				if (typeof item === "string") {
					refs.push(item);
				}
			}
		}
	}

	return refs;
};

const extractFileReferencesFromContent = (content: unknown): string[] => {
	if (typeof content === "string") {
		return extractFileReferencesFromText(content);
	}

	if (!Array.isArray(content)) {
		return [];
	}

	const refs: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") {
			continue;
		}

		const block = part as ContentBlock;

		if (block.type === "text" && typeof block.text === "string") {
			refs.push(...extractFileReferencesFromText(block.text));
		}

		if (block.type === "toolCall") {
			refs.push(...extractPathsFromToolArgs(block.arguments));
		}
	}

	return refs;
};

const extractFileReferencesFromEntry = (entry: SessionEntry): string[] => {
	if (entry.type === "message") {
		return extractFileReferencesFromContent(entry.message.content);
	}

	if (entry.type === "custom_message") {
		return extractFileReferencesFromContent(entry.content);
	}

	return [];
};

const sanitizeReference = (raw: string): string => {
	let value = raw.trim();
	value = value.replace(/^["'`(<\[]+/, "");
	value = value.replace(/[>"'`,;).\]]+$/, "");
	value = value.replace(/[.,;:]+$/, "");
	return value;
};

const isCommentLikeReference = (value: string): boolean => value.startsWith("//");

const stripLineSuffix = (value: string): string => {
	let result = value.replace(/#L\d+(C\d+)?$/i, "");
	const lastSeparator = Math.max(result.lastIndexOf("/"), result.lastIndexOf("\\"));
	const segmentStart = lastSeparator >= 0 ? lastSeparator + 1 : 0;
	const segment = result.slice(segmentStart);
	const colonIndex = segment.indexOf(":");
	if (colonIndex >= 0 && /\d/.test(segment[colonIndex + 1] ?? "")) {
		result = result.slice(0, segmentStart + colonIndex);
		return result;
	}

	const lastColon = result.lastIndexOf(":");
	if (lastColon > lastSeparator) {
		const suffix = result.slice(lastColon + 1);
		if (/^\d+(?::\d+)?$/.test(suffix)) {
			result = result.slice(0, lastColon);
		}
	}
	return result;
};

const normalizeReferencePath = (raw: string, cwd: string): string | null => {
	let candidate = sanitizeReference(raw);
	if (!candidate || isCommentLikeReference(candidate)) {
		return null;
	}

	if (candidate.startsWith("file://")) {
		try {
			candidate = fileURLToPath(candidate);
		} catch {
			return null;
		}
	}

	candidate = stripLineSuffix(candidate);
	if (!candidate || isCommentLikeReference(candidate)) {
		return null;
	}

	if (candidate.startsWith("~")) {
		candidate = path.join(os.homedir(), candidate.slice(1));
	}

	if (!path.isAbsolute(candidate)) {
		candidate = path.resolve(cwd, candidate);
	}

	candidate = path.normalize(candidate);
	const root = path.parse(candidate).root;
	if (candidate.length > root.length) {
		candidate = candidate.replace(/[\\/]+$/, "");
	}

	return candidate;
};

const formatDisplayPath = (absolutePath: string, cwd: string): string => {
	const normalizedCwd = path.resolve(cwd);
	if (absolutePath.startsWith(normalizedCwd + path.sep)) {
		return path.relative(normalizedCwd, absolutePath);
	}

	return absolutePath;
};

const collectRecentFileReferences = (entries: SessionEntry[], cwd: string, limit: number): FileReference[] => {
	const results: FileReference[] = [];
	const seen = new Set<string>();

	for (let i = entries.length - 1; i >= 0 && results.length < limit; i -= 1) {
		const refs = extractFileReferencesFromEntry(entries[i]);
		for (let j = refs.length - 1; j >= 0 && results.length < limit; j -= 1) {
			const normalized = normalizeReferencePath(refs[j], cwd);
			if (!normalized || seen.has(normalized)) {
				continue;
			}

			seen.add(normalized);

			let exists = false;
			let isDirectory = false;
			if (existsSync(normalized)) {
				exists = true;
				const stats = statSync(normalized);
				isDirectory = stats.isDirectory();
			}

			results.push({
				path: normalized,
				display: formatDisplayPath(normalized, cwd),
				exists,
				isDirectory,
			});
		}
	}

	return results;
};

const findLatestFileReference = (entries: SessionEntry[], cwd: string): FileReference | null => {
	const refs = collectRecentFileReferences(entries, cwd, 100);
	return refs.find((ref) => ref.exists) ?? null;
};

const toCanonicalPath = (inputPath: string): { canonicalPath: string; isDirectory: boolean } | null => {
	if (!existsSync(inputPath)) {
		return null;
	}

	try {
		const canonicalPath = realpathSync(inputPath);
		const stats = statSync(canonicalPath);
		return { canonicalPath, isDirectory: stats.isDirectory() };
	} catch {
		return null;
	}
};

const toCanonicalPathMaybeMissing = (
	inputPath: string,
): { canonicalPath: string; isDirectory: boolean; exists: boolean } | null => {
	const resolvedPath = path.resolve(inputPath);
	if (!existsSync(resolvedPath)) {
		return { canonicalPath: path.normalize(resolvedPath), isDirectory: false, exists: false };
	}

	try {
		const canonicalPath = realpathSync(resolvedPath);
		const stats = statSync(canonicalPath);
		return { canonicalPath, isDirectory: stats.isDirectory(), exists: true };
	} catch {
		return { canonicalPath: path.normalize(resolvedPath), isDirectory: false, exists: true };
	}
};

const collectSessionFileChanges = (entries: SessionEntry[], cwd: string): Map<string, SessionFileChange> => {
	const toolCalls = new Map<string, { path: string; name: FileToolName }>();

	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const msg = entry.message;

		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			for (const block of msg.content) {
				if (block.type === "toolCall") {
					const name = block.name as FileToolName;
					if (name === "write" || name === "edit") {
						const filePath = block.arguments?.path;
						if (filePath && typeof filePath === "string") {
							toolCalls.set(block.id, { path: filePath, name });
						}
					}
				}
			}
		}
	}

	const fileMap = new Map<string, SessionFileChange>();

	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const msg = entry.message;

		if (msg.role === "toolResult") {
			const toolCall = toolCalls.get(msg.toolCallId);
			if (!toolCall) continue;

			const resolvedPath = path.isAbsolute(toolCall.path)
				? toolCall.path
				: path.resolve(cwd, toolCall.path);
			const canonical = toCanonicalPath(resolvedPath);
			if (!canonical) {
				continue;
			}

			const existing = fileMap.get(canonical.canonicalPath);
			if (existing) {
				existing.operations.add(toolCall.name);
				if (msg.timestamp > existing.lastTimestamp) {
					existing.lastTimestamp = msg.timestamp;
				}
			} else {
				fileMap.set(canonical.canonicalPath, {
					operations: new Set([toolCall.name]),
					lastTimestamp: msg.timestamp,
				});
			}
		}
	}

	return fileMap;
};

/* ──────────────────────── Git helpers ──────────────────────── */

const splitNullSeparated = (value: string): string[] => value.split("\0").filter(Boolean);

const getGitRoot = async (pi: ExtensionAPI, cwd: string): Promise<string | null> => {
	const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd });
	if (result.code !== 0) {
		return null;
	}

	const root = result.stdout.trim();
	return root ? root : null;
};

const getGitStatusMap = async (pi: ExtensionAPI, cwd: string): Promise<Map<string, GitStatusEntry>> => {
	const statusMap = new Map<string, GitStatusEntry>();
	const statusResult = await pi.exec("git", ["status", "--porcelain=1", "-z"], { cwd });
	if (statusResult.code !== 0 || !statusResult.stdout) {
		return statusMap;
	}

	const entries = splitNullSeparated(statusResult.stdout);
	for (let i = 0; i < entries.length; i += 1) {
		const entry = entries[i];
		if (!entry || entry.length < 4) continue;
		const status = entry.slice(0, 2);
		const statusLabel = status.replace(/\s/g, "") || status.trim();
		let filePath = entry.slice(3);
		if ((status.startsWith("R") || status.startsWith("C")) && entries[i + 1]) {
			filePath = entries[i + 1];
			i += 1;
		}
		if (!filePath) continue;

		const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
		const canonical = toCanonicalPathMaybeMissing(resolved);
		if (!canonical) continue;
		statusMap.set(canonical.canonicalPath, {
			status: statusLabel,
			exists: canonical.exists,
			isDirectory: canonical.isDirectory,
		});
	}

	return statusMap;
};

const getGitFiles = async (
	pi: ExtensionAPI,
	gitRoot: string,
): Promise<{ tracked: Set<string>; files: Array<{ canonicalPath: string; isDirectory: boolean }> }> => {
	const tracked = new Set<string>();
	const files: Array<{ canonicalPath: string; isDirectory: boolean }> = [];

	const trackedResult = await pi.exec("git", ["ls-files", "-z"], { cwd: gitRoot });
	if (trackedResult.code === 0 && trackedResult.stdout) {
		for (const relativePath of splitNullSeparated(trackedResult.stdout)) {
			const resolvedPath = path.resolve(gitRoot, relativePath);
			const canonical = toCanonicalPath(resolvedPath);
			if (!canonical) continue;
			tracked.add(canonical.canonicalPath);
			files.push(canonical);
		}
	}

	const untrackedResult = await pi.exec("git", ["ls-files", "-z", "--others", "--exclude-standard"], { cwd: gitRoot });
	if (untrackedResult.code === 0 && untrackedResult.stdout) {
		for (const relativePath of splitNullSeparated(untrackedResult.stdout)) {
			const resolvedPath = path.resolve(gitRoot, relativePath);
			const canonical = toCanonicalPath(resolvedPath);
			if (!canonical) continue;
			files.push(canonical);
		}
	}

	return { tracked, files };
};

/* ──────────────────────── File entry building ──────────────────────── */

const buildFileEntries = async (pi: ExtensionAPI, ctx: ExtensionContext): Promise<{ files: FileEntry[]; gitRoot: string | null }> => {
	const entries = ctx.sessionManager.getBranch();
	const sessionChanges = collectSessionFileChanges(entries, ctx.cwd);
	const gitRoot = await getGitRoot(pi, ctx.cwd);
	const statusMap = gitRoot ? await getGitStatusMap(pi, gitRoot) : new Map<string, GitStatusEntry>();

	let trackedSet = new Set<string>();
	let gitFiles: Array<{ canonicalPath: string; isDirectory: boolean }> = [];
	if (gitRoot) {
		const gitListing = await getGitFiles(pi, gitRoot);
		trackedSet = gitListing.tracked;
		gitFiles = gitListing.files;
	}

	const fileMap = new Map<string, FileEntry>();

	const upsertFile = (data: Partial<FileEntry> & { canonicalPath: string; isDirectory: boolean }) => {
		const existing = fileMap.get(data.canonicalPath);
		const displayPath = data.displayPath ?? formatDisplayPath(data.canonicalPath, ctx.cwd);

		if (existing) {
			fileMap.set(data.canonicalPath, {
				...existing,
				...data,
				displayPath,
				exists: data.exists ?? existing.exists,
				isDirectory: data.isDirectory ?? existing.isDirectory,
				isReferenced: existing.isReferenced || data.isReferenced === true,
				inRepo: existing.inRepo || data.inRepo === true,
				isTracked: existing.isTracked || data.isTracked === true,
				hasSessionChange: existing.hasSessionChange || data.hasSessionChange === true,
				lastTimestamp: Math.max(existing.lastTimestamp, data.lastTimestamp ?? 0),
			});
			return;
		}

		fileMap.set(data.canonicalPath, {
			canonicalPath: data.canonicalPath,
			resolvedPath: data.resolvedPath ?? data.canonicalPath,
			displayPath,
			exists: data.exists ?? true,
			isDirectory: data.isDirectory,
			status: data.status,
			inRepo: data.inRepo ?? false,
			isTracked: data.isTracked ?? false,
			isReferenced: data.isReferenced ?? false,
			hasSessionChange: data.hasSessionChange ?? false,
			lastTimestamp: data.lastTimestamp ?? 0,
		});
	};

	for (const file of gitFiles) {
		upsertFile({
			canonicalPath: file.canonicalPath,
			resolvedPath: file.canonicalPath,
			isDirectory: file.isDirectory,
			exists: true,
			status: statusMap.get(file.canonicalPath)?.status,
			inRepo: true,
			isTracked: trackedSet.has(file.canonicalPath),
		});
	}

	for (const [canonicalPath, statusEntry] of statusMap.entries()) {
		if (fileMap.has(canonicalPath)) {
			continue;
		}

		const inRepo =
			gitRoot !== null &&
			!path.relative(gitRoot, canonicalPath).startsWith("..") &&
			!path.isAbsolute(path.relative(gitRoot, canonicalPath));

		upsertFile({
			canonicalPath,
			resolvedPath: canonicalPath,
			isDirectory: statusEntry.isDirectory,
			exists: statusEntry.exists,
			status: statusEntry.status,
			inRepo,
			isTracked: trackedSet.has(canonicalPath) || statusEntry.status !== "??",
		});
	}

	const references = collectRecentFileReferences(entries, ctx.cwd, 200).filter((ref) => ref.exists);
	for (const ref of references) {
		const canonical = toCanonicalPath(ref.path);
		if (!canonical) continue;

		const inRepo =
			gitRoot !== null &&
			!path.relative(gitRoot, canonical.canonicalPath).startsWith("..") &&
			!path.isAbsolute(path.relative(gitRoot, canonical.canonicalPath));

		upsertFile({
			canonicalPath: canonical.canonicalPath,
			resolvedPath: canonical.canonicalPath,
			isDirectory: canonical.isDirectory,
			exists: true,
			status: statusMap.get(canonical.canonicalPath)?.status,
			inRepo,
			isTracked: trackedSet.has(canonical.canonicalPath),
			isReferenced: true,
		});
	}

	for (const [canonicalPath, change] of sessionChanges.entries()) {
		const canonical = toCanonicalPath(canonicalPath);
		if (!canonical) continue;

		const inRepo =
			gitRoot !== null &&
			!path.relative(gitRoot, canonical.canonicalPath).startsWith("..") &&
			!path.isAbsolute(path.relative(gitRoot, canonical.canonicalPath));

		upsertFile({
			canonicalPath: canonical.canonicalPath,
			resolvedPath: canonical.canonicalPath,
			isDirectory: canonical.isDirectory,
			exists: true,
			status: statusMap.get(canonical.canonicalPath)?.status,
			inRepo,
			isTracked: trackedSet.has(canonical.canonicalPath),
			hasSessionChange: true,
			lastTimestamp: change.lastTimestamp,
		});
	}

	const files = Array.from(fileMap.values()).sort((a, b) => {
		const aDirty = Boolean(a.status);
		const bDirty = Boolean(b.status);
		if (aDirty !== bDirty) {
			return aDirty ? -1 : 1;
		}
		if (a.inRepo !== b.inRepo) {
			return a.inRepo ? -1 : 1;
		}
		if (a.hasSessionChange !== b.hasSessionChange) {
			return a.hasSessionChange ? -1 : 1;
		}
		if (a.lastTimestamp !== b.lastTimestamp) {
			return b.lastTimestamp - a.lastTimestamp;
		}
		if (a.isReferenced !== b.isReferenced) {
			return a.isReferenced ? -1 : 1;
		}
		return a.displayPath.localeCompare(b.displayPath);
	});

	return { files, gitRoot };
};

/* ──────────────────────── File tree ──────────────────────── */

const normalizeTreePath = (inputPath: string): { normalized: string; absolute: boolean } => {
	const normalized = inputPath.split(path.sep).join("/").replace(/\\/g, "/");
	return { normalized, absolute: normalized.startsWith("/") };
};

const buildFileTree = (files: FileEntry[]): FileTreeNode => {
	const root: FileTreeNode = {
		id: "root",
		name: "",
		displayPath: "",
		isDirectory: true,
		file: null,
		children: [],
		hasDirty: false,
		hasSessionChange: false,
		hasReferenced: false,
	};

	for (const file of files) {
		const { normalized, absolute } = normalizeTreePath(file.displayPath);
		const segments = normalized.split("/").filter(Boolean);
		if (segments.length === 0) {
			continue;
		}

		let current = root;
		let currentPath = absolute ? "/" : "";

		for (let i = 0; i < segments.length; i += 1) {
			const segment = segments[i]!;
			const isLeaf = i === segments.length - 1;
			const isDirectory = isLeaf ? file.isDirectory : true;
			const nextPath =
				currentPath === "/" ? `/${segment}` : currentPath ? `${currentPath}/${segment}` : segment;
			const nodeId = isLeaf && !isDirectory ? `file:${file.canonicalPath}` : `dir:${nextPath}`;

			let child = current.children.find((node) => node.id === nodeId);
			if (!child) {
				child = {
					id: nodeId,
					name: segment,
					displayPath: nextPath,
					isDirectory,
					file: null,
					children: [],
					hasDirty: false,
					hasSessionChange: false,
					hasReferenced: false,
				};
				current.children.push(child);
			}

			if (isLeaf) {
				child.file = file;
				child.displayPath = file.displayPath;
			}

			current = child;
			currentPath = nextPath;
		}
	}

	const annotate = (node: FileTreeNode): void => {
		for (const child of node.children) {
			annotate(child);
		}

		const fileDirty = Boolean(node.file?.status);
		const fileSession = Boolean(node.file?.hasSessionChange);
		const fileRef = Boolean(node.file?.isReferenced);

		node.hasDirty = fileDirty || node.children.some((child) => child.hasDirty);
		node.hasSessionChange = fileSession || node.children.some((child) => child.hasSessionChange);
		node.hasReferenced = fileRef || node.children.some((child) => child.hasReferenced);

		node.children.sort((a, b) => {
			if (a.isDirectory !== b.isDirectory) {
				return a.isDirectory ? -1 : 1;
			}
			if (a.hasDirty !== b.hasDirty) {
				return a.hasDirty ? -1 : 1;
			}
			if (a.hasSessionChange !== b.hasSessionChange) {
				return a.hasSessionChange ? -1 : 1;
			}
			if (a.hasReferenced !== b.hasReferenced) {
				return a.hasReferenced ? -1 : 1;
			}
			return a.name.localeCompare(b.name);
		});
	};

	annotate(root);
	return root;
};

const buildInitialExpandedSet = (root: FileTreeNode): Set<string> => {
	const expanded = new Set<string>();

	const walk = (node: FileTreeNode, depth: number): void => {
		if (!node.isDirectory) {
			return;
		}

		if (depth <= 1 || node.hasDirty || node.hasSessionChange || node.hasReferenced) {
			expanded.add(node.id);
		}

		for (const child of node.children) {
			walk(child, depth + 1);
		}
	};

	for (const child of root.children) {
		walk(child, 0);
	}

	return expanded;
};

const flattenTreeRows = (root: FileTreeNode, expanded: Set<string>, query: string): FileTreeRow[] => {
	const rows: FileTreeRow[] = [];
	const normalizedQuery = query.trim().toLowerCase();

	const matchesNode = (node: FileTreeNode): boolean => {
		const status = node.file?.status ?? "";
		const scope = `${node.name} ${node.displayPath} ${status}`.toLowerCase();
		return scope.includes(normalizedQuery);
	};

	const collectFilteredRows = (node: FileTreeNode, depth: number): { matched: boolean; rows: FileTreeRow[] } => {
		let descendantMatched = false;
		const childRows: FileTreeRow[] = [];

		for (const child of node.children) {
			const childResult = collectFilteredRows(child, depth + 1);
			if (childResult.matched) {
				descendantMatched = true;
				childRows.push(...childResult.rows);
			}
		}

		const selfMatched = matchesNode(node);
		const matched = selfMatched || descendantMatched;
		if (!matched) {
			return { matched: false, rows: [] };
		}

		return {
			matched: true,
			rows: [{ node, depth }, ...childRows],
		};
	};

	const collectDefaultRows = (node: FileTreeNode, depth: number): void => {
		rows.push({ node, depth });
		if (!node.isDirectory || !expanded.has(node.id)) {
			return;
		}

		for (const child of node.children) {
			collectDefaultRows(child, depth + 1);
		}
	};

	for (const child of root.children) {
		if (normalizedQuery) {
			const filtered = collectFilteredRows(child, 0);
			rows.push(...filtered.rows);
		} else {
			collectDefaultRows(child, 0);
		}
	}

	return rows;
};

const toSelectableFileEntry = (node: FileTreeNode, cwd: string): FileEntry | null => {
	if (node.file) {
		return node.file;
	}

	if (!node.isDirectory) {
		return null;
	}

	const resolved = path.isAbsolute(node.displayPath) ? node.displayPath : path.resolve(cwd, node.displayPath);
	const canonical = toCanonicalPathMaybeMissing(resolved);
	if (!canonical) {
		return null;
	}

	return {
		canonicalPath: canonical.canonicalPath,
		resolvedPath: canonical.canonicalPath,
		displayPath: node.displayPath,
		exists: canonical.exists,
		isDirectory: true,
		status: undefined,
		inRepo: false,
		isTracked: false,
		isReferenced: node.hasReferenced,
		hasSessionChange: node.hasSessionChange,
		lastTimestamp: 0,
	};
};

/* ──────────────────────── File content helpers ──────────────────────── */

const isBinaryFile = (filePath: string): boolean => {
	try {
		const fs = require("node:fs");
		const buffer = Buffer.alloc(8192);
		const fd = fs.openSync(filePath, "r");
		const bytesRead = fs.readSync(fd, buffer, 0, 8192, 0);
		fs.closeSync(fd);
		for (let i = 0; i < bytesRead; i++) {
			if (buffer[i] === 0) return true;
		}
		return false;
	} catch {
		return false;
	}
};

const readFileLines = (filePath: string, maxLines = 10000): string[] => {
	try {
		const content = readFileSync(filePath, "utf-8");
		const lines = content.split("\n");
		if (lines.length > maxLines) {
			return [...lines.slice(0, maxLines), `... (${lines.length - maxLines} more lines)`];
		}
		return lines;
	} catch {
		return ["[Error reading file]"];
	}
};

/* ──────────────────────── Mouse helpers ──────────────────────── */

/**
 * Parse SGR mouse events. Format: ESC[<button;col;rowM (press) or ESC[<button;col;rowm (release)
 * Button 64 = scroll up, 65 = scroll down.
 */
const parseMouseEvent = (data: string): { button: number; col: number; row: number; release: boolean } | null => {
	const match = data.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/);
	if (!match) return null;
	return {
		button: parseInt(match[1], 10),
		col: parseInt(match[2], 10),
		row: parseInt(match[3], 10),
		release: match[4] === "m",
	};
};

const isMouseScrollUp = (data: string): boolean => {
	const evt = parseMouseEvent(data);
	return evt !== null && evt.button === 64;
};

const isMouseScrollDown = (data: string): boolean => {
	const evt = parseMouseEvent(data);
	return evt !== null && evt.button === 65;
};

/** Enable SGR mouse mode (scroll tracking). Disable with disableMouseTracking. */
const enableMouseTracking = (tui: any): void => {
	try {
		// Enable SGR mouse mode for scroll events
		// 1000: basic mouse tracking, 1006: SGR extended mode
		tui.terminal.write("\x1b[?1000h\x1b[?1006h");
	} catch { /* ignore if terminal doesn't support */ }
};

const disableMouseTracking = (tui: any): void => {
	try {
		tui.terminal.write("\x1b[?1000l\x1b[?1006l");
	} catch { /* ignore */ }
};

/** Get dynamic viewport size based on terminal rows, reserving lines for chrome (border, title, footer). */
const getViewportSize = (tui: any, chromeLines: number): number => {
	try {
		const termRows = tui.terminal.rows ?? 24;
		return Math.max(5, termRows - chromeLines);
	} catch {
		return 20;
	}
};

/* ──────────────────────── File Preview Viewer ──────────────────────── */

const showFilePreview = async (
	ctx: ExtensionContext,
	filePath: string,
	displayPath: string,
	initialLine?: number,
): Promise<"edit" | "back" | null> => {
	if (!existsSync(filePath)) {
		ctx.ui.notify(`File not found: ${displayPath}`, "error");
		return null;
	}

	const stat = statSync(filePath);
	if (stat.isDirectory()) {
		ctx.ui.notify("Cannot preview a directory", "warning");
		return null;
	}

	if (isBinaryFile(filePath)) {
		ctx.ui.notify("Binary file, cannot preview in terminal", "warning");
		return null;
	}

	const rawContent = readFileSync(filePath, "utf-8");
	const rawLines = rawContent.split("\n");
	const lang = getLanguageFromPath(filePath);
	const isMarkdown = lang === "markdown" || /\.mdx?$/i.test(filePath);

	let highlightedLines: string[];
	if (!isMarkdown) {
		try {
			highlightedLines = highlightCode(rawContent, lang);
		} catch {
			highlightedLines = rawLines;
		}
	} else {
		highlightedLines = []; // will be rendered dynamically by Markdown component
	}

	const sourceLineCount = rawLines.length;
	// chromeLines: top border(1) + title(1) + footer(1) + bottom border(1) = 4
	const CHROME_LINES = 4;

	return ctx.ui.custom<"edit" | "back" | null>((tui, theme, _kb, done) => {
		enableMouseTracking(tui);

		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		const titleText = new Text("", 0, 0);
		container.addChild(titleText);

		const bodyText = new Text("", 0, 0);
		container.addChild(bodyText);

		const footerText = new Text("", 0, 0);
		container.addChild(footerText);
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		// For markdown: pre-render with Markdown component, cache rendered lines
		let mdRenderedLines: string[] | null = null;
		let mdRenderedWidth = 0;
		const mdComponent = isMarkdown ? new Markdown(rawContent, 1, 0, getMarkdownTheme()) : null;

		const getMdLines = (width: number): string[] => {
			if (!isMarkdown || !mdComponent) return highlightedLines;
			if (mdRenderedLines && mdRenderedWidth === width) return mdRenderedLines;
			mdRenderedLines = mdComponent.render(width);
			mdRenderedWidth = width;
			return mdRenderedLines;
		};

		let offset = initialLine ? Math.max(0, initialLine - 1) : 0;
		let gotoMode = false;
		let gotoInput = "";

		const getVP = () => getViewportSize(tui, CHROME_LINES);

		const getTotalLines = (width: number) => isMarkdown ? getMdLines(width).length : sourceLineCount;

		const clampOffset = (width: number) => {
			const vp = getVP();
			const total = getTotalLines(width);
			const maxOffset = Math.max(0, total - vp);
			if (offset > maxOffset) offset = maxOffset;
			if (offset < 0) offset = 0;
		};

		const updateDisplay = (width: number) => {
			const viewportSize = getVP();
			clampOffset(width);
			const contentWidth = Math.max(10, width - 2);
			const displayLines = isMarkdown ? getMdLines(width) : highlightedLines;
			const totalLines = displayLines.length;

			const sizeStr = stat.size < 1024 ? `${stat.size}B` : stat.size < 1048576 ? `${(stat.size / 1024).toFixed(1)}KB` : `${(stat.size / 1048576).toFixed(1)}MB`;
			const modeLabel = isMarkdown ? "markdown" : (lang ?? "");
			titleText.setText(theme.fg("accent", theme.bold(` 📄 ${displayPath}`)) + theme.fg("muted", ` (${sourceLineCount} lines, ${sizeStr}${modeLabel ? `, ${modeLabel}` : ""})`));

			const slice = displayLines.slice(offset, offset + viewportSize);
			const rendered: string[] = [];

			if (isMarkdown) {
				// Markdown: no line numbers, already styled
				for (let i = 0; i < viewportSize; i++) {
					if (i < slice.length) {
						rendered.push(truncateToWidth(slice[i], contentWidth));
					} else {
						rendered.push(theme.fg("dim", "~"));
					}
				}
			} else {
				// Code: line numbers + syntax highlight
				const lineNumWidth = String(Math.min(offset + viewportSize, totalLines)).length;
				for (let i = 0; i < viewportSize; i++) {
					if (i < slice.length) {
						const lineNum = String(offset + i + 1).padStart(lineNumWidth);
						const numStr = theme.fg("dim", `${lineNum} │ `);
						rendered.push(truncateToWidth(`${numStr}${slice[i]}`, contentWidth + lineNumWidth + 3));
					} else {
						rendered.push(theme.fg("dim", "~"));
					}
				}
			}
			bodyText.setText(rendered.join("\n"));

			if (gotoMode) {
				footerText.setText(theme.fg("accent", `Go to line: ${gotoInput}█`) + theme.fg("dim", " (enter to confirm, esc to cancel)"));
			} else {
				const endLine = Math.min(offset + viewportSize, totalLines);
				footerText.setText(
					theme.fg("dim", `↑↓/j/k scroll • 🖱 wheel • PgUp/PgDn • g goto • e edit • Esc/q back • ${offset + 1}-${endLine}/${totalLines}`),
				);
			}
		};

		const cleanup = () => {
			disableMouseTracking(tui);
		};

		return {
			render(width: number) {
				updateDisplay(width);
				return container.render(width);
			},
			invalidate() {
				container.invalidate();
			},
			handleInput(data: string) {
				// Mouse scroll
				if (isMouseScrollUp(data)) {
					offset -= 3;
					tui.requestRender();
					return;
				}
				if (isMouseScrollDown(data)) {
					offset += 3;
					tui.requestRender();
					return;
				}
				// Ignore other mouse events
				if (parseMouseEvent(data)) return;

				if (gotoMode) {
					if (matchesKey(data, "escape")) {
						gotoMode = false;
						gotoInput = "";
						tui.requestRender();
						return;
					}
					if (matchesKey(data, "enter")) {
						const line = parseInt(gotoInput, 10);
						if (!isNaN(line) && line > 0) {
							offset = line - 1;
						}
						gotoMode = false;
						gotoInput = "";
						tui.requestRender();
						return;
					}
					if (matchesKey(data, "backspace")) {
						gotoInput = gotoInput.slice(0, -1);
						tui.requestRender();
						return;
					}
					if (/^\d$/.test(data)) {
						gotoInput += data;
						tui.requestRender();
						return;
					}
					return;
				}

				if (matchesKey(data, "escape") || data === "q") {
					cleanup();
					done("back");
					return;
				}
				if (data === "e") {
					cleanup();
					done("edit");
					return;
				}
				if (data === "g") {
					gotoMode = true;
					gotoInput = "";
					tui.requestRender();
					return;
				}
				if (matchesKey(data, "up") || data === "k") {
					offset -= 1;
					tui.requestRender();
					return;
				}
				if (matchesKey(data, "down") || data === "j") {
					offset += 1;
					tui.requestRender();
					return;
				}
				if (matchesKey(data, "pageUp")) {
					offset -= getVP();
					tui.requestRender();
					return;
				}
				if (matchesKey(data, "pageDown")) {
					offset += getVP();
					tui.requestRender();
					return;
				}
				if (matchesKey(data, "home")) {
					offset = 0;
					tui.requestRender();
					return;
				}
				if (matchesKey(data, "end")) {
					// Use sourceLineCount for code, or large number (clampOffset will fix)
					offset = 999999;
					tui.requestRender();
					return;
				}
			},
		};
	});
};

/* ──────────────────────── Inline File Editor ──────────────────────── */

const showFileEditorV2 = async (
	ctx: ExtensionContext,
	filePath: string,
	displayPath: string,
	initialLine?: number,
): Promise<void> => {
	if (!existsSync(filePath)) {
		ctx.ui.notify(`File not found: ${displayPath}`, "error");
		return;
	}

	const stat = statSync(filePath);
	if (stat.isDirectory()) {
		ctx.ui.notify("Cannot edit a directory", "warning");
		return;
	}

	if (isBinaryFile(filePath)) {
		ctx.ui.notify("Binary file, cannot edit in terminal", "warning");
		return;
	}

	const rawLines = readFileLines(filePath, 50000);
	const originalContent = readFileSync(filePath, "utf-8");
	// chromeLines: top border(1) + title(1) + footer(1) + bottom border(1) = 4
	const EDITOR_CHROME = 4;

	// Shared state object accessible from both the custom UI and the post-save logic
	const state = {
		lines: [...rawLines],
		cursorLine: initialLine ? Math.min(initialLine - 1, rawLines.length - 1) : 0,
		cursorCol: 0,
		scrollOffset: initialLine ? Math.max(0, initialLine - 1 - 10) : 0,
		modified: false,
		mode: "normal" as "normal" | "insert",
		pendingD: false,
		gotoMode: false,
		gotoInput: "",
	};

	const action = await ctx.ui.custom<"save" | "quit" | null>((tui, theme, _kb, done) => {
		enableMouseTracking(tui);

		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		const titleText = new Text("", 0, 0);
		container.addChild(titleText);

		const bodyText = new Text("", 0, 0);
		container.addChild(bodyText);

		const footerText = new Text("", 0, 0);
		container.addChild(footerText);
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		const getVP = () => getViewportSize(tui, EDITOR_CHROME);

		const clampCursor = () => {
			if (state.cursorLine < 0) state.cursorLine = 0;
			if (state.cursorLine >= state.lines.length) state.cursorLine = Math.max(0, state.lines.length - 1);
			const lineLen = (state.lines[state.cursorLine] ?? "").length;
			if (state.cursorCol < 0) state.cursorCol = 0;
			if (state.cursorCol > lineLen) state.cursorCol = lineLen;
		};

		const ensureVisible = () => {
			const vp = getVP();
			if (state.cursorLine < state.scrollOffset) {
				state.scrollOffset = state.cursorLine;
			}
			if (state.cursorLine >= state.scrollOffset + vp) {
				state.scrollOffset = state.cursorLine - vp + 1;
			}
		};

		const updateDisplay = (width: number) => {
			const viewportSize = getVP();
			clampCursor();
			ensureVisible();
			const contentWidth = Math.max(10, width - 2);
			const modifiedMarker = state.modified ? theme.fg("warning", " [modified]") : "";
			const modeStr = state.mode === "insert" ? theme.fg("success", " INSERT") : theme.fg("accent", " NORMAL");

			titleText.setText(theme.fg("accent", theme.bold(` ✏️  ${displayPath}`)) + modifiedMarker + modeStr);

			const lineNumWidth = String(Math.min(state.scrollOffset + viewportSize, state.lines.length)).length;
			const visibleLines: string[] = [];
			for (let i = 0; i < viewportSize; i++) {
				const lineIdx = state.scrollOffset + i;
				if (lineIdx >= state.lines.length) {
					visibleLines.push(theme.fg("dim", "~"));
					continue;
				}
				const lineNum = String(lineIdx + 1).padStart(lineNumWidth);
				const isCurrent = lineIdx === state.cursorLine;
				const lineContent = state.lines[lineIdx] ?? "";

				if (isCurrent) {
					const before = lineContent.slice(0, state.cursorCol);
					const cursorChar = lineContent[state.cursorCol] ?? " ";
					const after = lineContent.slice(state.cursorCol + 1);
					const cursorDisplay = `\x1b[7m${cursorChar}\x1b[27m`;
					const numStr = theme.fg("accent", `${lineNum} │ `);
					visibleLines.push(truncateToWidth(`${numStr}${before}${cursorDisplay}${after}`, contentWidth + lineNumWidth + 20));
				} else {
					const numStr = theme.fg("dim", `${lineNum} │ `);
					visibleLines.push(truncateToWidth(`${numStr}${lineContent}`, contentWidth + lineNumWidth + 3));
				}
			}
			bodyText.setText(visibleLines.join("\n"));

			if (state.gotoMode) {
				footerText.setText(
					theme.fg("accent", `:${state.gotoInput}█`) + theme.fg("dim", "  enter confirm • esc cancel"),
				);
			} else if (state.mode === "insert") {
				footerText.setText(
					theme.fg("dim", `Esc → normal • ctrl+s save • 🖱 wheel scroll • ${state.cursorLine + 1}:${state.cursorCol + 1} / ${state.lines.length}L`),
				);
			} else {
				footerText.setText(
					theme.fg("dim", `i insert • :N goto • dd del • 🖱 wheel • ctrl+s save • q quit • ${state.cursorLine + 1}:${state.cursorCol + 1}`),
				);
			}
		};

		const cleanup = () => {
			disableMouseTracking(tui);
		};

		return {
			render(width: number) {
				updateDisplay(width);
				return container.render(width);
			},
			invalidate() {
				container.invalidate();
			},
			handleInput(data: string) {
				// Mouse scroll — move both viewport AND cursor to avoid ensureVisible() snapping back
				if (isMouseScrollUp(data)) {
					const delta = 3;
					state.scrollOffset = Math.max(0, state.scrollOffset - delta);
					// Keep cursor inside visible area
					if (state.cursorLine >= state.scrollOffset + getVP()) {
						state.cursorLine = state.scrollOffset + getVP() - 1;
					}
					tui.requestRender();
					return;
				}
				if (isMouseScrollDown(data)) {
					const delta = 3;
					state.scrollOffset += delta;
					// Clamp scrollOffset
					const maxScroll = Math.max(0, state.lines.length - getVP());
					if (state.scrollOffset > maxScroll) state.scrollOffset = maxScroll;
					// Keep cursor inside visible area
					if (state.cursorLine < state.scrollOffset) {
						state.cursorLine = state.scrollOffset;
					}
					tui.requestRender();
					return;
				}
				// Ignore other mouse events
				if (parseMouseEvent(data)) return;

				// Goto line mode (triggered by : in normal mode)
				if (state.gotoMode) {
					if (matchesKey(data, "escape")) {
						state.gotoMode = false;
						state.gotoInput = "";
						tui.requestRender();
						return;
					}
					if (matchesKey(data, "enter")) {
						const target = parseInt(state.gotoInput, 10);
						if (!isNaN(target) && target > 0) {
							state.cursorLine = Math.min(target - 1, state.lines.length - 1);
							state.cursorCol = 0;
						}
						state.gotoMode = false;
						state.gotoInput = "";
						tui.requestRender();
						return;
					}
					if (matchesKey(data, "backspace")) {
						state.gotoInput = state.gotoInput.slice(0, -1);
						tui.requestRender();
						return;
					}
					if (/^\d$/.test(data)) {
						state.gotoInput += data;
						tui.requestRender();
						return;
					}
					// Ignore anything else in goto mode
					return;
				}

				// Ctrl+S always saves
				if (matchesKey(data, "ctrl+s")) {
					cleanup();
					done("save");
					return;
				}

				if (state.mode === "insert") {
					if (matchesKey(data, "escape")) {
						state.mode = "normal";
						tui.requestRender();
						return;
					}
					if (matchesKey(data, "enter")) {
						const line = state.lines[state.cursorLine] ?? "";
						const before = line.slice(0, state.cursorCol);
						const after = line.slice(state.cursorCol);
						state.lines[state.cursorLine] = before;
						state.lines.splice(state.cursorLine + 1, 0, after);
						state.cursorLine++;
						state.cursorCol = 0;
						state.modified = true;
						tui.requestRender();
						return;
					}
					if (matchesKey(data, "backspace")) {
						if (state.cursorCol > 0) {
							const line = state.lines[state.cursorLine] ?? "";
							state.lines[state.cursorLine] = line.slice(0, state.cursorCol - 1) + line.slice(state.cursorCol);
							state.cursorCol--;
							state.modified = true;
						} else if (state.cursorLine > 0) {
							const prevLine = state.lines[state.cursorLine - 1] ?? "";
							const currentLine = state.lines[state.cursorLine] ?? "";
							state.cursorCol = prevLine.length;
							state.lines[state.cursorLine - 1] = prevLine + currentLine;
							state.lines.splice(state.cursorLine, 1);
							state.cursorLine--;
							state.modified = true;
						}
						tui.requestRender();
						return;
					}
					if (matchesKey(data, "delete")) {
						const line = state.lines[state.cursorLine] ?? "";
						if (state.cursorCol < line.length) {
							state.lines[state.cursorLine] = line.slice(0, state.cursorCol) + line.slice(state.cursorCol + 1);
							state.modified = true;
						} else if (state.cursorLine < state.lines.length - 1) {
							state.lines[state.cursorLine] = line + (state.lines[state.cursorLine + 1] ?? "");
							state.lines.splice(state.cursorLine + 1, 1);
							state.modified = true;
						}
						tui.requestRender();
						return;
					}
					if (matchesKey(data, "up")) { state.cursorLine--; tui.requestRender(); return; }
					if (matchesKey(data, "down")) { state.cursorLine++; tui.requestRender(); return; }
					if (matchesKey(data, "left")) {
						if (state.cursorCol > 0) { state.cursorCol--; }
						else if (state.cursorLine > 0) { state.cursorLine--; state.cursorCol = (state.lines[state.cursorLine] ?? "").length; }
						tui.requestRender();
						return;
					}
					if (matchesKey(data, "right")) {
						const lineLen = (state.lines[state.cursorLine] ?? "").length;
						if (state.cursorCol < lineLen) { state.cursorCol++; }
						else if (state.cursorLine < state.lines.length - 1) { state.cursorLine++; state.cursorCol = 0; }
						tui.requestRender();
						return;
					}
					if (matchesKey(data, "home")) { state.cursorCol = 0; tui.requestRender(); return; }
					if (matchesKey(data, "end")) { state.cursorCol = (state.lines[state.cursorLine] ?? "").length; tui.requestRender(); return; }
					if (matchesKey(data, "tab")) {
						const line = state.lines[state.cursorLine] ?? "";
						state.lines[state.cursorLine] = line.slice(0, state.cursorCol) + "  " + line.slice(state.cursorCol);
						state.cursorCol += 2;
						state.modified = true;
						tui.requestRender();
						return;
					}
					// Regular character / multi-byte
					if (data.length >= 1 && !data.startsWith("\x1b") && data.charCodeAt(0) >= 32) {
						const line = state.lines[state.cursorLine] ?? "";
						state.lines[state.cursorLine] = line.slice(0, state.cursorCol) + data + line.slice(state.cursorCol);
						state.cursorCol += data.length;
						state.modified = true;
						tui.requestRender();
						return;
					}
					return;
				}

				// Normal mode
				if (data === "q" || matchesKey(data, "escape")) {
					cleanup();
					done("quit");
					return;
				}
				if (data === "i") { state.mode = "insert"; tui.requestRender(); return; }
				if (data === "a") {
					state.mode = "insert";
					state.cursorCol = Math.min(state.cursorCol + 1, (state.lines[state.cursorLine] ?? "").length);
					tui.requestRender();
					return;
				}
				if (data === "A") {
					state.mode = "insert";
					state.cursorCol = (state.lines[state.cursorLine] ?? "").length;
					tui.requestRender();
					return;
				}
				if (data === "I") {
					state.mode = "insert";
					const line = state.lines[state.cursorLine] ?? "";
					state.cursorCol = line.length - line.trimStart().length;
					tui.requestRender();
					return;
				}
				if (data === "o") {
					state.lines.splice(state.cursorLine + 1, 0, "");
					state.cursorLine++;
					state.cursorCol = 0;
					state.mode = "insert";
					state.modified = true;
					tui.requestRender();
					return;
				}
				if (data === "O") {
					state.lines.splice(state.cursorLine, 0, "");
					state.cursorCol = 0;
					state.mode = "insert";
					state.modified = true;
					tui.requestRender();
					return;
				}
				// dd handling
				if (state.pendingD) {
					state.pendingD = false;
					if (data === "d") {
						if (state.lines.length > 1) {
							state.lines.splice(state.cursorLine, 1);
							if (state.cursorLine >= state.lines.length) state.cursorLine = state.lines.length - 1;
						} else {
							state.lines[0] = "";
							state.cursorCol = 0;
						}
						state.modified = true;
						tui.requestRender();
						return;
					}
					// Not dd, fall through
				}
				if (data === "d") {
					state.pendingD = true;
					tui.requestRender();
					return;
				}
				if (data === "x") {
					const line = state.lines[state.cursorLine] ?? "";
					if (state.cursorCol < line.length) {
						state.lines[state.cursorLine] = line.slice(0, state.cursorCol) + line.slice(state.cursorCol + 1);
						state.modified = true;
					}
					tui.requestRender();
					return;
				}
				// Navigation
				if (data === "h" || matchesKey(data, "left")) { state.cursorCol--; tui.requestRender(); return; }
				if (data === "l" || matchesKey(data, "right")) { state.cursorCol++; tui.requestRender(); return; }
				if (data === "j" || matchesKey(data, "down")) { state.cursorLine++; tui.requestRender(); return; }
				if (data === "k" || matchesKey(data, "up")) { state.cursorLine--; tui.requestRender(); return; }
				if (data === "0") { state.cursorCol = 0; tui.requestRender(); return; }
				if (data === "$") { state.cursorCol = (state.lines[state.cursorLine] ?? "").length; tui.requestRender(); return; }
				if (data === "^") {
					const line = state.lines[state.cursorLine] ?? "";
					state.cursorCol = line.length - line.trimStart().length;
					tui.requestRender();
					return;
				}
				if (data === "w") {
					const line = state.lines[state.cursorLine] ?? "";
					let pos = state.cursorCol;
					while (pos < line.length && !/\s/.test(line[pos]!)) pos++;
					while (pos < line.length && /\s/.test(line[pos]!)) pos++;
					if (pos >= line.length && state.cursorLine < state.lines.length - 1) {
						state.cursorLine++;
						state.cursorCol = 0;
					} else {
						state.cursorCol = pos;
					}
					tui.requestRender();
					return;
				}
				if (data === "b") {
					const line = state.lines[state.cursorLine] ?? "";
					let pos = state.cursorCol - 1;
					while (pos > 0 && /\s/.test(line[pos]!)) pos--;
					while (pos > 0 && !/\s/.test(line[pos - 1]!)) pos--;
					if (pos <= 0 && state.cursorLine > 0) {
						state.cursorLine--;
						state.cursorCol = (state.lines[state.cursorLine] ?? "").length;
					} else {
						state.cursorCol = Math.max(0, pos);
					}
					tui.requestRender();
					return;
				}
				if (data === "G") {
					state.cursorLine = state.lines.length - 1;
					tui.requestRender();
					return;
				}
				if (data === "g") {
					state.cursorLine = 0;
					state.cursorCol = 0;
					tui.requestRender();
					return;
				}
				if (data === ":") {
					state.gotoMode = true;
					state.gotoInput = "";
					tui.requestRender();
					return;
				}
				if (matchesKey(data, "pageUp")) { state.cursorLine -= getVP(); tui.requestRender(); return; }
				if (matchesKey(data, "pageDown")) { state.cursorLine += getVP(); tui.requestRender(); return; }
			},
		};
	});

	if (action === "save" && state.modified) {
		try {
			const endsWithNewline = originalContent.endsWith("\n");
			let content = state.lines.join("\n");
			if (endsWithNewline && !content.endsWith("\n")) {
				content += "\n";
			}
			writeFileSync(filePath, content, "utf-8");
			ctx.ui.notify(`Saved ${displayPath}`, "success");
		} catch (e: any) {
			ctx.ui.notify(`Failed to save: ${e.message}`, "error");
		}
	} else if (action === "quit" && state.modified) {
		ctx.ui.notify(`Discarded changes to ${displayPath}`, "info");
	}
};

/* ──────────────────────── Grep Search ──────────────────────── */

const runGrep = async (
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	query: string,
	gitRoot: string | null,
): Promise<GrepMatch[]> => {
	const cwd = gitRoot ?? ctx.cwd;
	const matches: GrepMatch[] = [];

	// Try ripgrep first, fall back to git grep, then grep
	let result = await pi.exec("rg", ["--line-number", "--no-heading", "--color=never", "--max-count=200", query], { cwd, timeout: 10000 });

	if (result.code !== 0) {
		if (gitRoot) {
			result = await pi.exec("git", ["grep", "-n", "--no-color", query], { cwd: gitRoot, timeout: 10000 });
		}
		if (result.code !== 0) {
			result = await pi.exec("grep", ["-rn", "--include=*", query, "."], { cwd, timeout: 10000 });
		}
	}

	if (result.code !== 0 && result.code !== 1) {
		return matches;
	}

	const lines = (result.stdout ?? "").split("\n").filter(Boolean);
	for (const line of lines.slice(0, 200)) {
		// Format: file:lineNum:content
		const firstColon = line.indexOf(":");
		if (firstColon < 0) continue;
		const secondColon = line.indexOf(":", firstColon + 1);
		if (secondColon < 0) continue;

		const filePath = line.slice(0, firstColon);
		const lineNumStr = line.slice(firstColon + 1, secondColon);
		const lineText = line.slice(secondColon + 1);
		const lineNumber = parseInt(lineNumStr, 10);
		if (isNaN(lineNumber)) continue;

		const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
		matches.push({
			filePath: absolutePath,
			displayPath: formatDisplayPath(absolutePath, ctx.cwd),
			lineNumber,
			lineText: lineText.trim(),
		});
	}

	return matches;
};

const showGrepUI = async (pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> => {
	if (!ctx.hasUI) {
		ctx.ui.notify("Grep requires interactive mode", "error");
		return;
	}

	const gitRoot = await getGitRoot(pi, ctx.cwd);

	await ctx.ui.custom<void>((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold(" 🔍 Search in files")), 0, 0));

		const searchInput = new Input();
		container.addChild(searchInput);
		container.addChild(new Spacer(1));

		const resultsText = new Text("", 0, 0);
		container.addChild(resultsText);

		const footerText = new Text("", 0, 0);
		container.addChild(footerText);
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		let results: GrepMatch[] = [];
		let selectedIndex = 0;
		let scrollOffset = 0;
		const viewportSize = 14;
		let isSearching = false;
		let lastQuery = "";
		let searchTimer: ReturnType<typeof setTimeout> | null = null;

		const doSearch = async () => {
			const query = searchInput.getValue().trim();
			if (query.length < 2) {
				results = [];
				selectedIndex = 0;
				scrollOffset = 0;
				tui.requestRender();
				return;
			}
			if (query === lastQuery) return;
			lastQuery = query;
			isSearching = true;
			tui.requestRender();

			try {
				results = await runGrep(pi, ctx, query, gitRoot);
			} catch {
				results = [];
			}
			isSearching = false;
			selectedIndex = 0;
			scrollOffset = 0;
			tui.requestRender();
		};

		const scheduleSearch = () => {
			if (searchTimer) clearTimeout(searchTimer);
			searchTimer = setTimeout(() => doSearch(), 300);
		};

		const updateDisplay = (width: number) => {
			const contentWidth = Math.max(10, width - 2);

			if (isSearching) {
				resultsText.setText(theme.fg("muted", "  Searching..."));
				footerText.setText(theme.fg("dim", "Type to search • esc cancel"));
				return;
			}

			const query = searchInput.getValue().trim();
			if (query.length < 2) {
				resultsText.setText(theme.fg("muted", "  Type at least 2 characters to search"));
				footerText.setText(theme.fg("dim", "Type to search • esc cancel"));
				return;
			}

			if (results.length === 0) {
				resultsText.setText(theme.fg("warning", "  No results found"));
				footerText.setText(theme.fg("dim", "Type to search • esc cancel"));
				return;
			}

			// Clamp
			if (selectedIndex < 0) selectedIndex = 0;
			if (selectedIndex >= results.length) selectedIndex = results.length - 1;
			if (selectedIndex < scrollOffset) scrollOffset = selectedIndex;
			if (selectedIndex >= scrollOffset + viewportSize) scrollOffset = selectedIndex - viewportSize + 1;

			const visible = results.slice(scrollOffset, scrollOffset + viewportSize);
			const rendered = visible.map((match, i) => {
				const idx = scrollOffset + i;
				const selected = idx === selectedIndex;
				const marker = selected ? theme.fg("accent", "›") : " ";
				const filePart = theme.fg("accent", match.displayPath);
				const linePart = theme.fg("muted", `:${match.lineNumber}`);
				const textPart = truncateToWidth(match.lineText, Math.max(20, contentWidth - match.displayPath.length - 10));
				const line = `${marker} ${filePart}${linePart}  ${textPart}`;
				return selected ? line : line;
			});
			resultsText.setText(rendered.join("\n"));

			footerText.setText(
				theme.fg("dim", `↑↓ navigate • enter preview • p preview • e edit • esc cancel • ${results.length} results`),
			);
		};

		return {
			render(width: number) {
				updateDisplay(width);
				return container.render(width);
			},
			invalidate() {
				container.invalidate();
			},
			handleInput(data: string) {
				if (matchesKey(data, "escape")) {
					done(undefined);
					return;
				}

				if (matchesKey(data, "up")) {
					selectedIndex = Math.max(0, selectedIndex - 1);
					tui.requestRender();
					return;
				}
				if (matchesKey(data, "down")) {
					selectedIndex = Math.min(results.length - 1, selectedIndex + 1);
					tui.requestRender();
					return;
				}
				if (matchesKey(data, "pageUp")) {
					selectedIndex = Math.max(0, selectedIndex - viewportSize);
					tui.requestRender();
					return;
				}
				if (matchesKey(data, "pageDown")) {
					selectedIndex = Math.min(results.length - 1, selectedIndex + viewportSize);
					tui.requestRender();
					return;
				}

				if (matchesKey(data, "enter")) {
					const match = results[selectedIndex];
					if (match) {
						done(undefined);
						// Open preview after done
						queueMicrotask(async () => {
							let action = await showFilePreview(ctx, match.filePath, match.displayPath, match.lineNumber);
							if (action === "edit") {
								await showFileEditorV2(ctx, match.filePath, match.displayPath, match.lineNumber);
							}
						});
					}
					return;
				}

				// Type into search input
				searchInput.handleInput(data);
				scheduleSearch();
				tui.requestRender();
			},
		};
	});
};

/* ──────────────────────── Fuzzy File Finder ──────────────────────── */

const showFuzzyFinder = async (pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> => {
	if (!ctx.hasUI) {
		ctx.ui.notify("Find requires interactive mode", "error");
		return;
	}

	const { files } = await buildFileEntries(pi, ctx);
	const fileItems = files.filter((f) => !f.isDirectory);

	await ctx.ui.custom<void>((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold(" ⚡ Quick Open (fuzzy find)")), 0, 0));

		const searchInput = new Input();
		container.addChild(searchInput);
		container.addChild(new Spacer(1));

		const resultsText = new Text("", 0, 0);
		container.addChild(resultsText);

		const footerText = new Text("", 0, 0);
		container.addChild(footerText);
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		let filteredFiles = fileItems.slice(0, 100);
		let selectedIndex = 0;
		let scrollOffset = 0;
		const viewportSize = 14;

		const updateFilter = () => {
			const query = searchInput.getValue().trim();
			if (!query) {
				filteredFiles = fileItems.slice(0, 100);
			} else {
				filteredFiles = fuzzyFilter(fileItems, query, (f) => f.displayPath).slice(0, 100);
			}
			selectedIndex = 0;
			scrollOffset = 0;
		};

		const updateDisplay = (width: number) => {
			const contentWidth = Math.max(10, width - 2);

			if (filteredFiles.length === 0) {
				resultsText.setText(theme.fg("warning", "  No matching files"));
				footerText.setText(theme.fg("dim", "Type to filter • esc cancel"));
				return;
			}

			if (selectedIndex < 0) selectedIndex = 0;
			if (selectedIndex >= filteredFiles.length) selectedIndex = filteredFiles.length - 1;
			if (selectedIndex < scrollOffset) scrollOffset = selectedIndex;
			if (selectedIndex >= scrollOffset + viewportSize) scrollOffset = selectedIndex - viewportSize + 1;

			const visible = filteredFiles.slice(scrollOffset, scrollOffset + viewportSize);
			const rendered = visible.map((file, i) => {
				const idx = scrollOffset + i;
				const selected = idx === selectedIndex;
				const marker = selected ? theme.fg("accent", "›") : " ";
				const icon = "📄";

				let tags = "";
				if (file.status) tags += theme.fg("warning", ` [${file.status}]`);
				if (file.hasSessionChange) tags += theme.fg("accent", " [session]");

				const dirPart = path.dirname(file.displayPath);
				const basePart = path.basename(file.displayPath);
				const dirStr = dirPart !== "." ? theme.fg("dim", `${dirPart}/`) : "";
				const fileStr = selected ? theme.fg("accent", basePart) : basePart;

				return truncateToWidth(`${marker} ${icon} ${dirStr}${fileStr}${tags}`, contentWidth);
			});
			resultsText.setText(rendered.join("\n"));

			footerText.setText(
				theme.fg("dim", `↑↓ navigate • enter preview • e edit • tab prompt • esc cancel • ${filteredFiles.length}/${fileItems.length} files`),
			);
		};

		return {
			render(width: number) {
				updateDisplay(width);
				return container.render(width);
			},
			invalidate() {
				container.invalidate();
			},
			handleInput(data: string) {
				if (matchesKey(data, "escape")) {
					done(undefined);
					return;
				}

				if (matchesKey(data, "up")) {
					selectedIndex = Math.max(0, selectedIndex - 1);
					tui.requestRender();
					return;
				}
				if (matchesKey(data, "down")) {
					selectedIndex = Math.min(filteredFiles.length - 1, selectedIndex + 1);
					tui.requestRender();
					return;
				}
				if (matchesKey(data, "pageUp")) {
					selectedIndex = Math.max(0, selectedIndex - viewportSize);
					tui.requestRender();
					return;
				}
				if (matchesKey(data, "pageDown")) {
					selectedIndex = Math.min(filteredFiles.length - 1, selectedIndex + viewportSize);
					tui.requestRender();
					return;
				}

				// Tab: add to prompt
				if (matchesKey(data, "tab")) {
					const file = filteredFiles[selectedIndex];
					if (file) {
						const mention = `@${file.displayPath}`;
						const current = ctx.ui.getEditorText();
						const separator = current && !current.endsWith(" ") ? " " : "";
						ctx.ui.setEditorText(`${current}${separator}${mention}`);
						ctx.ui.notify(`Added ${mention} to prompt`, "info");
						done(undefined);
					}
					return;
				}

				if (matchesKey(data, "enter")) {
					const file = filteredFiles[selectedIndex];
					if (file) {
						done(undefined);
						queueMicrotask(async () => {
							let action = await showFilePreview(ctx, file.resolvedPath, file.displayPath);
							if (action === "edit") {
								await showFileEditorV2(ctx, file.resolvedPath, file.displayPath);
							}
						});
					}
					return;
				}

				// Type into search
				searchInput.handleInput(data);
				updateFilter();
				tui.requestRender();
			},
		};
	});
};

/* ──────────────────────── Action Selector (enhanced) ──────────────────────── */

const showActionSelector = async (
	ctx: ExtensionContext,
	options: { canOpenInTerminalEditor: boolean; canDiff: boolean; canPreview: boolean; canEdit: boolean },
): Promise<"reveal" | "open" | "openInTerminalEditor" | "addToPrompt" | "diff" | "preview" | "edit" | null> => {
	const actions: SelectItem[] = [
		...(options.canPreview ? [{ value: "preview", label: "📄 Preview (syntax highlighted)" }] : []),
		...(options.canEdit ? [{ value: "edit", label: "✏️  Edit in TUI" }] : []),
		...(options.canDiff ? [{ value: "diff", label: "📊 Diff (Terminal)" }] : []),
		...(options.canOpenInTerminalEditor
			? [{ value: "openInTerminalEditor", label: "🖥  Open in terminal editor ($EDITOR)" }]
			: []),
		{ value: "open", label: "📂 Open (system)" },
		{ value: "reveal", label: "🔍 Reveal in Finder" },
		{ value: "addToPrompt", label: "💬 Add to prompt" },
	];

	return ctx.ui.custom<"reveal" | "open" | "openInTerminalEditor" | "addToPrompt" | "diff" | "preview" | "edit" | null>((
		tui,
		theme,
		_kb,
		done,
	) => {
		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold("Choose action")), 0, 0));

		const selectList = new SelectList(actions, actions.length, {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		});

		selectList.onSelect = (item) =>
			done(item.value as any);
		selectList.onCancel = () => done(null);

		container.addChild(selectList);
		container.addChild(new Text(theme.fg("dim", "Press enter to confirm or esc to cancel"), 0, 0));
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		return {
			render(width: number) {
				return container.render(width);
			},
			invalidate() {
				container.invalidate();
			},
			handleInput(data: string) {
				selectList.handleInput(data);
				tui.requestRender();
			},
		};
	});
};

/* ──────────────────────── File operations ──────────────────────── */

const openPath = async (pi: ExtensionAPI, ctx: ExtensionContext, target: FileEntry): Promise<void> => {
	if (!existsSync(target.resolvedPath)) {
		ctx.ui.notify(`File not found: ${target.displayPath}`, "error");
		return;
	}

	const command = process.platform === "darwin" ? "open" : "xdg-open";
	const result = await pi.exec(command, [target.resolvedPath]);
	if (result.code !== 0) {
		const errorMessage = result.stderr?.trim() || `Failed to open ${target.displayPath}`;
		ctx.ui.notify(errorMessage, "error");
	}
};

const openInTerminalEditor = async (ctx: ExtensionContext, target: FileEntry): Promise<void> => {
	const editorCmd = process.env.VISUAL || process.env.EDITOR;
	if (!editorCmd) {
		ctx.ui.notify("No editor configured. Set $VISUAL or $EDITOR.", "warning");
		return;
	}

	if (!existsSync(target.resolvedPath)) {
		ctx.ui.notify(`File not found: ${target.displayPath}`, "error");
		return;
	}

	if (target.isDirectory || statSync(target.resolvedPath).isDirectory()) {
		ctx.ui.notify("Directories cannot be opened in terminal editor", "warning");
		return;
	}

	const exitCode = await ctx.ui.custom<number | null>((tui, theme, _kb, done) => {
		const status = new Text(theme.fg("dim", `Opening ${editorCmd} ${target.displayPath}...`));

		queueMicrotask(() => {
			tui.stop();
			const [editor, ...editorArgs] = editorCmd.split(" ");
			const result = spawnSync(editor, [...editorArgs, target.resolvedPath], { stdio: "inherit" });
			tui.start();
			tui.requestRender(true);
			done(result.status ?? 1);
		});

		return status;
	});

	if (exitCode !== 0) {
		ctx.ui.notify(`Terminal editor exited with code ${exitCode ?? 1}`, "warning");
	}
};

const revealPath = async (pi: ExtensionAPI, ctx: ExtensionContext, target: FileEntry): Promise<void> => {
	if (!existsSync(target.resolvedPath)) {
		ctx.ui.notify(`File not found: ${target.displayPath}`, "error");
		return;
	}

	const isDirectory = target.isDirectory || statSync(target.resolvedPath).isDirectory();
	let command = "open";
	let args: string[] = [];

	if (process.platform === "darwin") {
		args = isDirectory ? [target.resolvedPath] : ["-R", target.resolvedPath];
	} else {
		command = "xdg-open";
		args = [isDirectory ? target.resolvedPath : path.dirname(target.resolvedPath)];
	}

	const result = await pi.exec(command, args);
	if (result.code !== 0) {
		const errorMessage = result.stderr?.trim() || `Failed to reveal ${target.displayPath}`;
		ctx.ui.notify(errorMessage, "error");
	}
};

/* ──────────────────────── Diff viewer ──────────────────────── */

const showTerminalDiffViewer = async (
	ctx: ExtensionContext,
	title: string,
	diffText: string,
	fallbackNotice?: string,
): Promise<void> => {
	const rawLines = diffText.replace(/\r\n/g, "\n").split("\n");
	// chromeLines: top border(1) + title(1) + optional notice(1) + footer(1) + bottom border(1) = 4-5
	const DIFF_CHROME = fallbackNotice ? 5 : 4;

	await ctx.ui.custom<void>((tui, theme, _kb, done) => {
		enableMouseTracking(tui);

		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold(` Diff • ${title}`)), 0, 0));
		if (fallbackNotice) {
			container.addChild(new Text(theme.fg("warning", fallbackNotice), 0, 0));
		}

		const body = new Text("", 0, 0);
		container.addChild(body);
		const footer = new Text("", 0, 0);
		container.addChild(footer);
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		let offset = 0;
		const getVP = () => getViewportSize(tui, DIFF_CHROME);

		const styleDiffLine = (line: string): string => {
			if (line.startsWith("+++ ") || line.startsWith("--- ") || line.startsWith("diff --git") || line.startsWith("index ")) {
				return theme.fg("muted", line);
			}
			if (line.startsWith("@@")) {
				return theme.fg("accent", line);
			}
			if (line.startsWith("+")) {
				return theme.fg("toolDiffAdded", line);
			}
			if (line.startsWith("-")) {
				return theme.fg("toolDiffRemoved", line);
			}
			return theme.fg("toolDiffContext", line);
		};

		const clampOffset = () => {
			const vp = getVP();
			const maxOffset = Math.max(0, rawLines.length - vp);
			if (offset > maxOffset) offset = maxOffset;
			if (offset < 0) offset = 0;
		};

		const updateText = (width: number) => {
			const viewportSize = getVP();
			clampOffset();
			const contentWidth = Math.max(10, width - 2);
			const slice = rawLines.slice(offset, offset + viewportSize);
			const rendered = slice.map((line) => truncateToWidth(styleDiffLine(line), contentWidth));
			body.setText(rendered.join("\n"));

			footer.setText(
				theme.fg(
					"dim",
					`↑↓ scroll • 🖱 wheel • PgUp/PgDn • Enter/Esc close • ${offset + 1}-${Math.min(offset + viewportSize, rawLines.length)}/${rawLines.length}`,
				),
			);
		};

		const cleanup = () => disableMouseTracking(tui);

		return {
			render(width: number) {
				updateText(width);
				return container.render(width);
			},
			invalidate() {
				container.invalidate();
			},
			handleInput(data: string) {
				// Mouse scroll
				if (isMouseScrollUp(data)) {
					offset -= 3;
					tui.requestRender();
					return;
				}
				if (isMouseScrollDown(data)) {
					offset += 3;
					tui.requestRender();
					return;
				}
				if (parseMouseEvent(data)) return;

				if (matchesKey(data, "escape") || matchesKey(data, "enter") || data === "q") {
					cleanup();
					done(undefined);
					return;
				}
				if (matchesKey(data, "up") || data === "k") {
					offset -= 1;
					tui.requestRender();
					return;
				}
				if (matchesKey(data, "down") || data === "j") {
					offset += 1;
					tui.requestRender();
					return;
				}
				if (matchesKey(data, "pageUp")) {
					offset -= getVP();
					tui.requestRender();
					return;
				}
				if (matchesKey(data, "pageDown")) {
					offset += getVP();
					tui.requestRender();
					return;
				}
				if (matchesKey(data, "home")) {
					offset = 0;
					tui.requestRender();
					return;
				}
				if (matchesKey(data, "end")) {
					offset = Math.max(0, rawLines.length - getVP());
					tui.requestRender();
				}
			},
		};
	});
};

const loadGitOrFallbackDiff = async (
	pi: ExtensionAPI,
	target: FileEntry,
	gitRoot: string | null,
): Promise<{ diffText: string; fallbackNotice?: string }> => {
	let fallbackNotice: string | undefined;

	if (gitRoot && !target.isDirectory) {
		const relative = path.relative(gitRoot, target.resolvedPath);
		const inRepo = relative && !relative.startsWith("..") && !path.isAbsolute(relative);
		const relativePosix = relative.split(path.sep).join("/");

		if (inRepo && target.isTracked) {
			const result = await pi.exec("git", ["diff", "--no-color", "HEAD", "--", relativePosix], { cwd: gitRoot });
			if (result.code === 0) {
				return { diffText: result.stdout ?? "" };
			}
			fallbackNotice = `git diff failed (${result.code}). Showing fallback diff.`;
		}

		if (inRepo && target.exists && !target.isTracked) {
			const result = await pi.exec("git", ["diff", "--no-color", "--no-index", "--", "/dev/null", target.resolvedPath], {
				cwd: gitRoot,
			});
			if (result.code === 0 || result.code === 1) {
				return { diffText: result.stdout ?? "", fallbackNotice };
			}
			fallbackNotice = `git no-index diff failed (${result.code}). Showing fallback diff.`;
		}
	}

	if (!target.exists || target.isDirectory) {
		return { diffText: "", fallbackNotice };
	}

	const fallbackResult = await pi.exec("diff", ["-u", "/dev/null", target.resolvedPath]);
	if (fallbackResult.code === 0 || fallbackResult.code === 1) {
		return {
			diffText: fallbackResult.stdout ?? "",
			fallbackNotice: fallbackNotice ?? "Git context unavailable; showing /dev/null fallback diff.",
		};
	}

	return {
		diffText: "",
		fallbackNotice: fallbackNotice ?? "Failed to generate diff in terminal.",
	};
};

const openDiff = async (pi: ExtensionAPI, ctx: ExtensionContext, target: FileEntry, gitRoot: string | null): Promise<void> => {
	if (target.isDirectory) {
		ctx.ui.notify("Diff is only available for files", "warning");
		return;
	}

	const { diffText, fallbackNotice } = await loadGitOrFallbackDiff(pi, target, gitRoot);
	if (!diffText.trim()) {
		ctx.ui.notify(fallbackNotice ?? `No diff for ${target.displayPath}`, "info");
		return;
	}

	await showTerminalDiffViewer(ctx, target.displayPath, diffText, fallbackNotice);
};

const addFileToPrompt = (ctx: ExtensionContext, target: FileEntry): void => {
	const mentionTarget = target.displayPath || target.resolvedPath;
	const mention = `@${mentionTarget}`;
	const current = ctx.ui.getEditorText();
	const separator = current && !current.endsWith(" ") ? " " : "";
	ctx.ui.setEditorText(`${current}${separator}${mention}`);
	ctx.ui.notify(`Added ${mention} to prompt`, "info");
};

/* ──────────────────────── File tree selector (enhanced) ──────────────────────── */

const showFileSelector = async (
	ctx: ExtensionContext,
	files: FileEntry[],
	selectedPath?: string | null,
): Promise<{ selected: FileEntry | null; quickAction: "diff" | "preview" | "edit" | null }> => {
	const tree = buildFileTree(files);
	const expanded = buildInitialExpandedSet(tree);
	const nodeById = new Map<string, FileTreeNode>();
	const parentById = new Map<string, string | null>();
	const fileNodeIdByCanonicalPath = new Map<string, string>();

	const walk = (node: FileTreeNode, parentId: string | null): void => {
		nodeById.set(node.id, node);
		parentById.set(node.id, parentId);
		if (node.file) {
			fileNodeIdByCanonicalPath.set(node.file.canonicalPath, node.id);
		}
		for (const child of node.children) {
			walk(child, node.id);
		}
	};
	walk(tree, null);

	let quickAction: "diff" | "preview" | "edit" | null = null;
	const selection = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold(" 📁 File tree")), 0, 0));

		const searchInput = new Input();
		container.addChild(searchInput);
		container.addChild(new Spacer(1));

		const listText = new Text("", 0, 0);
		container.addChild(listText);
		container.addChild(
			new Text(
				theme.fg(
					"dim",
					"filter • ←/→ fold • space toggle • enter action • p preview • e edit • d diff • esc quit",
				),
				0,
				0,
			),
		);
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		let rows = flattenTreeRows(tree, expanded, "");
		let selectedIndex = 0;
		let scrollOffset = 0;
		let selectedNodeId = selectedPath ? fileNodeIdByCanonicalPath.get(selectedPath) ?? null : null;
		const viewportSize = 14;

		const ensureSelection = () => {
			if (rows.length === 0) {
				selectedIndex = 0;
				scrollOffset = 0;
				selectedNodeId = null;
				return;
			}

			if (selectedNodeId) {
				const idx = rows.findIndex((row) => row.node.id === selectedNodeId);
				if (idx >= 0) {
					selectedIndex = idx;
				} else {
					selectedIndex = Math.min(selectedIndex, rows.length - 1);
					selectedNodeId = rows[selectedIndex]?.node.id ?? null;
				}
			} else {
				selectedIndex = Math.min(selectedIndex, rows.length - 1);
				selectedNodeId = rows[selectedIndex]?.node.id ?? null;
			}

			if (selectedIndex < scrollOffset) {
				scrollOffset = selectedIndex;
			}
			if (selectedIndex >= scrollOffset + viewportSize) {
				scrollOffset = selectedIndex - viewportSize + 1;
			}
		};

		const refreshRows = () => {
			rows = flattenTreeRows(tree, expanded, searchInput.getValue());
			ensureSelection();
		};

		const formatTags = (node: FileTreeNode): string => {
			if (node.isDirectory) {
				const tags: string[] = [];
				if (node.hasDirty) tags.push("dirty");
				if (node.hasSessionChange) tags.push("session");
				if (node.hasReferenced) tags.push("ref");
				return tags.length > 0 ? ` [${tags.join(",")}]` : "";
			}

			const tags: string[] = [];
			if (node.file?.status) tags.push(node.file.status);
			if (node.file?.hasSessionChange) tags.push("session");
			if (node.file?.isReferenced) tags.push("ref");
			return tags.length > 0 ? ` [${tags.join(",")}]` : "";
		};

		const updateListText = (width: number) => {
			if (rows.length === 0) {
				listText.setText(theme.fg("warning", "  No matching files"));
				return;
			}

			const queryActive = searchInput.getValue().trim().length > 0;
			const contentWidth = Math.max(10, width - 2);
			const visibleRows = rows.slice(scrollOffset, scrollOffset + viewportSize);
			const rendered = visibleRows.map((row, localIndex) => {
				const idx = scrollOffset + localIndex;
				const selected = idx === selectedIndex;
				const isExpanded = row.node.isDirectory && (queryActive || expanded.has(row.node.id));
				const marker = selected ? theme.fg("accent", "›") : " ";
				const indent = "  ".repeat(row.depth);
				const fold = row.node.isDirectory ? (isExpanded ? "▾" : "▸") : " ";
				const icon = row.node.isDirectory ? "📁" : "📄";
				const base = `${marker} ${indent}${fold} ${icon} ${row.node.name}${formatTags(row.node)}`;
				const line = truncateToWidth(base, contentWidth);
				return selected ? theme.fg("accent", line) : line;
			});

			listText.setText(rendered.join("\n"));
		};

		refreshRows();

		return {
			render(width: number) {
				updateListText(width);
				return container.render(width);
			},
			invalidate() {
				container.invalidate();
			},
			handleInput(data: string) {
				const current = rows[selectedIndex];
				const currentEntry = current ? toSelectableFileEntry(current.node, ctx.cwd) : null;

				// Quick actions
				if (data === "p" && searchInput.getValue() === "") {
					if (currentEntry && !currentEntry.isDirectory) {
						quickAction = "preview";
						done(current!.node.id);
						return;
					}
				}
				if (data === "e" && searchInput.getValue() === "") {
					if (currentEntry && !currentEntry.isDirectory) {
						quickAction = "edit";
						done(current!.node.id);
						return;
					}
				}

				if (matchesKey(data, "ctrl+shift+d")) {
					if (!currentEntry || currentEntry.isDirectory) {
						ctx.ui.notify("Diff is only available for files", "warning");
						return;
					}
					quickAction = "diff";
					done(current!.node.id);
					return;
				}
				if (data === "d" && searchInput.getValue() === "") {
					if (currentEntry && !currentEntry.isDirectory) {
						quickAction = "diff";
						done(current!.node.id);
						return;
					}
				}

				const kb = getEditorKeybindings();
				if (kb.matches(data, "selectCancel")) {
					done(null);
					return;
				}

				if (kb.matches(data, "selectConfirm")) {
					if (current) {
						done(current.node.id);
					}
					return;
				}

				if (kb.matches(data, "selectUp")) {
					selectedIndex = Math.max(0, selectedIndex - 1);
					selectedNodeId = rows[selectedIndex]?.node.id ?? null;
					ensureSelection();
					tui.requestRender();
					return;
				}

				if (kb.matches(data, "selectDown")) {
					selectedIndex = Math.min(rows.length - 1, selectedIndex + 1);
					selectedNodeId = rows[selectedIndex]?.node.id ?? null;
					ensureSelection();
					tui.requestRender();
					return;
				}

				if (kb.matches(data, "selectPageUp")) {
					selectedIndex = Math.max(0, selectedIndex - viewportSize);
					selectedNodeId = rows[selectedIndex]?.node.id ?? null;
					ensureSelection();
					tui.requestRender();
					return;
				}

				if (kb.matches(data, "selectPageDown")) {
					selectedIndex = Math.min(rows.length - 1, selectedIndex + viewportSize);
					selectedNodeId = rows[selectedIndex]?.node.id ?? null;
					ensureSelection();
					tui.requestRender();
					return;
				}

				if ((matchesKey(data, "right") || (data === "l" && searchInput.getValue() === "")) && current?.node.isDirectory) {
					expanded.add(current.node.id);
					refreshRows();
					tui.requestRender();
					return;
				}

				if ((matchesKey(data, "left") || (data === "h" && searchInput.getValue() === "")) && current?.node) {
					if (current.node.isDirectory && expanded.has(current.node.id)) {
						expanded.delete(current.node.id);
						refreshRows();
						tui.requestRender();
						return;
					}

					const parentId = parentById.get(current.node.id);
					if (parentId) {
						selectedNodeId = parentId;
						ensureSelection();
						tui.requestRender();
					}
					return;
				}

				if (matchesKey(data, "space") && current?.node.isDirectory) {
					if (expanded.has(current.node.id)) {
						expanded.delete(current.node.id);
					} else {
						expanded.add(current.node.id);
					}
					refreshRows();
					tui.requestRender();
					return;
				}

				searchInput.handleInput(data);
				refreshRows();
				tui.requestRender();
			},
		};
	});

	const selectedNode = selection ? nodeById.get(selection) ?? null : null;
	const selected = selectedNode ? toSelectableFileEntry(selectedNode, ctx.cwd) : null;
	return { selected, quickAction };
};

/* ──────────────────────── Main file browser ──────────────────────── */

const runFileBrowser = async (pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> => {
	if (!ctx.hasUI) {
		ctx.ui.notify("Files requires interactive mode", "error");
		return;
	}

	const { files, gitRoot } = await buildFileEntries(pi, ctx);
	if (files.length === 0) {
		ctx.ui.notify("No files found", "info");
		return;
	}

	let lastSelectedPath: string | null = null;
	while (true) {
		const { selected, quickAction } = await showFileSelector(ctx, files, lastSelectedPath);
		if (!selected) {
			return;
		}

		lastSelectedPath = selected.canonicalPath;

		const canOpenInTerminalEditor = selected.exists && !selected.isDirectory;
		const canDiff = !selected.isDirectory;
		const canPreview = selected.exists && !selected.isDirectory;
		const canEdit = selected.exists && !selected.isDirectory;

		// Handle quick actions directly
		if (quickAction === "diff") {
			await openDiff(pi, ctx, selected, gitRoot);
			continue;
		}
		if (quickAction === "preview") {
			const previewResult = await showFilePreview(ctx, selected.resolvedPath, selected.displayPath);
			if (previewResult === "edit") {
				await showFileEditorV2(ctx, selected.resolvedPath, selected.displayPath);
			}
			continue;
		}
		if (quickAction === "edit") {
			await showFileEditorV2(ctx, selected.resolvedPath, selected.displayPath);
			continue;
		}

		const action = await showActionSelector(ctx, {
			canOpenInTerminalEditor,
			canDiff,
			canPreview,
			canEdit,
		});
		if (!action) {
			continue;
		}

		switch (action) {
			case "preview": {
				const previewResult = await showFilePreview(ctx, selected.resolvedPath, selected.displayPath);
				if (previewResult === "edit") {
					await showFileEditorV2(ctx, selected.resolvedPath, selected.displayPath);
				}
				break;
			}
			case "edit":
				await showFileEditorV2(ctx, selected.resolvedPath, selected.displayPath);
				break;
			case "open":
				await openPath(pi, ctx, selected);
				break;
			case "openInTerminalEditor":
				await openInTerminalEditor(ctx, selected);
				break;
			case "addToPrompt":
				addFileToPrompt(ctx, selected);
				break;
			case "diff":
				await openDiff(pi, ctx, selected, gitRoot);
				break;
			default:
				await revealPath(pi, ctx, selected);
				break;
		}
	}
};

/* ──────────────────────── Extension registration ──────────────────────── */

export default function (pi: ExtensionAPI): void {
	// File tree browser
	pi.registerCommand("files", {
		description: "Browse files with git status, preview, edit, and search",
		handler: async (_args, ctx) => {
			await runFileBrowser(pi, ctx);
		},
	});

	// Fuzzy file finder
	pi.registerCommand("find", {
		description: "Quick open file (fuzzy finder like Ctrl+P)",
		handler: async (_args, ctx) => {
			await showFuzzyFinder(pi, ctx);
		},
	});

	// Grep search
	pi.registerCommand("grep", {
		description: "Search file contents (full-text search)",
		handler: async (args, ctx) => {
			if (args && args.trim()) {
				// Direct search with argument
				const gitRoot = await getGitRoot(pi, ctx.cwd);
				const matches = await runGrep(pi, ctx, args.trim(), gitRoot);
				if (matches.length === 0) {
					ctx.ui.notify(`No results for "${args.trim()}"`, "info");
					return;
				}
				// Show in a quick selector
				await showGrepUI(pi, ctx);
			} else {
				await showGrepUI(pi, ctx);
			}
		},
	});

	// Keyboard shortcuts
	pi.registerShortcut("ctrl+shift+o", {
		description: "Browse files (tree view)",
		handler: async (ctx) => {
			await runFileBrowser(pi, ctx);
		},
	});

	pi.registerShortcut("ctrl+shift+f", {
		description: "Search in files (grep)",
		handler: async (ctx) => {
			await showGrepUI(pi, ctx);
		},
	});

	pi.registerShortcut("ctrl+shift+p", {
		description: "Quick open file (fuzzy finder)",
		handler: async (ctx) => {
			await showFuzzyFinder(pi, ctx);
		},
	});

	pi.registerShortcut("ctrl+shift+r", {
		description: "Quick Look the latest file reference",
		handler: async (ctx) => {
			const entries = ctx.sessionManager.getBranch();
			const latest = findLatestFileReference(entries, ctx.cwd);

			if (!latest) {
				ctx.ui.notify("No file reference found in the session", "warning");
				return;
			}

			const canonical = toCanonicalPath(latest.path);
			if (!canonical) {
				ctx.ui.notify(`File not found: ${latest.display}`, "error");
				return;
			}

			await quickLookPath(pi, ctx, {
				canonicalPath: canonical.canonicalPath,
				resolvedPath: canonical.canonicalPath,
				displayPath: latest.display,
				exists: true,
				isDirectory: canonical.isDirectory,
				status: undefined,
				inRepo: false,
				isTracked: false,
				isReferenced: true,
				hasSessionChange: false,
				lastTimestamp: 0,
			});
		},
	});
}
