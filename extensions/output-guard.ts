/**
 * Output Guard Extension
 *
 * Fixes one practical issue:
 * Large tool outputs can flood LLM context.
 */

import type { ExtensionAPI, ToolResultEvent } from "@mariozechner/pi-coding-agent";

const GREP_LIMITS = {
	maxLines: 180,
	maxChars: 12000,
	label: "grep",
};

const BASH_LIMITS = {
	maxLines: 200,
	maxChars: 14000,
	label: "bash",
};

const BASH_SEARCH_LIMITS = {
	maxLines: 140,
	maxChars: 10000,
	label: "bash grep/rg",
};

const SEARCH_CMD_RE = /(^|[\s|;&()])(rg|grep)(?=$|[\s|;&()])/i;

interface ClipResult {
	text: string;
	truncated: boolean;
	originalLines: number;
	originalChars: number;
}

function clipText(text: string, maxLines: number, maxChars: number): ClipResult {
	const originalLines = text === "" ? 0 : text.split("\n").length;
	const originalChars = text.length;

	let next = text;
	let truncated = false;

	const lines = next.split("\n");
	if (lines.length > maxLines) {
		next = lines.slice(0, maxLines).join("\n");
		truncated = true;
	}

	if (next.length > maxChars) {
		next = next.slice(0, maxChars);
		truncated = true;
	}

	return {
		text: next,
		truncated,
		originalLines,
		originalChars,
	};
}

function isBashSearchCommand(event: ToolResultEvent): boolean {
	if (event.toolName !== "bash") return false;
	const command = (event.input as { command?: unknown }).command;
	return typeof command === "string" && SEARCH_CMD_RE.test(command);
}

function getLimits(event: ToolResultEvent):
	| { maxLines: number; maxChars: number; label: string }
	| undefined {
	if (event.toolName === "grep") return GREP_LIMITS;
	if (isBashSearchCommand(event)) return BASH_SEARCH_LIMITS;
	if (event.toolName === "bash") return BASH_LIMITS;
	return undefined;
}

function mergeDetails(details: unknown, patch: Record<string, unknown>): unknown {
	if (details && typeof details === "object" && !Array.isArray(details)) {
		return { ...(details as Record<string, unknown>), ...patch };
	}
	return patch;
}

export default function outputGuardExtension(pi: ExtensionAPI): void {
	pi.on("tool_result", async (event) => {
		const limits = getLimits(event);
		if (!limits) return undefined;

		let clipped = false;
		let clippedBlocks = 0;
		let firstClippedIndex = -1;
		let maxOriginalLines = 0;
		let maxOriginalChars = 0;

		const content = event.content.map((block, idx) => {
			if (!block || typeof block !== "object" || block.type !== "text" || typeof block.text !== "string") {
				return block;
			}

			const result = clipText(block.text, limits.maxLines, limits.maxChars);
			maxOriginalLines = Math.max(maxOriginalLines, result.originalLines);
			maxOriginalChars = Math.max(maxOriginalChars, result.originalChars);

			if (!result.truncated) return block;

			clipped = true;
			clippedBlocks += 1;
			if (firstClippedIndex === -1) firstClippedIndex = idx;

			return { ...block, text: result.text };
		});

		if (!clipped) return undefined;

		if (firstClippedIndex >= 0) {
			const first = content[firstClippedIndex];
			if (first && typeof first === "object" && first.type === "text" && typeof first.text === "string") {
				const notice =
					`\n\n[output-guard: clipped ${limits.label} output to <= ${limits.maxLines} lines and <= ${limits.maxChars} chars per text block ` +
					`(largest block before clipping: ${maxOriginalLines} lines, ${maxOriginalChars} chars).]`;
				content[firstClippedIndex] = { ...first, text: first.text + notice };
			}
		}

		return {
			content,
			details: mergeDetails(event.details, {
				outputGuard: {
					applied: true,
					tool: event.toolName,
					blocksClipped: clippedBlocks,
					maxLines: limits.maxLines,
					maxChars: limits.maxChars,
				},
			}),
		};
	});
}
