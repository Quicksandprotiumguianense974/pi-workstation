/**
 * LLM Council Extension
 *
 * Multiple LLMs work independently, optionally review each other's work,
 * then a chairman synthesizes the final answer.
 *
 * Supports templates for different workflows:
 *   - ask:     Pure Q&A (no tools, original llm-council style)
 *   - review:  Code review (each member reads code, produces findings)
 *   - explore: Codebase exploration (each member investigates, reports)
 *
 * Custom templates can be added via ~/.pi/agent/council-templates/*.md
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { DynamicBorder, getMarkdownTheme, getSettingsListTheme } from "@mariozechner/pi-coding-agent";
import {
	Container,
	Markdown,
	type SelectItem,
	SelectList,
	type SettingItem,
	SettingsList,
	Spacer,
	Text,
} from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";

// ── Templates ───────────────────────────────────────────────────────────────

interface CouncilTemplate {
	name: string;
	description: string;
	tools?: string; // comma-separated tools for subagents, undefined = no tools
	review: boolean; // whether to run Stage 2 peer review
	stage1System: string; // system prompt for members in stage 1
	stage2System?: string; // system prompt for reviewers in stage 2
	stage3System: string; // system prompt for chairman in stage 3
	// Prompt builders (receive the user query, return the actual prompt)
	buildStage1Prompt: (query: string) => string;
	buildStage2Prompt: (query: string, responsesText: string) => string;
	buildStage3Prompt: (query: string, stage1Summary: string, stage2Summary: string) => string;
}

const TEMPLATES: Record<string, CouncilTemplate> = {
	ask: {
		name: "ask",
		description: "Multi-LLM Q&A (no tools)",
		review: false,
		stage1System: "Answer the user's question thoroughly and accurately. Provide your best analysis.",
		stage2System: "You are an expert evaluator. Be fair, thorough, and objective in your analysis.",
		stage3System:
			"You are the Chairman of an LLM Council. Produce the definitive answer by synthesizing multiple expert opinions.",
		buildStage1Prompt: (query) => query,
		buildStage2Prompt: (query, responsesText) =>
			`You are evaluating different responses to the following question:

Question: ${query}

Here are the responses from different models (anonymized):

${responsesText}

Your task:
1. Evaluate each response individually. For each, explain what it does well and what it does poorly.
2. At the very end, provide a final ranking.

IMPORTANT: Your final ranking MUST be formatted EXACTLY as:
FINAL RANKING:
1. Response X
2. Response Y
3. Response Z

Now provide your evaluation and ranking:`,
		buildStage3Prompt: (query, stage1Summary, stage2Summary) => {
			let prompt = `You are the Chairman of an LLM Council. Multiple AI models have answered a user's question.

Original Question: ${query}

INDIVIDUAL RESPONSES:
${stage1Summary}`;

			if (stage2Summary) {
				prompt += `

PEER REVIEWS:
${stage2Summary}`;
			}

			prompt += `

Synthesize all information into a single, comprehensive, accurate answer. Consider:
- Individual responses and their unique insights${stage2Summary ? "\n- Peer rankings and what they reveal about quality" : ""}
- Points of agreement and disagreement

Provide a clear, well-reasoned final answer that represents the council's collective wisdom:`;
			return prompt;
		},
	},

	review: {
		name: "review",
		description: "Multi-LLM code review (each member reads code independently)",
		tools: "read,grep,find,ls,bash",
		review: true,
		stage1System: `You are an expert code reviewer. You have access to the codebase via tools.
Read the relevant code, analyze changes, and produce a structured review.

Tag each finding with a priority level:
- [P0] - Drop everything. Blocking release/operations.
- [P1] - Urgent. Should be addressed in the next cycle.
- [P2] - Normal. To be fixed eventually.
- [P3] - Low. Nice to have.

Output format:
## Files Reviewed
- List files you examined

## Findings
For each issue:
- Priority tag, file:line, description, suggested fix

## Verdict
"correct" (no blocking issues) or "needs attention" (has P0/P1/P2 issues)`,
		stage2System:
			"You are a senior reviewer evaluating other reviewers' code review reports. Check for missed issues, false positives, and ranking quality.",
		stage3System: `You are the Chairman synthesizing multiple independent code reviews into one unified report.
Merge all findings, deduplicate, resolve conflicts, and produce a single prioritized report.`,
		buildStage1Prompt: (query) => `Code review task: ${query}

Use your tools to read the relevant code and produce your review.`,
		buildStage2Prompt: (query, responsesText) =>
			`Multiple reviewers independently reviewed this code change:

Review task: ${query}

Here are their reports (anonymized):

${responsesText}

Evaluate each review:
1. Did the reviewer catch real issues or flag false positives?
2. Did they miss anything important?
3. Is their severity assessment accurate?

FINAL RANKING:
(rank from most useful to least useful)`,
		buildStage3Prompt: (query, stage1Summary, stage2Summary) =>
			`Multiple AI code reviewers independently reviewed a code change, then evaluated each other's reviews.

Review task: ${query}

INDIVIDUAL REVIEWS:
${stage1Summary}

PEER EVALUATIONS:
${stage2Summary}

Produce the definitive unified code review:
1. Merge all valid findings (deduplicate)
2. Resolve disagreements using peer evaluations
3. Assign final priority tags [P0]-[P3]
4. Output in this format:

## Files Reviewed
## Findings (prioritized)
## Verdict
## Recommended Fix Order`,
	},

	explore: {
		name: "explore",
		description: "Multi-LLM codebase exploration (each member investigates independently)",
		tools: "read,grep,find,ls,bash",
		review: false,
		stage1System: `You are a codebase explorer. Use your tools to investigate the codebase thoroughly.
Find relevant files, trace dependencies, understand architecture, and report your findings.

Output format:
## Files Retrieved
List with exact paths and what you found:
1. \`path/to/file.ts\` - Description

## Key Code
Critical types, interfaces, or functions (with actual code snippets)

## Architecture
How the pieces connect

## Insights
Key observations, potential issues, or interesting patterns`,
		stage3System: `You are the Chairman synthesizing multiple independent codebase explorations.
Each explorer investigated from a different angle. Combine their findings into a comprehensive understanding.`,
		buildStage1Prompt: (query) => `Exploration task: ${query}

Use your tools to explore the codebase and report your findings.`,
		buildStage2Prompt: (query, responsesText) =>
			`Multiple explorers investigated the codebase for: ${query}

${responsesText}

Evaluate completeness and accuracy of each exploration.

FINAL RANKING:
(rank from most thorough to least)`,
		buildStage3Prompt: (query, stage1Summary, _stage2Summary) =>
			`Multiple AI explorers independently investigated the codebase for: ${query}

INDIVIDUAL EXPLORATIONS:
${stage1Summary}

Synthesize all explorations into one comprehensive report:
1. Combine all file discoveries (deduplicate)
2. Merge architectural insights
3. Highlight consensus and unique findings
4. Produce a unified understanding with concrete code references`,
	},
};

function loadCustomTemplates(): Record<string, CouncilTemplate> {
	const templateDir = path.join(os.homedir(), ".pi", "agent", "council-templates");
	const custom: Record<string, CouncilTemplate> = {};
	if (!fs.existsSync(templateDir)) return custom;

	for (const file of fs.readdirSync(templateDir)) {
		if (!file.endsWith(".md")) continue;
		try {
			const content = fs.readFileSync(path.join(templateDir, file), "utf-8");
			const parsed = parseFrontmatter(content);
			if (!parsed.frontmatter.name) continue;
			const fm = parsed.frontmatter;
			custom[fm.name] = {
				name: fm.name,
				description: fm.description || fm.name,
				tools: fm.tools || undefined,
				review: fm.review !== "false",
				stage1System: parsed.body,
				stage2System: fm.stage2System || undefined,
				stage3System:
					fm.stage3System ||
					"You are the Chairman. Synthesize all responses into one comprehensive answer.",
				buildStage1Prompt: (query) => query,
				buildStage2Prompt: (query, responsesText) =>
					`Evaluate these responses to: ${query}\n\n${responsesText}\n\nFINAL RANKING:`,
				buildStage3Prompt: (query, s1, s2) =>
					`Question: ${query}\n\nResponses:\n${s1}\n\nReviews:\n${s2}\n\nSynthesize:`,
			};
		} catch {
			/* skip bad files */
		}
	}
	return custom;
}

function parseFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
	const fm: Record<string, string> = {};
	if (!content.startsWith("---")) return { frontmatter: fm, body: content };
	const end = content.indexOf("\n---", 3);
	if (end === -1) return { frontmatter: fm, body: content };
	const yamlBlock = content.slice(4, end);
	for (const line of yamlBlock.split("\n")) {
		const idx = line.indexOf(":");
		if (idx > 0) {
			fm[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
		}
	}
	return { frontmatter: fm, body: content.slice(end + 4).trim() };
}

function getAllTemplates(): Record<string, CouncilTemplate> {
	return { ...TEMPLATES, ...loadCustomTemplates() };
}

// ── Config ──────────────────────────────────────────────────────────────────

interface TemplateOverride {
	review?: boolean;
	tools?: string | null; // null = no tools, string = comma-separated, undefined = use default
}

interface CouncilConfig {
	members: string[];
	chairman: string;
	templates?: Record<string, TemplateOverride>;
}

const DEFAULT_CONFIG: CouncilConfig = {
	members: ["anthropic/claude-sonnet-4-5-20250514", "openai/gpt-4.1", "google/gemini-2.5-pro"],
	chairman: "anthropic/claude-sonnet-4-5-20250514",
	templates: {},
};

function loadConfig(): CouncilConfig {
	const configPath = path.join(os.homedir(), ".pi", "agent", "council.json");
	try {
		if (fs.existsSync(configPath)) {
			const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
			return {
				members: raw.members ?? DEFAULT_CONFIG.members,
				chairman: raw.chairman ?? DEFAULT_CONFIG.chairman,
				templates: raw.templates ?? {},
			};
		}
	} catch {
		/* use default */
	}
	return DEFAULT_CONFIG;
}

function saveConfig(config: CouncilConfig): void {
	const configPath = path.join(os.homedir(), ".pi", "agent", "council.json");
	const dir = path.dirname(configPath);
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

/** Apply config overrides to a template, returning a new copy */
function applyOverrides(template: CouncilTemplate, overrides?: TemplateOverride): CouncilTemplate {
	if (!overrides) return template;
	return {
		...template,
		review: overrides.review ?? template.review,
		tools: overrides.tools === null ? undefined : (overrides.tools ?? template.tools),
	};
}

// ── Types ───────────────────────────────────────────────────────────────────

interface MemberResponse {
	model: string;
	response: string;
	exitCode: number;
	error?: string;
	usage?: UsageStats;
}

interface ReviewResult {
	model: string;
	review: string;
	parsedRanking: string[];
	exitCode: number;
	error?: string;
	usage?: UsageStats;
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

interface CouncilDetails {
	stage: "stage1" | "stage2" | "stage3" | "complete";
	template: string;
	query: string;
	stage1: MemberResponse[];
	stage2: ReviewResult[];
	stage3?: MemberResponse;
	labelMap?: Record<string, string>;
}

// ── Subagent runner ─────────────────────────────────────────────────────────

function formatTokens(n: number): string {
	if (n < 1000) return n.toString();
	if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
	return `${Math.round(n / 1000)}k`;
}

function formatUsage(u: UsageStats, model?: string): string {
	const parts: string[] = [];
	if (u.turns) parts.push(`${u.turns} turn${u.turns > 1 ? "s" : ""}`);
	if (u.input) parts.push(`↑${formatTokens(u.input)}`);
	if (u.output) parts.push(`↓${formatTokens(u.output)}`);
	if (u.cost) parts.push(`$${u.cost.toFixed(4)}`);
	if (model) parts.push(model);
	return parts.join(" ");
}

function writeTempPrompt(name: string, content: string): { dir: string; file: string } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-council-"));
	const file = path.join(dir, `${name.replace(/[^\w.-]+/g, "_")}.md`);
	fs.writeFileSync(file, content, { encoding: "utf-8", mode: 0o600 });
	return { dir, file };
}

function cleanupTemp(dir: string, file: string) {
	try {
		fs.unlinkSync(file);
	} catch {
		/* ignore */
	}
	try {
		fs.rmdirSync(dir);
	} catch {
		/* ignore */
	}
}

async function runPiSubagent(
	model: string,
	prompt: string,
	systemPrompt: string | undefined,
	cwd: string,
	tools?: string,
	signal?: AbortSignal,
): Promise<{ response: string; exitCode: number; error?: string; usage: UsageStats }> {
	const args: string[] = ["--mode", "json", "-p", "--no-session", "--model", model];

	if (tools) {
		args.push("--tools", tools);
	} else {
		args.push("--no-tools");
	}

	let tmpDir: string | null = null;
	let tmpFile: string | null = null;

	if (systemPrompt) {
		const tmp = writeTempPrompt("system", systemPrompt);
		tmpDir = tmp.dir;
		tmpFile = tmp.file;
		args.push("--append-system-prompt", tmpFile);
	}

	args.push(prompt);

	const usage: UsageStats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
	let lastAssistantText = "";
	let stderr = "";

	try {
		const exitCode = await new Promise<number>((resolve) => {
			const proc = spawn("pi", args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
			let buffer = "";

			proc.stdout.on("data", (data: Buffer) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) {
					if (!line.trim()) continue;
					try {
						const event = JSON.parse(line);
						if (event.type === "message_end" && event.message?.role === "assistant") {
							usage.turns++;
							const msg = event.message;
							for (const part of msg.content ?? []) {
								if (part.type === "text") lastAssistantText = part.text;
							}
							const u = msg.usage;
							if (u) {
								usage.input += u.input || 0;
								usage.output += u.output || 0;
								usage.cacheRead += u.cacheRead || 0;
								usage.cacheWrite += u.cacheWrite || 0;
								usage.cost += u.cost?.total || 0;
							}
						}
					} catch {
						/* skip non-json */
					}
				}
			});

			proc.stderr.on("data", (data: Buffer) => {
				stderr += data.toString();
			});
			proc.on("close", (code) => {
				if (buffer.trim()) {
					try {
						const event = JSON.parse(buffer);
						if (event.type === "message_end" && event.message?.role === "assistant") {
							for (const part of event.message.content ?? []) {
								if (part.type === "text") lastAssistantText = part.text;
							}
						}
					} catch {
						/* ignore */
					}
				}
				resolve(code ?? 1);
			});
			proc.on("error", () => resolve(1));

			if (signal) {
				const kill = () => {
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (signal.aborted) kill();
				else signal.addEventListener("abort", kill, { once: true });
			}
		});

		return {
			response: lastAssistantText,
			exitCode,
			error: exitCode !== 0 ? stderr || "(unknown error)" : undefined,
			usage,
		};
	} finally {
		if (tmpFile && tmpDir) cleanupTemp(tmpDir, tmpFile);
	}
}

// ── Concurrency helper ──────────────────────────────────────────────────────

type SubagentResult = Awaited<ReturnType<typeof runPiSubagent>>;

async function runParallel(
	items: { model: string; prompt: string; systemPrompt?: string; tools?: string }[],
	cwd: string,
	signal: AbortSignal | undefined,
	onComplete: (index: number, result: SubagentResult) => void,
): Promise<SubagentResult[]> {
	const MAX_CONCURRENCY = 4;
	const results: SubagentResult[] = new Array(items.length);
	let nextIdx = 0;

	const workers = Array.from({ length: Math.min(MAX_CONCURRENCY, items.length) }, async () => {
		while (true) {
			const idx = nextIdx++;
			if (idx >= items.length) return;
			const item = items[idx];
			const result = await runPiSubagent(item.model, item.prompt, item.systemPrompt, cwd, item.tools, signal);
			results[idx] = result;
			onComplete(idx, result);
		}
	});

	await Promise.all(workers);
	return results;
}

// ── Ranking parser ──────────────────────────────────────────────────────────

function parseRanking(text: string): string[] {
	const ranking: string[] = [];
	const section = text.split("FINAL RANKING:").pop() || "";
	for (const line of section.split("\n")) {
		const match = line.trim().match(/^\d+\.\s*(Response\s+[A-Z])/i);
		if (match) ranking.push(match[1]);
	}
	return ranking;
}

function chr(code: number): string {
	return String.fromCharCode(code);
}

function aggregateUsage(details: CouncilDetails): UsageStats {
	const total: UsageStats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
	const add = (u?: UsageStats) => {
		if (!u) return;
		total.input += u.input;
		total.output += u.output;
		total.cacheRead += u.cacheRead;
		total.cacheWrite += u.cacheWrite;
		total.cost += u.cost;
		total.turns += u.turns;
	};
	for (const r of details.stage1) add(r.usage);
	for (const r of details.stage2) add(r.usage);
	if (details.stage3) add(details.stage3.usage);
	return total;
}

// ── Council runner (shared between tool and command) ─────────────────────────

async function runCouncil(
	template: CouncilTemplate,
	query: string,
	config: CouncilConfig,
	cwd: string,
	signal: AbortSignal | undefined,
	onUpdate: ((partial: any) => void) | undefined,
): Promise<{ content: { type: "text"; text: string }[]; details: CouncilDetails }> {
	const details: CouncilDetails = {
		stage: "stage1",
		template: template.name,
		query,
		stage1: [],
		stage2: [],
	};

	const emitUpdate = (text: string) => {
		onUpdate?.({
			content: [{ type: "text", text }],
			details: { ...details },
		});
	};

	// ── Stage 1: Parallel independent work ──────────────────────────────

	// Pre-populate with pending entries so UI shows all members immediately
	details.stage1 = config.members.map((model) => ({
		model,
		response: "",
		exitCode: -1, // -1 = pending
		usage: undefined,
	}));
	emitUpdate(`[${template.name}] Stage 1: ${config.members.length} members working...`);

	const stage1Items = config.members.map((model) => ({
		model,
		prompt: template.buildStage1Prompt(query),
		systemPrompt: template.stage1System,
		tools: template.tools,
	}));

	const stage1Raw = await runParallel(stage1Items, cwd, signal, (idx, result) => {
		// Update the specific member's entry as it completes
		details.stage1[idx] = {
			model: config.members[idx],
			response: result.response,
			exitCode: result.exitCode,
			error: result.error,
			usage: result.usage,
		};
		const done = details.stage1.filter((r) => r.exitCode !== -1).length;
		emitUpdate(`[${template.name}] Stage 1: ${done}/${config.members.length} done`);
	});

	// Final sync (in case any were missed)
	details.stage1 = stage1Raw.map((r, i) => ({
		model: config.members[i],
		response: r.response,
		exitCode: r.exitCode,
		error: r.error,
		usage: r.usage,
	}));

	const validResponses = details.stage1.filter((r) => r.exitCode === 0 && r.response);
	if (validResponses.length === 0) {
		const errors = details.stage1
			.map((r) => `${r.model}: exit=${r.exitCode}${r.error ? ` ${r.error.slice(0, 200)}` : ""}`)
			.join("\n");
		return {
			content: [{ type: "text", text: `Council failed: no models returned valid responses.\n\n${errors}` }],
			details,
		};
	}

	// ── Stage 2: Peer review (optional) ─────────────────────────────────

	if (template.review) {
		details.stage = "stage2";
		emitUpdate(`[${template.name}] Stage 2: ${config.members.length} members reviewing...`);

		const labels = validResponses.map((_, i) => chr(65 + i));
		const labelMap: Record<string, string> = {};
		const responsesText = validResponses
			.map((r, i) => {
				const label = `Response ${labels[i]}`;
				labelMap[label] = r.model;
				return `${label}:\n${r.response}`;
			})
			.join("\n\n---\n\n");
		details.labelMap = labelMap;

		// Pre-populate with pending entries
		details.stage2 = config.members.map((model) => ({
			model,
			review: "",
			parsedRanking: [],
			exitCode: -1,
			usage: undefined,
		}));
		emitUpdate(`[${template.name}] Stage 2: ${config.members.length} members reviewing...`);

		const stage2Items = config.members.map((model) => ({
			model,
			prompt: template.buildStage2Prompt(query, responsesText),
			systemPrompt: template.stage2System,
		}));

		const stage2Raw = await runParallel(stage2Items, cwd, signal, (idx, result) => {
			details.stage2[idx] = {
				model: config.members[idx],
				review: result.response,
				parsedRanking: parseRanking(result.response),
				exitCode: result.exitCode,
				error: result.error,
				usage: result.usage,
			};
			const done = details.stage2.filter((r) => r.exitCode !== -1).length;
			emitUpdate(`[${template.name}] Stage 2: ${done}/${config.members.length} reviews done`);
		});

		details.stage2 = stage2Raw.map((r, i) => ({
			model: config.members[i],
			review: r.response,
			parsedRanking: parseRanking(r.response),
			exitCode: r.exitCode,
			error: r.error,
			usage: r.usage,
		}));
	}

	// ── Stage 3: Chairman synthesis ─────────────────────────────────────

	details.stage = "stage3";
	emitUpdate(`[${template.name}] Stage 3: Chairman synthesizing...`);

	const stage1Summary = validResponses.map((r) => `Model ${r.model}:\n${r.response}`).join("\n\n---\n\n");

	const stage2Summary = details.stage2
		.filter((r) => r.exitCode === 0)
		.map((r) => `Reviewer ${r.model}:\n${r.review}`)
		.join("\n\n---\n\n");

	const chairmanPrompt = template.buildStage3Prompt(query, stage1Summary, stage2Summary);

	const chairmanResult = await runPiSubagent(
		config.chairman,
		chairmanPrompt,
		template.stage3System,
		cwd,
		undefined, // chairman never needs tools
		signal,
	);

	details.stage3 = {
		model: config.chairman,
		response: chairmanResult.response,
		exitCode: chairmanResult.exitCode,
		error: chairmanResult.error,
		usage: chairmanResult.usage,
	};
	details.stage = "complete";

	return {
		content: [{ type: "text", text: chairmanResult.response || "(Chairman produced no output)" }],
		details,
	};
}

// ── Extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// Get template names for StringEnum
	const builtinTemplateNames = Object.keys(TEMPLATES);

	pi.registerTool({
		name: "llm_council",
		label: "LLM Council",
		description: [
			"Convene an LLM Council to answer a hard question.",
			"Multiple LLMs work independently (with tools if needed),",
			"optionally review each other's work anonymously,",
			"then a chairman synthesizes the final answer.",
			`Templates: ${builtinTemplateNames.join(", ")}. Custom templates in ~/.pi/agent/council-templates/.`,
		].join(" "),
		promptSnippet: "Convene multiple LLMs with a template (ask, review, explore, or custom)",
		promptGuidelines: [
			"Use llm_council for questions that benefit from multiple expert perspectives, complex analysis, or when accuracy is critical.",
			"Do NOT use llm_council for simple factual questions or routine tasks.",
			"Use template 'review' for code review, 'explore' for codebase exploration, 'ask' for general questions.",
		],
		parameters: Type.Object({
			question: Type.String({ description: "The question or task to pose to the council" }),
			template: Type.Optional(
				Type.String({
					description:
						"Template name: 'ask' (Q&A, default), 'review' (code review), 'explore' (codebase exploration), or custom template name",
				}),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const config = loadConfig();
			const allTemplates = getAllTemplates();
			const templateName = params.template || "ask";
			const baseTemplate = allTemplates[templateName];

			if (!baseTemplate) {
				const available = Object.keys(allTemplates).join(", ");
				return {
					content: [{ type: "text", text: `Unknown template "${templateName}". Available: ${available}` }],
					details: { stage: "complete", template: templateName, query: params.question, stage1: [], stage2: [] },
				};
			}

			const template = applyOverrides(baseTemplate, config.templates?.[templateName]);
			return runCouncil(template, params.question, config, ctx.cwd, signal, onUpdate);
		},

		renderCall(args, theme) {
			const config = loadConfig();
			const templateName = args.template || "ask";
			const preview =
				args.question?.length > 70 ? `${args.question.slice(0, 70)}...` : args.question || "...";
			let text = theme.fg("toolTitle", theme.bold("llm_council "));
			text += theme.fg("warning", templateName);
			text += theme.fg("muted", ` ${config.members.length} members`);
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as CouncilDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();
			const templateLabel = theme.fg("warning", details.template || "ask");

			// Still running
			if (details.stage !== "complete") {
				const doneS1 = details.stage1.filter((r) => r.exitCode !== -1).length;
				const totalS1 = details.stage1.length;
				const doneS2 = details.stage2.filter((r) => r.exitCode !== -1).length;
				const totalS2 = details.stage2.length;

				const stageNames: Record<string, string> = {
					stage1: `Stage 1: Working (${doneS1}/${totalS1})`,
					stage2: `Stage 2: Peer review (${doneS2}/${totalS2})`,
					stage3: "Stage 3: Chairman synthesis",
				};
				const stageName = stageNames[details.stage] || details.stage;
				let text =
					theme.fg("warning", "⏳ ") +
					theme.fg("toolTitle", theme.bold("LLM Council ")) +
					templateLabel +
					theme.fg("muted", ` — ${stageName}`);

				// Show Stage 1 members
				if (details.stage1.length > 0) {
					text += `\n${theme.fg("muted", "─── Members ───")}`;
					for (const r of details.stage1) {
						const icon =
							r.exitCode === 0
								? theme.fg("success", "✓")
								: r.exitCode === -1
									? theme.fg("warning", "⏳")
									: theme.fg("error", "✗");
						let line = `\n${icon} ${theme.fg("accent", r.model)}`;
						if (r.exitCode === -1) {
							line += theme.fg("dim", " running...");
						} else if (r.exitCode === 0 && r.response) {
							const preview = r.response.split("\n")[0].slice(0, 50);
							line += theme.fg("dim", ` ${preview}...`);
							if (r.usage) line += theme.fg("dim", ` (${formatUsage(r.usage)})`);
						} else if (r.error) {
							line += theme.fg("error", ` error`);
						}
						text += line;
					}
				}

				// Show Stage 2 members if in stage 2
				if (details.stage === "stage2" && details.stage2.length > 0) {
					text += `\n${theme.fg("muted", "─── Reviewers ───")}`;
					for (const r of details.stage2) {
						const icon =
							r.exitCode === 0
								? theme.fg("success", "✓")
								: r.exitCode === -1
									? theme.fg("warning", "⏳")
									: theme.fg("error", "✗");
						let line = `\n${icon} ${theme.fg("accent", r.model)}`;
						if (r.exitCode === -1) {
							line += theme.fg("dim", " reviewing...");
						} else if (r.parsedRanking.length > 0) {
							line += theme.fg("dim", ` ${r.parsedRanking.join(" > ")}`);
						}
						text += line;
					}
				}

				// Show Stage 3 with actual chairman model from config
				if (details.stage === "stage3") {
					const config = loadConfig();
					text += `\n${theme.fg("muted", "─── Chairman ───")}`;
					text += `\n${theme.fg("warning", "⏳")} ${theme.fg("accent", config.chairman)} ${theme.fg("dim", "synthesizing...")}`;
				}

				return new Text(text, 0, 0);
			}

			// ── Complete: expanded ──────────────────────────────────────

			if (expanded) {
				const container = new Container();

				container.addChild(
					new Text(
						theme.fg("success", "✓ ") +
							theme.fg("toolTitle", theme.bold("LLM Council ")) +
							templateLabel +
							theme.fg("muted", " — Complete"),
						0,
						0,
					),
				);

				// Stage 1
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("muted", "─── Stage 1: Individual Work ───"), 0, 0));
				for (const r of details.stage1) {
					const icon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
					container.addChild(new Spacer(1));
					container.addChild(new Text(`${icon} ${theme.fg("accent", theme.bold(r.model))}`, 0, 0));
					if (r.error) {
						container.addChild(new Text(theme.fg("error", `Error: ${r.error}`), 0, 0));
					} else if (r.response) {
						container.addChild(new Markdown(r.response.trim(), 0, 0, mdTheme));
					}
					if (r.usage)
						container.addChild(new Text(theme.fg("dim", formatUsage(r.usage, r.model)), 0, 0));
				}

				// Stage 2
				if (details.stage2.length > 0) {
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Stage 2: Peer Reviews ───"), 0, 0));
					if (details.labelMap) {
						const mapStr = Object.entries(details.labelMap)
							.map(([label, model]) => `${label}=${model}`)
							.join(", ");
						container.addChild(new Text(theme.fg("dim", `Identity map: ${mapStr}`), 0, 0));
					}
					for (const r of details.stage2) {
						const icon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
						container.addChild(new Spacer(1));
						container.addChild(
							new Text(`${icon} ${theme.fg("accent", theme.bold(r.model))}`, 0, 0),
						);
						if (r.parsedRanking.length > 0) {
							container.addChild(
								new Text(
									theme.fg("warning", `Ranking: ${r.parsedRanking.join(" > ")}`),
									0,
									0,
								),
							);
						}
						if (r.review) {
							container.addChild(new Markdown(r.review.trim(), 0, 0, mdTheme));
						}
						if (r.usage)
							container.addChild(
								new Text(theme.fg("dim", formatUsage(r.usage, r.model)), 0, 0),
							);
					}
				}

				// Stage 3
				container.addChild(new Spacer(1));
				container.addChild(
					new Text(theme.fg("muted", "─── Stage 3: Chairman's Final Answer ───"), 0, 0),
				);
				if (details.stage3) {
					container.addChild(
						new Text(theme.fg("accent", `Chairman: ${details.stage3.model}`), 0, 0),
					);
					container.addChild(new Spacer(1));
					if (details.stage3.response) {
						container.addChild(new Markdown(details.stage3.response.trim(), 0, 0, mdTheme));
					}
					if (details.stage3.usage) {
						container.addChild(
							new Text(
								theme.fg("dim", formatUsage(details.stage3.usage, details.stage3.model)),
								0,
								0,
							),
						);
					}
				}

				const totalUsage = aggregateUsage(details);
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("dim", `Total: ${formatUsage(totalUsage)}`), 0, 0));

				return container;
			}

			// ── Complete: collapsed ─────────────────────────────────────

			let text =
				theme.fg("success", "✓ ") +
				theme.fg("toolTitle", theme.bold("LLM Council ")) +
				templateLabel +
				theme.fg("muted", ` — ${details.stage1.length} members`);

			for (const r of details.stage1) {
				const icon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
				const preview = r.response
					? r.response.split("\n")[0].slice(0, 50) + "..."
					: "(no output)";
				text += `\n${icon} ${theme.fg("accent", r.model)} ${theme.fg("dim", preview)}`;
			}

			if (details.stage2.length > 0) {
				text += `\n\n${theme.fg("muted", "Rankings:")}`;
				for (const r of details.stage2) {
					if (r.parsedRanking.length > 0) {
						text += `\n${theme.fg("accent", r.model)}: ${theme.fg("dim", r.parsedRanking.join(" > "))}`;
					}
				}
			}

			if (details.stage3?.response) {
				text += `\n\n${theme.fg("muted", "Chairman (")}${theme.fg("accent", details.stage3.model)}${theme.fg("muted", "):")}`;
				const lines = details.stage3.response.split("\n").slice(0, 5);
				text += `\n${theme.fg("toolOutput", lines.join("\n"))}`;
				if (details.stage3.response.split("\n").length > 5) {
					text += `\n${theme.fg("muted", "... (Ctrl+O to expand)")}`;
				}
			}

			const totalUsage = aggregateUsage(details);
			text += `\n\n${theme.fg("dim", `Total: ${formatUsage(totalUsage)}`)}`;

			return new Text(text, 0, 0);
		},
	});

	// ── /council command (with template selector) ───────────────────────

	pi.registerCommand("council", {
		description: "Run LLM Council with a template (ask, review, explore, ...)",
		handler: async (args, ctx) => {
			const allTemplates = getAllTemplates();
			const parts = args?.trim().split(/\s+/) || [];

			// Check if first word is a template name
			let templateName: string | undefined;
			let query: string;

			if (parts.length > 0 && allTemplates[parts[0]]) {
				templateName = parts[0];
				query = parts.slice(1).join(" ");
			} else {
				query = args?.trim() || "";
			}

			// If no template specified, show selector
			if (!templateName) {
				const items: SelectItem[] = Object.values(allTemplates).map((t) => ({
					value: t.name,
					label: t.name,
					description: t.description,
				}));

				templateName = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
					const container = new Container();
					container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
					container.addChild(
						new Text(theme.fg("accent", theme.bold(" LLM Council — Select Template")), 0, 0),
					);
					container.addChild(new Spacer(1));

					const selectList = new SelectList(items, Math.min(items.length, 10), {
						selectedPrefix: (t: string) => theme.fg("accent", t),
						selectedText: (t: string) => theme.fg("accent", t),
						description: (t: string) => theme.fg("muted", t),
						scrollInfo: (t: string) => theme.fg("dim", t),
						noMatch: (t: string) => theme.fg("warning", t),
					});
					selectList.onSelect = (item: SelectItem) => done(item.value);
					selectList.onCancel = () => done(null);
					container.addChild(selectList);

					container.addChild(new Spacer(1));
					container.addChild(
						new Text(theme.fg("dim", " ↑↓ navigate • enter select • esc cancel"), 0, 0),
					);
					container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

					return {
						render: (w: number) => container.render(w),
						invalidate: () => container.invalidate(),
						handleInput: (data: string) => {
							selectList.handleInput(data);
							tui.requestRender();
						},
					};
				});

				if (!templateName) {
					ctx.ui.notify("Council cancelled.", "info");
					return;
				}
			}

			// If no query, prompt for it
			if (!query) {
				const input = await ctx.ui.input(`[${templateName}] Enter your question or task:`, "");
				if (!input?.trim()) {
					ctx.ui.notify("Council cancelled.", "info");
					return;
				}
				query = input.trim();
			}

			pi.sendUserMessage(
				`Use the llm_council tool with template "${templateName}" to handle this: ${query}`,
			);
		},
	});

	// ── /council-config command ──────────────────────────────────────────

	pi.registerCommand("council-config", {
		description: "Configure LLM Council: members, chairman, and template settings",
		handler: async (_args, ctx) => {
			const config = loadConfig();

			// Top-level menu: what to configure?
			const topChoice = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
				const items: SelectItem[] = [
					{ value: "members", label: "Members & Chairman", description: `Currently: ${config.members.length} members, chairman: ${config.chairman.split("/").pop()}` },
					{ value: "templates", label: "Template Settings", description: "Configure review, tools, etc. per template" },
				];
				const container = new Container();
				container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
				container.addChild(new Text(theme.fg("accent", theme.bold(" LLM Council — Configuration")), 0, 0));
				container.addChild(new Spacer(1));
				const selectList = new SelectList(items, 5, {
					selectedPrefix: (t: string) => theme.fg("accent", t),
					selectedText: (t: string) => theme.fg("accent", t),
					description: (t: string) => theme.fg("muted", t),
					scrollInfo: (t: string) => theme.fg("dim", t),
					noMatch: (t: string) => theme.fg("warning", t),
				});
				selectList.onSelect = (item: SelectItem) => done(item.value);
				selectList.onCancel = () => done(null);
				container.addChild(selectList);
				container.addChild(new Spacer(1));
				container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
				return {
					render: (w: number) => container.render(w),
					invalidate: () => container.invalidate(),
					handleInput: (data: string) => { selectList.handleInput(data); tui.requestRender(); },
				};
			});

			if (!topChoice) { ctx.ui.notify("Cancelled.", "info"); return; }

			if (topChoice === "members") {
				await configureMembers(ctx, config);
			} else {
				await configureTemplates(ctx, config);
			}
		},
	});

	// ── Members & Chairman config ───────────────────────────────────────

	async function configureMembers(ctx: any, config: CouncilConfig) {
		const available = await ctx.modelRegistry.getAvailable();
		if (available.length === 0) {
			ctx.ui.notify("No models available. Check your API keys.", "error");
			return;
		}

		const memberSet = new Set<string>();
		const memberItems: SettingItem[] = available.map((m: any) => ({
			id: `${m.provider}/${m.id}`,
			label: `${m.provider}/${m.name || m.id}`,
			currentValue: "off",
			values: ["member", "off"],
		}));

		const membersResult = await ctx.ui.custom<string[] | null>((tui: any, theme: any, _kb: any, done: any) => {
			const container = new Container();
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			container.addChild(new Text(theme.fg("accent", theme.bold(" Select Members")), 0, 0));
			container.addChild(new Text(theme.fg("dim", " tab toggle • ↑↓ navigate • enter confirm • esc cancel"), 0, 0));
			container.addChild(new Spacer(1));
			const settingsList = new SettingsList(
				memberItems, Math.min(memberItems.length + 2, 20), getSettingsListTheme(),
				(id: string, newValue: string) => { if (newValue === "member") memberSet.add(id); else memberSet.delete(id); },
				() => done(null),
			);
			container.addChild(settingsList);
			container.addChild(new Spacer(1));
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			return {
				render: (w: number) => container.render(w),
				invalidate: () => container.invalidate(),
				handleInput: (data: string) => {
					if (data === "\r" || data === "\n") { done(Array.from(memberSet).length > 0 ? Array.from(memberSet) : null); return; }
					if (data === "\t") { settingsList.handleInput("\r"); tui.requestRender(); return; }
					settingsList.handleInput(data); tui.requestRender();
				},
			};
		});

		if (!membersResult || membersResult.length < 2) {
			ctx.ui.notify(membersResult ? "Need at least 2 members." : "Cancelled.", membersResult ? "warning" : "info");
			return;
		}

		const chairmanItems: SelectItem[] = membersResult.map((m: string) => ({
			value: m, label: m,
			description: m === config.chairman ? "(current chairman)" : undefined,
		}));

		const chairmanResult = await ctx.ui.custom<string | null>((tui: any, theme: any, _kb: any, done: any) => {
			const container = new Container();
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			container.addChild(new Text(theme.fg("accent", theme.bold(" Select Chairman")), 0, 0));
			container.addChild(new Text(theme.fg("dim", " The chairman synthesizes the final answer."), 0, 0));
			container.addChild(new Spacer(1));
			const selectList = new SelectList(chairmanItems, Math.min(chairmanItems.length, 10), {
				selectedPrefix: (t: string) => theme.fg("accent", t),
				selectedText: (t: string) => theme.fg("accent", t),
				description: (t: string) => theme.fg("muted", t),
				scrollInfo: (t: string) => theme.fg("dim", t),
				noMatch: (t: string) => theme.fg("warning", t),
			});
			selectList.onSelect = (item: SelectItem) => done(item.value);
			selectList.onCancel = () => done(null);
			container.addChild(selectList);
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("dim", " ↑↓ navigate • enter select • esc cancel"), 0, 0));
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			return {
				render: (w: number) => container.render(w),
				invalidate: () => container.invalidate(),
				handleInput: (data: string) => { selectList.handleInput(data); tui.requestRender(); },
			};
		});

		if (!chairmanResult) { ctx.ui.notify("Cancelled.", "info"); return; }

		const newConfig: CouncilConfig = { ...config, members: membersResult, chairman: chairmanResult };
		saveConfig(newConfig);
		ctx.ui.notify(`Members: ${newConfig.members.join(", ")}\nChairman: ${newConfig.chairman}`, "success");
	}

	// ── Template config ─────────────────────────────────────────────────

	async function configureTemplates(ctx: any, config: CouncilConfig) {
		const allTemplates = getAllTemplates();
		const templateNames = Object.keys(allTemplates);

		// Step 1: Pick which template to configure
		const templateItems: SelectItem[] = templateNames.map((name) => {
			const t = allTemplates[name];
			const override = config.templates?.[name];
			const reviewStatus = (override?.review ?? t.review) ? "review:on" : "review:off";
			const toolsVal = override?.tools !== undefined ? (override.tools === null ? "none" : override.tools) : (t.tools || "none");
			return {
				value: name,
				label: name,
				description: `${t.description} [${reviewStatus}, tools:${toolsVal}]`,
			};
		});

		const selectedTemplate = await ctx.ui.custom<string | null>((tui: any, theme: any, _kb: any, done: any) => {
			const container = new Container();
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			container.addChild(new Text(theme.fg("accent", theme.bold(" Select Template to Configure")), 0, 0));
			container.addChild(new Spacer(1));
			const selectList = new SelectList(templateItems, Math.min(templateItems.length, 10), {
				selectedPrefix: (t: string) => theme.fg("accent", t),
				selectedText: (t: string) => theme.fg("accent", t),
				description: (t: string) => theme.fg("muted", t),
				scrollInfo: (t: string) => theme.fg("dim", t),
				noMatch: (t: string) => theme.fg("warning", t),
			});
			selectList.onSelect = (item: SelectItem) => done(item.value);
			selectList.onCancel = () => done(null);
			container.addChild(selectList);
			container.addChild(new Spacer(1));
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			return {
				render: (w: number) => container.render(w),
				invalidate: () => container.invalidate(),
				handleInput: (data: string) => { selectList.handleInput(data); tui.requestRender(); },
			};
		});

		if (!selectedTemplate) { ctx.ui.notify("Cancelled.", "info"); return; }

		// Step 2: Edit template settings — each tool is a separate toggle, like /tools
		const t = allTemplates[selectedTemplate];
		const existing = config.templates?.[selectedTemplate] || {};
		const currentReview = existing.review ?? t.review;

		// Resolve effective tools list
		const effectiveToolsStr = existing.tools !== undefined
			? (existing.tools === null ? "" : existing.tools)
			: (t.tools || "");
		const enabledToolSet = new Set(effectiveToolsStr.split(",").map((s: string) => s.trim()).filter(Boolean));

		// Get all registered tools from pi
		const allRegisteredTools = pi.getAllTools();
		const allToolNames = allRegisteredTools.map((tool: any) => tool.name);

		// Build settings: review toggle + one row per tool
		const settingItems: SettingItem[] = [
			{
				id: "__review__",
				label: "Peer Review (Stage 2)",
				currentValue: currentReview ? "on" : "off",
				values: ["on", "off"],
			},
			...allToolNames.map((name: string) => ({
				id: name,
				label: name,
				currentValue: enabledToolSet.has(name) ? "enabled" : "disabled",
				values: ["enabled", "disabled"],
			})),
		];

		const newOverride: TemplateOverride = { review: currentReview, tools: existing.tools };

		function saveCurrentState() {
			// Collect enabled tools from the set
			const toolsList = allToolNames.filter((name: string) => enabledToolSet.has(name));
			newOverride.tools = toolsList.length > 0 ? toolsList.join(",") : null;
			const newConfig = { ...config, templates: { ...(config.templates || {}), [selectedTemplate!]: { ...newOverride } } };
			saveConfig(newConfig);
		}

		await ctx.ui.custom((tui: any, theme: any, _kb: any, done: any) => {
			const container = new Container();
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			container.addChild(new Text(theme.fg("accent", theme.bold(` Template: ${selectedTemplate}`)), 0, 0));
			container.addChild(new Text(theme.fg("dim", ` ${t.description}`), 0, 0));
			container.addChild(new Spacer(1));

			const settingsList = new SettingsList(
				settingItems,
				Math.min(settingItems.length + 2, 15),
				getSettingsListTheme(),
				(id: string, newValue: string) => {
					if (id === "__review__") {
						newOverride.review = newValue === "on";
					} else {
						if (newValue === "enabled") enabledToolSet.add(id);
						else enabledToolSet.delete(id);
					}
					saveCurrentState();
				},
				() => done(undefined),
			);
			container.addChild(settingsList);
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("dim", " Enter/Space to change • Esc to close"), 0, 0));
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

			return {
				render: (w: number) => container.render(w),
				invalidate: () => container.invalidate(),
				handleInput: (data: string) => {
					settingsList.handleInput?.(data);
					tui.requestRender();
				},
			};
		});

		const toolsList = allToolNames.filter((name: string) => enabledToolSet.has(name));
		const reviewLabel = newOverride.review ? "on" : "off";
		ctx.ui.notify(`Template "${selectedTemplate}": review=${reviewLabel}, tools=${toolsList.join(",") || "none"}`, "success");
	}
}
