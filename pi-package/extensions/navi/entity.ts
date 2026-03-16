/**
 * NAVI System — Entity State Management
 * The digital presence lifecycle
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
	EntityState,
	EntityMood,
	VJData,
	Particle,
	NaviContext,
} from "./types";
import {
	Colors,
	EntityFrames,
	StatusLines,
	LevelThresholds,
	LevelTitles,
	Paths,
	NodeNames,
} from "./config";

// ANSI helpers
const _fg24 = (r: number, g: number, b: number, s: string) =>
	`\x1b[38;2;${r};${g};${b}m${s}\x1b[0m`;
const _px = (k: keyof typeof Colors, s: string) =>
	_fg24(Colors[k][0], Colors[k][1], Colors[k][2], s);

// Entity instance
export class Entity {
	state: EntityState;
	name: string;
	mood: EntityMood = "idle";
	coreMood: EntityMood = "idle";
	frame: number = 0;
	particles: Particle[] = [];
	particleHueBase: number = 0;

	constructor() {
		this.state = {
			xp: 0,
			totalTurns: 0,
			born: new Date().toISOString(),
			totalTokens: 0,
		};
		this.name = this.pickName();
	}

	pickName(): string {
		const names = NodeNames;
		return names[Math.floor(Math.random() * names.length)];
	}

	getStage(): number {
		const l = this.getLevel();
		if (l <= 2) return 0;
		if (l <= 5) return 1;
		if (l <= 8) return 2;
		return 3;
	}

	getLevel(): number {
		const tokens = this.state.totalTokens;
		for (let i = 0; i < LevelThresholds.length; i++) {
			if (tokens < LevelThresholds[i]) return i + 1;
		}
		return LevelThresholds.length + 1;
	}

	getTitle(): string {
		return LevelTitles[Math.min(this.getLevel() - 1, LevelTitles.length - 1)];
	}

	getProgress(): { current: number; needed: number } {
		const level = this.getLevel();
		const prev = level >= 2 ? LevelThresholds[level - 2] : 0;
		const next = LevelThresholds[level - 1] || prev + 50_000;
		return { current: this.state.totalTokens - prev, needed: next - prev };
	}

	getFrame(): string {
		const stage = this.getStage();
		const frames = EntityFrames[this.mood] || EntityFrames.idle;
		const stageFrames = frames[stage] || frames[0];
		return stageFrames[this.frame % stageFrames.length];
	}

	getStatusLine(): string {
		const lines = StatusLines[this.mood] || StatusLines.idle;
		return lines[this.frame % lines.length];
	}

	setMood(m: EntityMood) {
		this.coreMood = m;
		this.mood = this.calculateMood();
		this.frame = 0;
	}

	calculateMood(): EntityMood {
		if (["thinking", "coding", "excited"].includes(this.coreMood)) {
			return this.coreMood;
		}
		return this.coreMood;
	}

	nextFrame() {
		this.frame = (this.frame + 1) % 1000;
	}

	addXP(tokens: number) {
		const prevLevel = this.getLevel();
		this.state.totalTokens += tokens;
		const newLevel = this.getLevel();
		return { leveledUp: newLevel > prevLevel, newLevel };
	}

	persist() {
		try {
			fs.mkdirSync(path.dirname(Paths.shared), { recursive: true });
			fs.writeFileSync(
				Paths.shared,
				JSON.stringify({ level: this.getLevel(), name: this.name })
			);
		} catch {}
	}

	static load(): { level: number; name: string } | null {
		try {
			return JSON.parse(fs.readFileSync(Paths.shared, "utf-8"));
		} catch {
			return null;
		}
	}
}

// Session tracking
export function getSessionTokens(ctx: NaviContext): {
	input: number;
	output: number;
	total: number;
} {
	const data = (globalThis as any).__piTokenUsageData;
	if (data) {
		return {
			input: data.input || 0,
			output: data.output || 0,
			total: (data.input || 0) + (data.output || 0),
		};
	}
	return { input: 0, output: 0, total: 0 };
}

// VJ data from music system
export function getVJData(): VJData | undefined {
	const data = (globalThis as any).__piMusicVjData;
	if (!data || !data.playing) return undefined;
	if (Date.now() - (data.ts || 0) > 3000) return undefined;
	return data as VJData;
}
