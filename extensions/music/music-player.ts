import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { promisify } from "node:util";

import type { MusicItem, PlayerSnapshot, AudioLevels } from "./music-types";

const MUSIC_DIR = join(homedir(), ".pi", "agent", "music");
const SOCKET_PATH = join(MUSIC_DIR, "mpv.sock");
const PLAYER_VERSION_PATH = join(MUSIC_DIR, "mpv.version");
const PLAYER_CONFIG_VERSION = "2";
const execFileAsync = promisify(execFile);
let mpvCheck: Promise<void> | undefined;

interface MpvResponse {
	request_id?: number;
	error?: string;
	data?: unknown;
	event?: string;
}

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (reason: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

class MusicPlayer {
	private process?: ChildProcess;
	private requestId = 1;
	private socket?: net.Socket;
	private socketConnected = false;
	private pendingRequests = new Map<number, PendingRequest>();
	private socketBuffer = "";
	private audioFilterInstalled = false;

	private ensureDir(): void {
		mkdirSync(MUSIC_DIR, { recursive: true });
	}

	private isAlive(): boolean {
		const pid = this.process?.pid;
		if (!pid) return false;
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	}

	private async waitForSocket(timeoutMs = 4000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (existsSync(SOCKET_PATH)) return;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		throw new Error("mpv IPC socket did not appear");
	}

	private hasExpectedConfig(): boolean {
		try {
			return existsSync(PLAYER_VERSION_PATH) && readFileSync(PLAYER_VERSION_PATH, "utf8").trim() === PLAYER_CONFIG_VERSION;
		} catch {
			return false;
		}
	}

	private markConfigVersion(): void {
		writeFileSync(PLAYER_VERSION_PATH, PLAYER_CONFIG_VERSION);
	}

	private async ensureMpvAvailable(): Promise<void> {
		mpvCheck ??= execFileAsync("mpv", ["--version"], { timeout: 5_000 })
			.then(() => undefined)
			.catch(() => {
				throw new Error("mpv is required for music playback. Install it and make sure it is on PATH.");
			});
		return await mpvCheck;
	}

	private async isSocketResponsive(): Promise<boolean> {
		if (!existsSync(SOCKET_PATH)) return false;
		return new Promise((resolve) => {
			const sock = net.createConnection(SOCKET_PATH);
			const done = (result: boolean) => {
				sock.removeAllListeners();
				if (!sock.destroyed) sock.destroy();
				resolve(result);
			};
			sock.setTimeout(1000, () => done(false));
			sock.on("error", () => done(false));
			sock.on("connect", () => {
				sock.write(`${JSON.stringify({ command: ["get_property", "idle-active"], request_id: -1 })}\n`);
			});
			sock.on("data", () => done(true));
		});
	}

	async ensureStarted(): Promise<void> {
		this.ensureDir();
		await this.ensureMpvAvailable();
		if (this.isAlive() && existsSync(SOCKET_PATH) && this.hasExpectedConfig()) return;

		// Another session may own the mpv process — reuse it if the socket responds
		if (!this.isAlive() && existsSync(SOCKET_PATH) && this.hasExpectedConfig()) {
			if (await this.isSocketResponsive()) return;
		}

		// Only kill mpv if we own the process (have a pid reference)
		if (this.isAlive()) {
			await this.shutdown();
		}

		// Clean up stale socket left behind by a crashed process
		if (existsSync(SOCKET_PATH)) {
			rmSync(SOCKET_PATH, { force: true });
		}

		const child = spawn(
			"mpv",
			[
				"--idle=yes",
				"--no-terminal",
				"--audio-display=no",
				"--force-window=no",
				"--vid=no",
				"--ytdl=yes",
				"--ytdl-format=bestaudio/best",
				"--script-opts=ytdl_hook-ytdl_path=yt-dlp",
				`--input-ipc-server=${SOCKET_PATH}`,
			],
			{
				detached: true,
				stdio: "ignore",
			},
		);
		child.unref();
		this.process = child;
		await this.waitForSocket();
		this.markConfigVersion();
	}

	private disconnectSocket(): void {
		if (this.socket) {
			this.socket.removeAllListeners();
			if (!this.socket.destroyed) this.socket.destroy();
			this.socket = undefined;
			this.socketConnected = false;
			this.socketBuffer = "";
		}
		for (const [id, pending] of this.pendingRequests) {
			clearTimeout(pending.timer);
			pending.reject(new Error("Socket disconnected"));
			this.pendingRequests.delete(id);
		}
	}

	private ensureConnected(): Promise<void> {
		if (this.socket && this.socketConnected) return Promise.resolve();

		this.disconnectSocket();

		return new Promise((resolve, reject) => {
			const socket = net.createConnection(SOCKET_PATH);
			this.socket = socket;

			socket.on("connect", () => {
				this.socketConnected = true;
				resolve();
			});

			socket.on("data", (chunk) => {
				this.socketBuffer += chunk.toString("utf8");
				const lines = this.socketBuffer.split("\n");
				this.socketBuffer = lines.pop() ?? "";

				for (const line of lines) {
					if (!line.trim()) continue;
					let response: MpvResponse;
					try {
						response = JSON.parse(line) as MpvResponse;
					} catch {
						continue;
					}
					if (response.request_id === undefined) continue;
					const pending = this.pendingRequests.get(response.request_id);
					if (!pending) continue;
					this.pendingRequests.delete(response.request_id);
					clearTimeout(pending.timer);
					if (response.error && response.error !== "success") {
						pending.reject(new Error(`mpv IPC error: ${response.error}`));
					} else {
						pending.resolve(response.data);
					}
				}
			});

			socket.on("error", (error) => {
				this.disconnectSocket();
				reject(error);
			});

			socket.on("close", () => {
				this.disconnectSocket();
			});
		});
	}

	private async request(command: unknown[]): Promise<unknown> {
		await this.ensureStarted();
		await this.ensureConnected();

		const requestId = this.requestId++;
		const socket = this.socket;
		if (!socket || !this.socketConnected) {
			throw new Error("Socket not connected");
		}

		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pendingRequests.delete(requestId);
				reject(new Error("mpv IPC request timed out"));
			}, 2500);

			this.pendingRequests.set(requestId, { resolve, reject, timer });
			socket.write(`${JSON.stringify({ command, request_id: requestId })}\n`);
		});
	}

	private async requestProperty<T>(name: string): Promise<T | undefined> {
		try {
			return (await this.request(["get_property", name])) as T;
		} catch {
			return undefined;
		}
	}

	async play(item: MusicItem): Promise<void> {
		const target = item.streamUrl || item.inputUrl;
		if (!target) {
			throw new Error("Missing playback target");
		}
		await this.request(["loadfile", target, "replace"]);
	}

	async togglePause(): Promise<boolean> {
		const paused = Boolean(await this.request(["get_property", "pause"]));
		await this.request(["set_property", "pause", !paused]);
		return !paused;
	}

	async stop(): Promise<void> {
		await this.request(["stop"]);
	}

	async seek(positionSeconds: number): Promise<void> {
		try {
			await this.request(["set_property", "time-pos", positionSeconds]);
		} catch {
			await this.request(["seek", positionSeconds, "absolute"]);
		}
	}

	async getSnapshot(): Promise<PlayerSnapshot> {
		const idle = Boolean(await this.requestProperty<boolean>("idle-active"));
		const paused = Boolean(await this.requestProperty<boolean>("pause"));
		const timePos = await this.requestProperty<number>("time-pos");
		const duration = await this.requestProperty<number>("duration");
		return {
			idle,
			paused,
			timePosSeconds: typeof timePos === "number" ? timePos : undefined,
			durationSeconds: typeof duration === "number" ? duration : undefined,
		};
	}

	async ensureAudioFilter(): Promise<void> {
		if (this.audioFilterInstalled) return;
		try {
			await this.request(["af", "add", "@astats:lavfi=[astats=metadata=1:reset=1:length=0.1]"]);
			this.audioFilterInstalled = true;
		} catch {
			// filter may already exist or not be supported
			this.audioFilterInstalled = true;
		}
	}

	async getAudioLevels(): Promise<AudioLevels | undefined> {
		try {
			await this.ensureAudioFilter();
			const meta = await this.requestProperty<Record<string, string>>("af-metadata/astats");
			if (!meta) return undefined;

			// dB normalization: music typically sits -30 to 0 dB
			// Map -40..0 dB → 0..1 for maximum visual range
			const norm = (db: number) => Math.max(0, Math.min(1, (db + 40) / 40));

			const peakL = parseFloat(meta["lavfi.astats.1.Peak_level"] ?? "-100");
			const peakR = parseFloat(meta["lavfi.astats.2.Peak_level"] ?? meta["lavfi.astats.1.Peak_level"] ?? "-100");
			const rmsL = parseFloat(meta["lavfi.astats.1.RMS_level"] ?? "-100");
			const rmsR = parseFloat(meta["lavfi.astats.2.RMS_level"] ?? meta["lavfi.astats.1.RMS_level"] ?? "-100");
			return {
				peakL: norm(peakL),
				peakR: norm(peakR),
				rmsL: norm(rmsL),
				rmsR: norm(rmsR),
			};
		} catch {
			return undefined;
		}
	}

	resetAudioFilter(): void {
		this.audioFilterInstalled = false;
	}

	disconnect(): void {
		this.disconnectSocket();
	}

	async shutdown(): Promise<void> {
		this.disconnectSocket();

		try {
			// Need a temporary connection for the quit command since we just disconnected
			await new Promise<void>((resolve) => {
				if (!existsSync(SOCKET_PATH)) { resolve(); return; }
				const sock = net.createConnection(SOCKET_PATH);
				sock.on("connect", () => {
					sock.write(`${JSON.stringify({ command: ["quit"], request_id: 0 })}\n`);
					sock.destroy();
					resolve();
				});
				sock.on("error", () => { sock.destroy(); resolve(); });
				sock.setTimeout(1000, () => { sock.destroy(); resolve(); });
			});
		} catch {
			// Ignore
		}

		const pid = this.process?.pid;
		if (pid) {
			try {
				process.kill(pid, "SIGTERM");
			} catch {
				// ignore
			}
		}
		this.process = undefined;
		if (existsSync(SOCKET_PATH)) {
			rmSync(SOCKET_PATH, { force: true });
		}
		if (existsSync(PLAYER_VERSION_PATH)) {
			rmSync(PLAYER_VERSION_PATH, { force: true });
		}
	}
}

declare global {
	var __piMusicPlayer: MusicPlayer | undefined;
}

export function getMusicPlayer(): MusicPlayer {
	globalThis.__piMusicPlayer ??= new MusicPlayer();
	return globalThis.__piMusicPlayer;
}
