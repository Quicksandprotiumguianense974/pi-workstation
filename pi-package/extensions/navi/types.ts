/**
 * NAVI System — Type Definitions
 * Unified data entity interface for the Wired
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

// Entity states — digital presence modes
export type EntityMood =
	| "idle"      // Minimal presence
	| "thinking"  // Processing input
	| "happy"     // Positive feedback received
	| "sleep"     // Low power state
	| "excited"   // High activity
	| "coding"    // Code generation
	| "listening" // Audio sync
	| "reading";  // Information gathering

// Token tracking
export interface EntityState {
	xp: number;
	totalTurns: number;
	born: string;
	totalTokens: number;
}

// Music VJ data
export interface VJData {
	playing: boolean;
	paused: boolean;
	smoothL: number;
	smoothR: number;
	energy: number;
	beatAccum: number;
	peakEnergy: number;
	transient: number;
	spectralFlux: number;
	ts: number;
	title?: string;
	artist?: string;
	genre?: string;
	source?: string;
	position?: number;
	duration?: number;
	currentTrack?: string;
	program?: string;
}

// Particle in the void
export interface Particle {
	x: number;
	y: number;
	vx: number;
	vy: number;
	life: number;
	maxLife: number;
	hue: number;
	size: number;
}

// Data feeds
export interface HNStory {
	id: number;
	title: string;
	score: number;
	url?: string;
	by?: string;
	descendants?: number;
	domain?: string;
}

export interface RSSPost {
	title: string;
	url: string;
	site: string;
	summary?: string;
	published?: string;
}

export interface WikiEntry {
	title: string;
	description?: string;
	url: string;
}

export interface FeedSource {
	xmlUrl: string;
	site: string;
}

// Feed caches
export interface FeedCache<T> {
	items: T[];
	lastFetch: number;
	index: number;
	lastRotate: number;
}

// Extension context
export type NaviContext = ExtensionContext;
export type NaviAPI = ExtensionAPI;

// Render data
export interface RenderData {
	width: number;
	innerWidth: number;
	entityName: string;
	level: number;
	stage: number;
	mood: EntityMood;
	isWorking: boolean;
	workingFrame: number;
	marqueeTick: number;
	tokenData: {
		sessionTotal: number;
		totalTokens: number;
	};
	music?: VJData;
	particles: Particle[];
}
