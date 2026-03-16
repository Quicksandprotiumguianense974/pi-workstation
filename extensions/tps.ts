import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  let tokenCount = 0;
  let startTime = 0;
  let lastUpdate = 0;
  let streaming = false;
  let recentDeltas: number[] = []; // timestamps for sliding window
  const WINDOW_MS = 1500;

  const tiers = [
    { min: 0, icon: "🐌" },
    { min: 10, icon: "🐢" },
    { min: 25, icon: "🚶" },
    { min: 40, icon: "🏃" },
    { min: 60, icon: "🚲" },
    { min: 80, icon: "🏎️" },
    { min: 100, icon: "🚀" },
    { min: 150, icon: "⚡" },
  ];

  function getIcon(tps: number) {
    let icon = tiers[0].icon;
    for (const t of tiers) {
      if (tps >= t.min) icon = t.icon;
    }
    return icon;
  }

  function bar(tps: number, max = 150): string {
    const n = Math.min(Math.round((tps / max) * 10), 10);
    return "▓".repeat(n) + "░".repeat(10 - n);
  }

  function show(ctx: any) {
    const now = Date.now();
    recentDeltas = recentDeltas.filter((t) => now - t < WINDOW_MS);
    const instantTps = Math.round(recentDeltas.length / (WINDOW_MS / 1000));
    const elapsed = (now - startTime) / 1000;
    const avgTps = elapsed > 0.1 ? Math.round(tokenCount / elapsed) : 0;
    const icon = getIcon(instantTps);
    ctx.ui.setStatus("token-rate", `${icon} ${instantTps} t/s ${bar(instantTps)} ${elapsed.toFixed(1)}s avg:${avgTps}`);
  }

  pi.on("agent_start", async (_event, ctx) => {
    tokenCount = 0;
    startTime = Date.now();
    lastUpdate = 0;
    recentDeltas = [];
    streaming = true;
    ctx.ui.setStatus("token-rate", "⏳ warming up...");
  });

  pi.on("message_update", async (event, ctx) => {
    if (!streaming) return;
    const ev = event.assistantMessageEvent;
    // Count text and thinking deltas as tokens (rough: 1 delta ≈ 1 token)
    if (ev.type === "text_delta" || ev.type === "thinking_delta") {
      const now = Date.now();
      tokenCount++;
      recentDeltas.push(now);

      if (now - lastUpdate > 120) {
        lastUpdate = now;
        show(ctx);
      }
    }
  });

  pi.on("agent_end", async (_event, ctx) => {
    streaming = false;
    const elapsed = (Date.now() - startTime) / 1000;
    const avgTps = elapsed > 0.1 ? Math.round(tokenCount / elapsed) : 0;
    const icon = getIcon(avgTps);
    ctx.ui.setStatus(
      "token-rate",
      `${icon} done · ${avgTps} t/s · ${tokenCount} tokens · ${elapsed.toFixed(1)}s`
    );
  });
}
