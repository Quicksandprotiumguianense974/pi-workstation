/**
 * Knowledge Graph Extension
 *
 * Extracts entities and relationships from URLs (via r.jina.ai),
 * stores them as a local knowledge graph, and indexes with qmd for search.
 *
 * Commands: /kg
 * Tool: knowledge_graph (for LLM to add/search/explore)
 */

import { StringEnum, complete, type Message } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { BorderedLoader, getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth, matchesKey, Key, wrapTextWithAnsi, Markdown } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from "node:fs";
import { join } from "node:path";

// ════════════════════════════════════════════════════════════════════
// Data Model
// ════════════════════════════════════════════════════════════════════

const KG_DIR = join(process.env.HOME || "~", ".pi", "agent", "knowledge");
const GRAPH_PATH = join(KG_DIR, "graph.json");
const NODES_DIR = join(KG_DIR, "nodes");
const SOURCES_DIR = join(KG_DIR, "sources");

interface KGNode {
	id: string;
	name: string;
	type: string;
	description: string;
	sources: string[];
	createdAt: number;
	updatedAt: number;
}

interface KGEdge {
	id: string;
	from: string; // node id
	to: string; // node id
	quote: string;
	source: string; // URL
	createdAt: number;
}

interface KGGraph {
	version: 1;
	nodes: KGNode[];
	edges: KGEdge[];
	nextEdgeId: number;
}

// ════════════════════════════════════════════════════════════════════
// Storage helpers
// ════════════════════════════════════════════════════════════════════

function slugify(name: string): string {
	return (
		name
			.toLowerCase()
			.replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
			.replace(/^-+|-+$/g, "") || "unnamed"
	);
}

function ensureDirs(): void {
	mkdirSync(NODES_DIR, { recursive: true });
	mkdirSync(SOURCES_DIR, { recursive: true });
}

function createEmptyGraph(): KGGraph {
	return { version: 1, nodes: [], edges: [], nextEdgeId: 1 };
}

// ── In-memory cache to avoid repeated disk reads ──
let _cachedGraph: KGGraph | null = null;
let _cacheTime = 0;

function loadGraph(): KGGraph {
	ensureDirs();
	if (!existsSync(GRAPH_PATH)) return createEmptyGraph();
	// Use cached version if file hasn't changed
	try {
		const stat = require("node:fs").statSync(GRAPH_PATH);
		const mtime = stat.mtimeMs;
		if (_cachedGraph && mtime <= _cacheTime) return _cachedGraph;
		const graph = JSON.parse(readFileSync(GRAPH_PATH, "utf8"));
		_cachedGraph = graph;
		_cacheTime = mtime;
		return graph;
	} catch {
		return createEmptyGraph();
	}
}

function saveGraph(graph: KGGraph): void {
	ensureDirs();
	writeFileSync(GRAPH_PATH, JSON.stringify(graph, null, 2) + "\n", "utf8");
	// Update cache
	_cachedGraph = graph;
	_cacheTime = Date.now();
}

function writeNodeMd(node: KGNode, graph: KGGraph): void {
	ensureDirs();
	const relatedEdges = graph.edges.filter((e) => e.from === node.id || e.to === node.id);

	let md = `# ${node.name}\n`;
	md += `Type: ${node.type}\n`;
	md += `Sources: ${node.sources.join(", ")}\n\n`;
	md += `${node.description}\n`;

	if (relatedEdges.length > 0) {
		md += `\n## Relations\n`;
		for (const edge of relatedEdges) {
			if (edge.from === node.id) {
				const target = graph.nodes.find((n) => n.id === edge.to);
				md += `- → ${target?.name || edge.to}: "${edge.quote}"\n`;
			} else {
				const src = graph.nodes.find((n) => n.id === edge.from);
				md += `- ← ${src?.name || edge.from}: "${edge.quote}"\n`;
			}
		}
	}

	writeFileSync(join(NODES_DIR, `${node.id}.md`), md, "utf8");
}

function regenerateAllMd(graph: KGGraph): void {
	for (const node of graph.nodes) {
		writeNodeMd(node, graph);
	}
}

/** Regenerate md only for nodes affected by a set of node IDs (+ their edge neighbors) */
function regenerateAffectedMd(graph: KGGraph, affectedIds: Set<string>): void {
	// Also include neighbors connected by edges
	const toRegen = new Set(affectedIds);
	for (const edge of graph.edges) {
		if (affectedIds.has(edge.from)) toRegen.add(edge.to);
		if (affectedIds.has(edge.to)) toRegen.add(edge.from);
	}
	for (const id of toRegen) {
		const node = graph.nodes.find((n) => n.id === id);
		if (node) writeNodeMd(node, graph);
	}
}

function deleteNodeMd(nodeId: string): void {
	const p = join(NODES_DIR, `${nodeId}.md`);
	if (existsSync(p)) unlinkSync(p);
}

// ════════════════════════════════════════════════════════════════════
// Graph operations
// ════════════════════════════════════════════════════════════════════

function findNode(graph: KGGraph, name: string): KGNode | undefined {
	const slug = slugify(name);
	return graph.nodes.find((n) => n.id === slug) || graph.nodes.find((n) => n.name.toLowerCase() === name.toLowerCase());
}

function addOrMergeNode(graph: KGGraph, name: string, type: string, description: string, source: string): KGNode {
	const id = slugify(name);
	const existing = graph.nodes.find((n) => n.id === id);

	if (existing) {
		if (!existing.sources.includes(source)) existing.sources.push(source);
		// Keep the longer/better description
		if (description && description.length > existing.description.length) {
			existing.description = description;
		}
		existing.updatedAt = Date.now();
		return existing;
	}

	const node: KGNode = {
		id,
		name,
		type,
		description,
		sources: [source],
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};
	graph.nodes.push(node);
	return node;
}

function addEdge(graph: KGGraph, fromName: string, toName: string, quote: string, source: string): KGEdge | null {
	const fromId = slugify(fromName);
	const toId = slugify(toName);

	// Dedup: same from/to/quote
	const dup = graph.edges.find((e) => e.from === fromId && e.to === toId && e.quote === quote);
	if (dup) return null;

	const edge: KGEdge = {
		id: `E-${graph.nextEdgeId}`,
		from: fromId,
		to: toId,
		quote,
		source,
		createdAt: Date.now(),
	};
	graph.nextEdgeId++;
	graph.edges.push(edge);
	return edge;
}

function removeNode(graph: KGGraph, name: string): { node: KGNode; neighborIds: Set<string> } | null {
	const node = findNode(graph, name);
	if (!node) return null;

	// Collect neighbor IDs before removing edges
	const neighborIds = new Set<string>();
	for (const e of graph.edges) {
		if (e.from === node.id) neighborIds.add(e.to);
		if (e.to === node.id) neighborIds.add(e.from);
	}

	// Remove edges referencing this node
	graph.edges = graph.edges.filter((e) => e.from !== node.id && e.to !== node.id);
	graph.nodes = graph.nodes.filter((n) => n.id !== node.id);
	deleteNodeMd(node.id);
	return { node, neighborIds };
}

function getNodeEdges(graph: KGGraph, nodeId: string): { outgoing: KGEdge[]; incoming: KGEdge[] } {
	return {
		outgoing: graph.edges.filter((e) => e.from === nodeId),
		incoming: graph.edges.filter((e) => e.to === nodeId),
	};
}

// ════════════════════════════════════════════════════════════════════
// Jina fetch
// ════════════════════════════════════════════════════════════════════

const MAX_CONTENT_CHARS = 20000;

async function fetchJina(url: string): Promise<string> {
	const resp = await fetch(`https://r.jina.ai/${url}`, {
		headers: { Accept: "text/markdown" },
	});
	if (!resp.ok) throw new Error(`Jina fetch failed: ${resp.status} ${resp.statusText}`);
	let content = await resp.text();

	// Cache source
	ensureDirs();
	const slug = slugify(url.replace(/^https?:\/\//, ""));
	writeFileSync(join(SOURCES_DIR, `${slug}.md`), content, "utf8");

	// Truncate for LLM
	if (content.length > MAX_CONTENT_CHARS) {
		content = content.slice(0, MAX_CONTENT_CHARS) + "\n\n[... truncated]";
	}
	return content;
}

// ════════════════════════════════════════════════════════════════════
// qmd integration (optional)
// ════════════════════════════════════════════════════════════════════

let qmdChecked = false;
let qmdInstalled = false;
let qmdCollectionReady = false;
let embedPending = false;

async function checkQmd(pi: ExtensionAPI): Promise<boolean> {
	if (qmdChecked) return qmdInstalled;
	try {
		const result = await pi.exec("which", ["qmd"], { timeout: 3000 });
		qmdInstalled = result.code === 0;
	} catch {
		qmdInstalled = false;
	}
	qmdChecked = true;
	return qmdInstalled;
}

async function ensureQmdCollection(pi: ExtensionAPI): Promise<void> {
	if (qmdCollectionReady) return;
	if (!(await checkQmd(pi))) return;

	try {
		const result = await pi.exec("qmd", ["status"], { timeout: 5000 });
		if (result.stdout.includes("knowledge")) {
			qmdCollectionReady = true;
			return;
		}
	} catch {}

	try {
		await pi.exec("qmd", ["collection", "add", NODES_DIR, "--name", "knowledge"], { timeout: 10000 });
		await pi.exec(
			"qmd",
			["context", "add", "qmd://knowledge", "Personal knowledge graph: entities, relationships, and source quotes"],
			{ timeout: 5000 },
		);
		qmdCollectionReady = true;
	} catch {}
}

async function qmdEmbed(pi: ExtensionAPI): Promise<void> {
	if (embedPending) return;
	if (!(await checkQmd(pi))) return;
	await ensureQmdCollection(pi);

	embedPending = true;
	try {
		await pi.exec("qmd", ["embed"], { timeout: 120000 });
	} catch {
		// Silently fail — search will still work with fallback
	} finally {
		embedPending = false;
	}
}

async function qmdSearch(pi: ExtensionAPI, query: string): Promise<string[]> {
	if (!(await checkQmd(pi))) return fallbackSearch(query);
	await ensureQmdCollection(pi);

	try {
		const result = await pi.exec("qmd", ["search", query, "--json", "-n", "10", "-c", "knowledge"], {
			timeout: 15000,
		});
		if (result.code !== 0) return fallbackSearch(query);

		const parsed = JSON.parse(result.stdout);
		// Extract node IDs from filenames
		const ids: string[] = [];
		for (const hit of parsed) {
			const path = hit.path || hit.document?.path || "";
			const match = path.match(/([^/]+)\.md$/);
			if (match) ids.push(match[1]);
		}
		return ids;
	} catch {
		return fallbackSearch(query);
	}
}

function fallbackSearch(query: string): string[] {
	const graph = loadGraph();
	const q = query.toLowerCase();
	return graph.nodes
		.filter(
			(n) =>
				n.name.toLowerCase().includes(q) ||
				n.description.toLowerCase().includes(q) ||
				n.type.toLowerCase().includes(q),
		)
		.map((n) => n.id);
}

// ════════════════════════════════════════════════════════════════════
// Formatting
// ════════════════════════════════════════════════════════════════════

function formatNodeShort(node: KGNode): string {
	return `${node.name} [${node.type}] — ${node.description}`;
}

function formatNodeDetail(node: KGNode, graph: KGGraph): string {
	const lines: string[] = [];
	lines.push(`# ${node.name}`);
	lines.push(`Type: ${node.type}`);
	lines.push(`Description: ${node.description}`);
	lines.push(`Sources: ${node.sources.join(", ")}`);

	const { outgoing, incoming } = getNodeEdges(graph, node.id);
	if (outgoing.length > 0 || incoming.length > 0) {
		lines.push("");
		lines.push("Relations:");
		for (const e of outgoing) {
			const target = graph.nodes.find((n) => n.id === e.to);
			lines.push(`  → ${target?.name || e.to}: "${e.quote}"`);
		}
		for (const e of incoming) {
			const src = graph.nodes.find((n) => n.id === e.from);
			lines.push(`  ← ${src?.name || e.from}: "${e.quote}"`);
		}
	}
	return lines.join("\n");
}

function formatGraphSummary(graph: KGGraph): string {
	if (graph.nodes.length === 0) return "Knowledge graph is empty.";

	// Group by type
	const groups = new Map<string, KGNode[]>();
	for (const node of graph.nodes) {
		const list = groups.get(node.type) || [];
		list.push(node);
		groups.set(node.type, list);
	}

	const lines: string[] = [];
	lines.push(`Knowledge Graph: ${graph.nodes.length} entities, ${graph.edges.length} relationships\n`);
	for (const [type, nodes] of [...groups.entries()].sort()) {
		lines.push(`[${type}] (${nodes.length})`);
		for (const n of nodes) {
			const edgeCount = graph.edges.filter((e) => e.from === n.id || e.to === n.id).length;
			lines.push(`  ${n.name} — ${n.description} (${edgeCount} relations)`);
		}
	}
	return lines.join("\n");
}

// ════════════════════════════════════════════════════════════════════
// Extension
// ════════════════════════════════════════════════════════════════════

const KGToolParams = Type.Object({
	action: StringEnum(["add", "search", "get", "list", "explore", "delete"] as const),
	source: Type.Optional(Type.String({ description: "Source URL for the extracted knowledge" })),
	nodes: Type.Optional(
		Type.Array(
			Type.Object({
				name: Type.String({ description: "Entity name (canonical form, e.g. 'JavaScript' not 'JS')" }),
				type: Type.String({ description: "Entity type: person, company, product, concept, technology, language, framework, protocol, etc." }),
				description: Type.String({ description: "One-line description of the entity" }),
			}),
			{ description: "Entities to add (for action=add)" },
		),
	),
	edges: Type.Optional(
		Type.Array(
			Type.Object({
				from: Type.String({ description: "Source entity name (must match a node name)" }),
				to: Type.String({ description: "Target entity name (must match a node name)" }),
				quote: Type.String({ description: "Verbatim quote from the source text describing the relationship" }),
			}),
			{ description: "Relationships between entities (for action=add)" },
		),
	),
	query: Type.Optional(Type.String({ description: "Search query (for action=search)" })),
	name: Type.Optional(Type.String({ description: "Entity name (for action=get/explore/delete)" })),
});

export default function knowledgeGraphExtension(pi: ExtensionAPI) {
	function refreshStatus(ctx: ExtensionContext): void {
		const graph = loadGraph();
		const n = graph.nodes.length;
		const e = graph.edges.length;
		if (n === 0) {
			ctx.ui.setStatus("knowledge-graph", ctx.ui.theme.fg("dim", "🧠 0"));
		} else {
			ctx.ui.setStatus("knowledge-graph", `🧠 ${ctx.ui.theme.fg("muted", `${n}n ${e}e`)}`);
		}
	}

	// ── Tool ──

	pi.registerTool({
		name: "knowledge_graph",
		label: "Knowledge Graph",
		description:
			"Manage a personal knowledge graph of entities (people, companies, products, concepts) and their relationships. Actions: add (save extracted entities+relationships), search, get, list, explore, delete.",
		promptSnippet: "Manage personal knowledge graph: extract entities & relationships from content, search, explore connections",
		promptGuidelines: [
			"For URLs, use /kg <url> which auto-extracts via a subagent. The knowledge_graph tool is for manual add/search/explore/delete.",
			"When manually adding: be selective, focus on core entities. Always 'list' first and REUSE existing entities.",
			"Relationship quotes must be verbatim excerpts from the source text, not paraphrased.",
		],
		parameters: KGToolParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				switch (params.action) {
					case "add": {
						if (!params.nodes || params.nodes.length === 0) {
							return { content: [{ type: "text", text: "Error: nodes array is required for add" }] };
						}
						const source = params.source || "manual";
						const graph = loadGraph();

						const addedNodes: string[] = [];
						const affectedIds = new Set<string>();
						for (const n of params.nodes) {
							const node = addOrMergeNode(graph, n.name, n.type, n.description, source);
							addedNodes.push(node.name);
							affectedIds.add(node.id);
						}

						const addedEdges: string[] = [];
						if (params.edges) {
							for (const e of params.edges) {
								const edge = addEdge(graph, e.from, e.to, e.quote, source);
								if (edge) {
									addedEdges.push(`${e.from} → ${e.to}`);
									affectedIds.add(edge.from);
									affectedIds.add(edge.to);
								}
							}
						}

						saveGraph(graph);
						regenerateAffectedMd(graph, affectedIds);
						refreshStatus(ctx);

						// Trigger qmd embed in background
						qmdEmbed(pi).catch(() => {});

						const summary = [
							`Added ${addedNodes.length} entities: ${addedNodes.join(", ")}`,
							`Added ${addedEdges.length} relationships`,
							`Graph total: ${graph.nodes.length} entities, ${graph.edges.length} relationships`,
						].join("\n");

						return {
							content: [{ type: "text", text: summary }],
							details: {
								action: "add",
								addedNodes,
								addedEdges,
								totalNodes: graph.nodes.length,
								totalEdges: graph.edges.length,
							},
						};
					}

					case "search": {
						if (!params.query) {
							return { content: [{ type: "text", text: "Error: query is required for search" }] };
						}
						const nodeIds = await qmdSearch(pi, params.query);
						const graph = loadGraph();
						const results = nodeIds
							.map((id) => graph.nodes.find((n) => n.id === id))
							.filter(Boolean) as KGNode[];

						if (results.length === 0) {
							return { content: [{ type: "text", text: `No results for "${params.query}"` }] };
						}

						const text = results.map((n) => formatNodeShort(n)).join("\n");
						return {
							content: [{ type: "text", text: `Found ${results.length} entities:\n${text}` }],
							details: { action: "search", query: params.query, results: results.map((n) => n.name) },
						};
					}

					case "get": {
						if (!params.name) {
							return { content: [{ type: "text", text: "Error: name is required for get" }] };
						}
						const graph = loadGraph();
						const node = findNode(graph, params.name);
						if (!node) {
							return { content: [{ type: "text", text: `Entity not found: ${params.name}` }] };
						}
						return {
							content: [{ type: "text", text: formatNodeDetail(node, graph) }],
							details: { action: "get", node: node.name },
						};
					}

					case "list": {
						const graph = loadGraph();
						return {
							content: [{ type: "text", text: formatGraphSummary(graph) }],
							details: { action: "list", totalNodes: graph.nodes.length, totalEdges: graph.edges.length },
						};
					}

					case "explore": {
						if (!params.name) {
							return { content: [{ type: "text", text: "Error: name is required for explore" }] };
						}
						const graph = loadGraph();
						const node = findNode(graph, params.name);
						if (!node) {
							return { content: [{ type: "text", text: `Entity not found: ${params.name}` }] };
						}

						const { outgoing, incoming } = getNodeEdges(graph, node.id);
						const lines: string[] = [formatNodeDetail(node, graph), ""];

						// Show connected nodes' details too
						const connectedIds = new Set<string>();
						for (const e of outgoing) connectedIds.add(e.to);
						for (const e of incoming) connectedIds.add(e.from);

						if (connectedIds.size > 0) {
							lines.push("Connected entities:");
							for (const cid of connectedIds) {
								const cn = graph.nodes.find((n) => n.id === cid);
								if (cn) lines.push(`  ${formatNodeShort(cn)}`);
							}
						}

						return {
							content: [{ type: "text", text: lines.join("\n") }],
							details: { action: "explore", node: node.name, connections: connectedIds.size },
						};
					}

					case "delete": {
						if (!params.name) {
							return { content: [{ type: "text", text: "Error: name is required for delete" }] };
						}
						const graph = loadGraph();
						const result = removeNode(graph, params.name);
						if (!result) {
							return { content: [{ type: "text", text: `Entity not found: ${params.name}` }] };
						}
						saveGraph(graph);
						regenerateAffectedMd(graph, result.neighborIds);
						refreshStatus(ctx);
						qmdEmbed(pi).catch(() => {});

						return {
							content: [{ type: "text", text: `Deleted entity: ${result.node.name}` }],
							details: { action: "delete", node: result.node.name, totalNodes: graph.nodes.length },
						};
					}
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { content: [{ type: "text", text: `Error: ${message}` }] };
			}

			return { content: [{ type: "text", text: "Unknown action" }] };
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("knowledge_graph "));
			text += theme.fg("muted", String(args.action || ""));
			if (args.name) text += " " + theme.fg("accent", String(args.name));
			if (args.query) text += " " + theme.fg("dim", `"${args.query}"`);
			if (args.nodes) text += " " + theme.fg("dim", `${(args.nodes as any[]).length} entities`);
			if (args.edges) text += " " + theme.fg("dim", `${(args.edges as any[]).length} relations`);
			return { render: (w: number) => [truncateToWidth(text, w)], invalidate() {} };
		},

		renderResult(result, { expanded }, theme) {
			const d = result.details as Record<string, any> | undefined;

			if (d?.action === "add") {
				const lines: string[] = [];
				lines.push(
					theme.fg("success", "✓ ") +
						theme.fg("muted", `${d.addedNodes?.length || 0} entities, ${d.addedEdges?.length || 0} relations`),
				);
				if (expanded && d.addedNodes) {
					for (const name of d.addedNodes) {
						lines.push("  " + theme.fg("accent", name));
					}
				}
				lines.push(theme.fg("dim", `Graph: ${d.totalNodes}n ${d.totalEdges}e`));
				return { render: (w: number) => lines.map((l) => truncateToWidth(l, w)), invalidate() {} };
			}

			// For search/explore/get/list/delete — use Markdown rendering
			const text = result.content[0];
			const raw = text?.type === "text" ? text.text : "";
			const display = expanded ? raw : raw.split("\n").slice(0, 12).join("\n");
			const suffix = !expanded && raw.split("\n").length > 12 ? "\n\n..." : "";
			const md = new Markdown(display + suffix, 0, 0, getMarkdownTheme());
			return md;
		},
	});

	// ── /kg command ──

	pi.registerCommand("kg", {
		description: "Knowledge Graph — /kg <url> to add, /kg to browse, /kg search <query>",
		handler: async (args, ctx) => {
			const input = (args || "").trim();

			// /kg <url> — fetch and extract
			if (input.startsWith("http://") || input.startsWith("https://")) {
				await handleAddUrl(input, ctx);
				return;
			}

			// /kg search <query>
			if (input.startsWith("search ")) {
				const query = input.slice(7).trim();
				if (!query) {
					ctx.ui.notify("Usage: /kg search <query>", "warning");
					return;
				}
				await handleSearch(query, ctx);
				return;
			}

			// /kg delete <name>
			if (input.startsWith("delete ")) {
				const name = input.slice(7).trim();
				if (!name) {
					ctx.ui.notify("Usage: /kg delete <name>", "warning");
					return;
				}
				const graph = loadGraph();
				const result = removeNode(graph, name);
				if (!result) {
					ctx.ui.notify(`Entity not found: ${name}`, "error");
					return;
				}
				saveGraph(graph);
				regenerateAffectedMd(graph, result.neighborIds);
				refreshStatus(ctx);
				ctx.ui.notify(`Deleted: ${result.node.name}`, "info");
				return;
			}

			// /kg <name> — show node
			if (input && !input.includes(" ")) {
				const graph = loadGraph();
				const node = findNode(graph, input);
				if (node) {
					ctx.ui.notify(formatNodeShort(node), "info");
					return;
				}
			}

			// /kg — interactive browser
			if (ctx.hasUI) {
				await interactiveBrowser(ctx);
			} else {
				const graph = loadGraph();
				pi.sendMessage(
					{ customType: "kg-log", content: formatGraphSummary(graph), display: true },
					{ triggerTurn: false },
				);
			}
		},
	});

	// ── Subagent: fetch URL and extract entities with a small model ──

	const EXTRACT_SYSTEM = `You are a knowledge graph extraction agent.

Goal:
Extract durable knowledge from the source: the core thesis, key mechanisms, and major actors.
Do NOT produce a surface-level named-entity list.

Selection policy:
- Build a compact graph with 4-7 nodes (hard max: 8).
- Prioritize reusable concepts (ideas, forces, systems, events) over proper nouns.
- At least 50% of nodes must be concept-like (not person/company/product names).
- Include people/companies/products only if they are central to the thesis (primary subject, causal driver, or repeated canonical example).
- Skip entities that are mentioned briefly or only serve as minor examples.
- Ignore footnotes, acknowledgements, references, and meta sections unless they are essential to the main argument.
- REUSE existing entities whenever possible; use their exact names when referring to the same thing.

Relationship policy:
- Add high-signal relationships that capture causality, tradeoffs, definitions, or strategic shifts.
- Relationship quotes must be verbatim excerpts from the source text.
- Avoid weak edges like "X mentions Y".
- Both "from" and "to" in edges must match entity names in the final graph context (new nodes and/or reused existing nodes).

Quality checks before finalizing:
- Someone should understand the text's core argument from the graph alone.
- If the graph is mostly proper nouns, revise toward concepts.

Output ONLY a JSON object, no markdown fences, no explanation:
{"nodes":[{"name":"...","type":"concept|person|company|product|event|technology|market|strategy|organization|era","description":"..."}],"edges":[{"from":"...","to":"...","quote":"verbatim excerpt"}]}`;

	async function handleAddUrl(url: string, ctx: ExtensionContext): Promise<void> {
		// Show loader UI while working
		const result = await ctx.ui.custom<{ nodes: any[]; edges: any[] } | null>((tui, theme, _kb, done) => {
			const loader = new BorderedLoader(tui, theme, "🔗 Fetching via Jina Reader...");
			loader.onAbort = () => done(null);

			const doExtract = async () => {
				// 1. Fetch content
				let content: string;
				try {
					content = await fetchJina(url);
				} catch (error) {
					const msg = error instanceof Error ? error.message : String(error);
					throw new Error(`Fetch failed: ${msg}`);
				}

				(loader as any).loader?.setMessage?.(`✓ Fetched ${content.length} chars, extracting entities...`);

				// 2. Build context of existing entities
				const graph = loadGraph();
				const existingList = graph.nodes.length > 0
					? `\nExisting entities (reuse these exact names):\n${graph.nodes.map((n) => `- ${n.name} [${n.type}]`).join("\n")}\n`
					: "";

				const userPrompt = `${existingList}\n---\nURL: ${url}\n\n${content}`;

				// 3. Call small model for extraction
				const model = ctx.model; // use current model
				if (!model) throw new Error("No model available");
				const apiKey = await ctx.modelRegistry.getApiKey(model);

				const userMsg: Message = {
					role: "user",
					content: [{ type: "text", text: userPrompt }],
					timestamp: Date.now(),
				};

				const response = await complete(
					model,
					{ systemPrompt: EXTRACT_SYSTEM, messages: [userMsg] },
					{ apiKey, signal: loader.signal },
				);

				if (response.stopReason === "aborted") return null;

				const text = response.content
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text)
					.join("");

				// 4. Parse JSON from response (strip markdown fences if present)
				const cleaned = text.replace(/^```(?:json)?\s*/m, "").replace(/\s*```$/m, "").trim();
				return JSON.parse(cleaned) as { nodes: any[]; edges: any[] };
			};

			doExtract().then(done).catch((err) => {
				console.error("KG extraction failed:", err);
				done(null);
			});

			return loader;
		});

		if (!result) {
			ctx.ui.notify("Cancelled or failed", "warning");
			return;
		}

		// 5. Apply to graph
		const graph = loadGraph();
		const addedNodes: string[] = [];
		const affectedIds = new Set<string>();

		for (const n of result.nodes || []) {
			if (!n.name || !n.type) continue;
			const node = addOrMergeNode(graph, n.name, n.type, n.description || "", url);
			addedNodes.push(node.name);
			affectedIds.add(node.id);
		}

		const addedEdges: string[] = [];
		for (const e of result.edges || []) {
			if (!e.from || !e.to || !e.quote) continue;
			const edge = addEdge(graph, e.from, e.to, e.quote, url);
			if (edge) {
				addedEdges.push(`${e.from} → ${e.to}`);
				affectedIds.add(edge.from);
				affectedIds.add(edge.to);
			}
		}

		saveGraph(graph);
		regenerateAffectedMd(graph, affectedIds);
		refreshStatus(ctx);
		qmdEmbed(pi).catch(() => {});

		// Show result as a custom message (not polluting main conversation)
		const summary = `🧠 KG: +${addedNodes.length} entities, +${addedEdges.length} relations from ${url}\n` +
			(addedNodes.length > 0 ? `   Entities: ${addedNodes.join(", ")}\n` : "") +
			`   Graph: ${graph.nodes.length}n ${graph.edges.length}e`;

		pi.sendMessage(
			{ customType: "kg-log", content: summary, display: true },
			{ triggerTurn: false },
		);
	}

	// ── Search ──

	async function handleSearch(query: string, ctx: ExtensionContext): Promise<void> {
		ctx.ui.notify(`🔍 Searching: ${query}`, "info");
		const nodeIds = await qmdSearch(pi, query);
		const graph = loadGraph();
		const results = nodeIds.map((id) => graph.nodes.find((n) => n.id === id)).filter(Boolean) as KGNode[];

		if (results.length === 0) {
			ctx.ui.notify(`No results for "${query}"`, "warning");
			return;
		}

		const text = results.map((n) => formatNodeShort(n)).join("\n");
		pi.sendMessage(
			{ customType: "kg-log", content: `Search results for "${query}":\n${text}`, display: true },
			{ triggerTurn: false },
		);
	}

	// ── Interactive browser ──

	interface BrowserState {
		selectedIndex: number;
		exploringNode: string | null; // node id
		scrollOffset: number;
	}

	type BrowserAction =
		| { type: "exit"; state: BrowserState }
		| { type: "explore"; nodeId: string; state: BrowserState }
		| { type: "back"; state: BrowserState }
		| { type: "delete"; nodeId: string; state: BrowserState }
		| { type: "search"; state: BrowserState };

	async function interactiveBrowser(ctx: ExtensionContext): Promise<void> {
		let bState: BrowserState = { selectedIndex: 0, exploringNode: null, scrollOffset: 0 };

		while (true) {
			const graph = loadGraph();
			if (graph.nodes.length === 0) {
				ctx.ui.notify("Knowledge graph is empty. Use /kg <url> to add content.", "info");
				return;
			}

			const action = await ctx.ui.custom<BrowserAction>((tui, theme, _kb, done) => {
				const state = { ...bState };

				// Build display list
				const getDisplayNodes = (): KGNode[] => {
					if (state.exploringNode) {
						const centerNode = graph.nodes.find((n) => n.id === state.exploringNode);
						if (!centerNode) return graph.nodes;
						const { outgoing, incoming } = getNodeEdges(graph, centerNode.id);
						const connectedIds = new Set<string>();
						for (const e of outgoing) connectedIds.add(e.to);
						for (const e of incoming) connectedIds.add(e.from);
						// Center node first, then connected
						return [centerNode, ...graph.nodes.filter((n) => connectedIds.has(n.id) && n.id !== centerNode.id)];
					}
					// Group by type, sorted
					return [...graph.nodes].sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
				};

				const nodes = getDisplayNodes();
				const clamp = () => {
					if (nodes.length === 0) state.selectedIndex = 0;
					else state.selectedIndex = Math.max(0, Math.min(state.selectedIndex, nodes.length - 1));
				};
				clamp();

				return {
					render(width: number): string[] {
						const lines: string[] = [];
						const th = theme;

						// Title
						lines.push("");
						if (state.exploringNode) {
							const cn = graph.nodes.find((n) => n.id === state.exploringNode);
							lines.push(
								truncateToWidth(
									th.fg("accent", th.bold(`🧠 Exploring: ${cn?.name || state.exploringNode}`)),
									width,
								),
							);
						} else {
							lines.push(
								truncateToWidth(
									th.fg("accent", th.bold("🧠 Knowledge Graph")) +
										th.fg("dim", ` — ${graph.nodes.length} entities, ${graph.edges.length} relationships`),
									width,
								),
							);
						}
						lines.push(truncateToWidth(th.fg("borderMuted", "─".repeat(width)), width));

						if (nodes.length === 0) {
							lines.push(truncateToWidth(th.fg("dim", "  (empty)"), width));
						} else {
							// Node list (left) + detail (right) layout
							const listWidth = Math.min(40, Math.floor(width * 0.4));
							const detailWidth = width - listWidth - 3;

							// Selected node details
							const selectedNode = nodes[state.selectedIndex];
							const detailLines: string[] = [];
							if (selectedNode) {
								detailLines.push(th.fg("accent", th.bold(selectedNode.name)));
								detailLines.push(th.fg("dim", `Type: ${selectedNode.type}`));
								detailLines.push("");
								const wrapped = wrapTextWithAnsi(selectedNode.description, Math.max(10, detailWidth - 2));
								detailLines.push(...wrapped);
								detailLines.push("");
								detailLines.push(th.fg("dim", `Sources: ${selectedNode.sources.join(", ")}`));

								const { outgoing, incoming } = getNodeEdges(graph, selectedNode.id);
								if (outgoing.length > 0 || incoming.length > 0) {
									detailLines.push("");
									detailLines.push(th.fg("muted", "Relations:"));
									for (const e of outgoing) {
										const t = graph.nodes.find((n) => n.id === e.to);
										detailLines.push(th.fg("success", `  → ${t?.name || e.to}`));
										const qWrapped = wrapTextWithAnsi(`"${e.quote}"`, Math.max(10, detailWidth - 6));
										for (const ql of qWrapped) {
											detailLines.push(th.fg("dim", `    ${ql}`));
										}
									}
									for (const e of incoming) {
										const s = graph.nodes.find((n) => n.id === e.from);
										detailLines.push(th.fg("warning", `  ← ${s?.name || e.from}`));
										const qWrapped = wrapTextWithAnsi(`"${e.quote}"`, Math.max(10, detailWidth - 6));
										for (const ql of qWrapped) {
											detailLines.push(th.fg("dim", `    ${ql}`));
										}
									}
								}
							}

							// Visible window for scroll
							const maxVisible = 20;
							const visStart = state.scrollOffset;
							const visEnd = Math.min(nodes.length, visStart + maxVisible);

							// Render side by side
							let currentType = "";
							const listLines: string[] = [];
							for (let i = visStart; i < visEnd; i++) {
								const node = nodes[i];
								const isSel = i === state.selectedIndex;
								const isCenter = state.exploringNode && node.id === state.exploringNode;

								// Type header (only in non-explore mode)
								if (!state.exploringNode && node.type !== currentType) {
									currentType = node.type;
									listLines.push(th.fg("muted", `[${currentType}]`));
								}

								const prefix = isSel ? th.fg("accent", "› ") : "  ";
								const nameStr = isCenter ? th.fg("accent", th.bold(node.name)) : isSel ? th.fg("text", node.name) : th.fg("muted", node.name);
								const edgeCount = graph.edges.filter((e) => e.from === node.id || e.to === node.id).length;
								const badge = edgeCount > 0 ? th.fg("dim", ` (${edgeCount})`) : "";
								listLines.push(truncateToWidth(`${prefix}${nameStr}${badge}`, listWidth));
							}

							if (nodes.length > maxVisible) {
								listLines.push(th.fg("dim", `  ... ${nodes.length - maxVisible} more`));
							}

							// Combine list + detail
							const sep = th.fg("borderMuted", " │ ");
							const rowCount = Math.max(listLines.length, detailLines.length, 1);
							for (let r = 0; r < rowCount; r++) {
								const left = listLines[r] || "";
								const right = detailLines[r] || "";
								const leftPad = listWidth - visibleWidth(left);
								lines.push(truncateToWidth(left + " ".repeat(Math.max(0, leftPad)) + sep + right, width));
							}
						}

						// Help bar
						lines.push("");
						const helpParts = ["↑↓ select", "enter explore", "backspace back", "d delete", "/ search", "esc exit"];
						lines.push(truncateToWidth(th.fg("dim", helpParts.join(" • ")), width));
						lines.push("");

						return lines;
					},
					invalidate() {},
					handleInput(data: string) {
						const nodes = getDisplayNodes();
						const clamp = () => {
							if (nodes.length === 0) state.selectedIndex = 0;
							else state.selectedIndex = Math.max(0, Math.min(state.selectedIndex, nodes.length - 1));
						};

						if (matchesKey(data, Key.escape) || data === "q") {
							done({ type: "exit", state });
							return;
						}
						if (matchesKey(data, Key.up)) {
							state.selectedIndex--;
							clamp();
							// Adjust scroll
							if (state.selectedIndex < state.scrollOffset) state.scrollOffset = state.selectedIndex;
							tui.requestRender();
							return;
						}
						if (matchesKey(data, Key.down)) {
							state.selectedIndex++;
							clamp();
							if (state.selectedIndex >= state.scrollOffset + 20) state.scrollOffset = state.selectedIndex - 19;
							tui.requestRender();
							return;
						}
						if (matchesKey(data, Key.enter)) {
							if (nodes.length > 0) {
								const node = nodes[state.selectedIndex];
								done({ type: "explore", nodeId: node.id, state: { ...state, selectedIndex: 0, scrollOffset: 0 } });
							}
							return;
						}
						if (matchesKey(data, Key.backspace) || matchesKey(data, "ctrl+h")) {
							if (state.exploringNode) {
								done({ type: "back", state: { ...state, exploringNode: null, selectedIndex: 0, scrollOffset: 0 } });
							}
							return;
						}
						if (data === "d") {
							if (nodes.length > 0) {
								done({ type: "delete", nodeId: nodes[state.selectedIndex].id, state });
							}
							return;
						}
						if (data === "/") {
							done({ type: "search", state });
							return;
						}
					},
				};
			});

			bState = action.state;

			if (action.type === "exit") {
				return;
			}

			if (action.type === "explore") {
				bState = { ...bState, exploringNode: action.nodeId };
				continue;
			}

			if (action.type === "back") {
				bState = { ...bState, exploringNode: null };
				continue;
			}

			if (action.type === "delete") {
				const node = graph.nodes.find((n) => n.id === action.nodeId);
				if (node) {
					const ok = await ctx.ui.confirm("Delete", `Delete entity "${node.name}" and all its relationships?`);
					if (ok) {
						const g = loadGraph();
						const res = removeNode(g, node.name);
						saveGraph(g);
						if (res) regenerateAffectedMd(g, res.neighborIds);
						refreshStatus(ctx);
						ctx.ui.notify(`Deleted: ${node.name}`, "info");
						bState.selectedIndex = Math.max(0, bState.selectedIndex - 1);
					}
				}
				continue;
			}

			if (action.type === "search") {
				const query = await ctx.ui.input("Search knowledge graph:", "");
				if (query) {
					const nodeIds = await qmdSearch(pi, query);
					if (nodeIds.length > 0) {
						// Find and select the first result
						const g = loadGraph();
						const firstMatch = g.nodes.find((n) => nodeIds.includes(n.id));
						if (firstMatch) {
							bState = { selectedIndex: 0, exploringNode: firstMatch.id, scrollOffset: 0 };
						}
					} else {
						ctx.ui.notify(`No results for "${query}"`, "warning");
					}
				}
				continue;
			}
		}
	}

	// ── Message renderer ──

	pi.registerMessageRenderer("kg-log", (message, _options, theme) => {
		const content = typeof message.content === "string" ? message.content : String(message.content ?? "");
		return {
			render(width: number) {
				return content.split("\n").map((line) => truncateToWidth(`${theme.fg("accent", "[kg] ")}${line}`, width));
			},
			invalidate() {},
		};
	});

	// ── Status bar ──

	const refreshFromCtx = (ctx: ExtensionContext) => refreshStatus(ctx);
	pi.on("session_start", async (_e, ctx) => refreshFromCtx(ctx));
	pi.on("session_switch", async (_e, ctx) => refreshFromCtx(ctx));
	pi.on("session_fork", async (_e, ctx) => refreshFromCtx(ctx));
	pi.on("session_tree", async (_e, ctx) => refreshFromCtx(ctx));
}
