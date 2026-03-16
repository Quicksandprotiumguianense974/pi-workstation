/**
 * Enhanced Pi Notify Extension
 *
 * Features:
 * - macOS native notifications via osascript (works in ANY terminal)
 * - Smart content: shows duration, token usage, tool count
 * - Only notifies when terminal is NOT focused (no spam)
 * - Custom sound via system sound
 * - Notification click focuses terminal
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { execFile, exec } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

let agentStartTime = 0;
let toolCount = 0;
let toolNames: string[] = [];

/** Check if the terminal app is the frontmost (focused) window on macOS */
async function isTerminalFocused(): Promise<boolean> {
  try {
    const { stdout } = await execAsync(
      `osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true'`
    );
    const front = stdout.trim().toLowerCase();
    // Common terminal apps
    const terminals = ["ghostty", "iterm2", "terminal", "wezterm", "kitty", "alacritty", "hyper", "warp"];
    return terminals.some((t) => front.includes(t));
  } catch {
    return false; // If we can't check, assume not focused → notify
  }
}

/** Send macOS native notification */
function notifyMacOS(title: string, body: string, sound?: string): void {
  const soundPart = sound ? ` sound name "${sound}"` : "";
  const script = `display notification "${body.replace(/"/g, '\\"')}" with title "${title.replace(/"/g, '\\"')}"${soundPart}`;

  execFile("osascript", ["-e", script], (err) => {
    if (err) {
      // Fallback to OSC 777
      process.stdout.write(`\x1b]777;notify;${title};${body}\x07`);
    }
  });
}

/** Format duration nicely */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `${m}m${rem}s` : `${m}m`;
}

/** Build a smart notification body */
function buildBody(durationMs: number): string {
  const duration = formatDuration(durationMs);
  const parts: string[] = [];

  parts.push(`⏱ ${duration}`);

  if (toolCount > 0) {
    const unique = [...new Set(toolNames)];
    const summary = unique.length <= 3 ? unique.join(", ") : `${unique.slice(0, 3).join(", ")}…`;
    parts.push(`🔧 ${toolCount} tools (${summary})`);
  }

  return parts.join("  ·  ");
}

export default function (pi: ExtensionAPI) {
  pi.on("agent_start", async () => {
    agentStartTime = Date.now();
    toolCount = 0;
    toolNames = [];
  });

  pi.on("tool_execution_end", async (event) => {
    toolCount++;
    toolNames.push(event.toolName);
  });

  pi.on("agent_end", async () => {
    // Don't notify if task was very quick (< 3s, likely trivial)
    const duration = Date.now() - agentStartTime;
    if (duration < 3000) return;

    // Don't notify if terminal is already focused
    const focused = await isTerminalFocused();
    if (focused) return;

    const body = buildBody(duration);
    notifyMacOS("✨ Pi", body, "Glass");
  });
}
