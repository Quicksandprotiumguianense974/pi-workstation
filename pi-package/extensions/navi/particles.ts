/**
 * NAVI System — Particle Void Engine
 * Dream Dust, Moth Wings, Candle Sparks
 *
 * Smooth color interpolation, additive blending,
 * ambient theater dust, and gain-normalized audio reactivity.
 */

import { Particle, VJData } from "./types";

const MAX_PARTICLES = 350;
const MAX_AMBIENT = 12;

const DREAM_CHARS = [
	"·", "∘", "°",
	"✦", "✧", "※",
	"○", "◦", "◌",
	"†", "‡", "☽",
	"∷", "∴", "·",
	"★", "☆", "·",
];

// Warm theatrical palette — normalized to 0..1 for additive blending
const DreamPalette: [number, number, number][] = [
	[224 / 255, 72 / 255, 72 / 255],        // Crimson curtain
	[216 / 255, 184 / 255, 104 / 255],      // Tarnished gold
	[168 / 255, 88 / 255, 168 / 255],       // Wisteria purple
	[208 / 255, 104 / 255, 120 / 255],      // Faded rose
	[216 / 255, 200 / 255, 136 / 255],      // Firefly / candle glow
];

function lerpColor(hue: number): [number, number, number] {
	const h = ((hue % 360) + 360) % 360;
	const segment = h / 72;
	const idx = Math.floor(segment) % 5;
	const next = (idx + 1) % 5;
	const t = segment - Math.floor(segment);
	const [r1, g1, b1] = DreamPalette[idx];
	const [r2, g2, b2] = DreamPalette[next];
	return [
		r1 + (r2 - r1) * t,
		g1 + (g2 - g1) * t,
		b1 + (b2 - b1) * t,
	];
}

// Glow kernel — warm candlelight diffusion
const GLOW: [number, number, number][] = [
	[0, -1, 0.40], [0, 1, 0.40],
	[0, -2, 0.18], [0, 2, 0.18],
	[-1, 0, 0.25], [1, 0, 0.25],
	[-1, -1, 0.15], [-1, 1, 0.15],
	[1, -1, 0.15], [1, 1, 0.15],
	[0, -3, 0.06], [0, 3, 0.06],
];

export class ParticleField {
	particles: Particle[] = [];
	hueBase: number = 0;

	spawn(music: VJData) {
		const { energy, beatAccum, transient = 0, peakEnergy = energy } = music;

		const base = 1 + Math.floor(energy * 4);
		const levelSpawn = Math.floor(peakEnergy * 18);
		const transientBurst = Math.floor(transient * 22);
		const count = base + levelSpawn + transientBurst;

		const hueSpeed = 15 + energy * 35;
		this.hueBase = (beatAccum * hueSpeed) % 360;
		const hueJitter = transient * 100;

		const stereoBalance = music.smoothL - music.smoothR;
		const stereoDiff = Math.abs(stereoBalance);

		for (let i = 0; i < count && this.particles.length < MAX_PARTICLES; i++) {
			const baseAngle = transient > 0.3
				? Math.random() * Math.PI * 2
				: -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 0.6;

			const baseSpeed = 0.004 + peakEnergy * 0.035 + transient * 0.045;
			const speed = baseSpeed + Math.random() * 0.015;

			let spawnX: number;
			if (stereoDiff > 0.1) {
				spawnX = stereoBalance < 0
					? (Math.random() < 0.6 ? 0.1 + Math.random() * 0.35 : 0.4 + Math.random() * 0.5)
					: (Math.random() < 0.6 ? 0.55 + Math.random() * 0.35 : 0.1 + Math.random() * 0.5);
			} else {
				const spread = 0.35 + energy * 0.45;
				spawnX = 0.5 + (Math.random() - 0.5) * spread * 2;
			}
			spawnX = Math.max(0, Math.min(1, spawnX));

			const spawnY = transient > 0.2
				? 0.65 + Math.random() * 0.35
				: 0.4 + Math.random() * 0.6;

			const life = transient > 0.3
				? 0.4 + Math.random() * 0.5 + peakEnergy * 0.4
				: 0.6 + Math.random() * 0.8 + energy * 0.7;

			const size = 0.15 + peakEnergy * 0.5 + transient * 0.4 + Math.random() * 0.2;

			const posHue = spawnX * 72;
			const hue = (this.hueBase + hueJitter * (Math.random() - 0.5) + posHue + Math.random() * 40) % 360;

			this.particles.push({
				x: spawnX,
				y: spawnY,
				vx: Math.cos(baseAngle) * speed + stereoBalance * 0.008,
				vy: Math.sin(baseAngle) * speed * 0.5,
				life,
				maxLife: life,
				hue,
				size: Math.min(1.3, size),
			});
		}
	}

	spawnAmbient() {
		if (this.particles.length >= MAX_AMBIENT) return;
		if (Math.random() > 0.05) return;

		this.particles.push({
			x: 0.1 + Math.random() * 0.8,
			y: 0.7 + Math.random() * 0.3,
			vx: (Math.random() - 0.5) * 0.0015,
			vy: -0.001 - Math.random() * 0.002,
			life: 3.0 + Math.random() * 3.0,
			maxLife: 4.5,
			hue: Math.random() * 360,
			size: 0.06 + Math.random() * 0.10,
		});
	}

	update(dt: number, music?: VJData) {
		const energy = music?.energy || 0;
		const transient = music?.transient || 0;
		const smoothL = music?.smoothL || 0;
		const smoothR = music?.smoothR || 0;

		for (const p of this.particles) {
			p.x += p.vx * dt;
			p.y += p.vy * dt;
			p.life -= dt * (0.65 / p.maxLife);

			const rise = energy > 0.2 ? -0.0004 * energy : -0.00008;
			p.vy += rise * dt;

			p.vx += (Math.random() - 0.5) * 0.001 * dt;

			const friction = 0.998 - energy * 0.003;
			p.vx *= friction;
			p.vy *= friction;

			if (transient > 0.15) {
				const dx = p.x - 0.5;
				const dy = p.y - 0.5;
				const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
				const force = transient * 0.003 * dt;
				p.vx += (dx / dist) * force;
				p.vy += (dy / dist) * force;
			}

			p.vx += (smoothR - smoothL) * 0.0015 * dt;

			if (energy > 0.15) {
				p.vx += (Math.random() - 0.5) * energy * 0.002 * dt;
				p.vy += (Math.random() - 0.5) * energy * 0.0015 * dt;
			}
		}

		this.particles = this.particles.filter(
			p => p.life > 0 && p.x >= -0.15 && p.x <= 1.15 && p.y >= -0.15 && p.y <= 1.15
		);
	}

	render(cols: number, rows: number, energy: number, transient = 0): string[] {
		const size = rows * cols;
		const gridR = new Float32Array(size);
		const gridG = new Float32Array(size);
		const gridB = new Float32Array(size);

		for (const p of this.particles) {
			const col = Math.floor(p.x * cols);
			const row = Math.floor(p.y * rows);
			if (row < 0 || row >= rows || col < 0 || col >= cols) continue;

			const fade = Math.max(0, p.life / p.maxLife);
			const intensity = p.size * fade;
			const [cr, cg, cb] = lerpColor(p.hue);

			// Additive splat — center
			const ci = row * cols + col;
			gridR[ci] += cr * intensity;
			gridG[ci] += cg * intensity;
			gridB[ci] += cb * intensity;

			// Additive splat — glow kernel
			for (const [dr, dc, mult] of GLOW) {
				const nr = row + dr, nc = col + dc;
				if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) {
					const gi = nr * cols + nc;
					const glow = intensity * mult;
					gridR[gi] += cr * glow;
					gridG[gi] += cg * glow;
					gridB[gi] += cb * glow;
				}
			}
		}

		const lines: string[] = [];
		for (let r = 0; r < rows; r++) {
			let line = "";
			for (let c = 0; c < cols; c++) {
				const i = r * cols + c;
				const rv = gridR[i], gv = gridG[i], bv = gridB[i];
				const brightness = Math.max(rv, gv, bv);

				if (brightness < 0.04) {
					line += " ";
					continue;
				}

				const boosted = Math.min(1.5, brightness + transient * 0.2);
				const charIdx = Math.min(DREAM_CHARS.length - 1, Math.round(boosted * (DREAM_CHARS.length - 1)));
				const ch = DREAM_CHARS[charIdx];

				// Atmospheric warmth — additive overlap naturally shifts toward white
				const warmth = 0.35 + Math.min(1.4, boosted) * 0.65 + energy * 0.15;
				const rr = Math.min(255, Math.round(rv * warmth * 280));
				const gg = Math.min(255, Math.round(gv * warmth * 280));
				const bb = Math.min(255, Math.round(bv * warmth * 280));

				line += `\x1b[38;2;${rr};${gg};${bb}m${ch}\x1b[0m`;
			}
			lines.push(line);
		}
		return lines;
	}
}
