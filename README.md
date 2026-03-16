# pi-workstation

Custom extensions and themes for [pi coding agent](https://github.com/badlogic/pi-mono).

## Extensions

### Navi
Animated companion entity that lives below the editor. Has moods (idle, thinking, happy, excited, sleeping), a particle field driven by music VJ data, and feeds from Wikipedia, Hacker News, and RSS. Levels up based on token usage.

### Music
Full music player inside the terminal. Supports YouTube, Mixcloud, Bandcamp, and NTS Radio. Search, queue, favorites, history, watchlists. Exposes real-time audio analysis (energy, beat, transients, spectral flux) as VJ data for other extensions. Uses mpv and yt-dlp.

### Knowledge Graph
Feed URLs to a graph that extracts entities and relationships, indexes them, and makes them searchable. The agent can query it during sessions as a second brain.

### LLM Council
Multiple models work on the same problem in parallel, then a chairman synthesizes the results. Supports custom templates for security audits, architecture reviews, and exploratory research.

### Git
Full interactive git TUI. Diff viewer, status with per-file staging, scrollable commit graph, stash operations, branch management, merge, and rebase — all without leaving the agent session.

### Files
IDE-style file browser. `/files` for tree navigation with git status, `/find` for fuzzy file search (Ctrl+P style), `/grep` for full-text search, plus inline editing, syntax-highlighted preview, and a diff viewer.

### Project Manager
Kanban board stored in the repo at `.pi/project-board.json`. The agent can read and update issues, so it knows what's in progress without re-explaining context.

### Background Tasks
Run long commands (builds, deploys, test suites) in the background with automatic log capture and exit code tracking.

### Output Guard
Catches the agent before it does something destructive.

### Tmux Tabs
Manages multiple terminal sessions from within the agent.

### Notify
Desktop notifications for session events.

### TPS
Tokens-per-second display.

## Themes

| Theme | Inspiration |
|-------|-------------|
| **terayama** | Shuji Terayama's avant-garde theater. Deep blacks, parchment text, traditional Japanese accent colors (kurenai, fuji, kin, koke, hotaru). |
| **kill-the-past** | Serial Experiments Lain. Static red on pure black with scanline grays and CRT whites. |
| **the-silver-case** | Suda51's detective noir. Blood red, copper, gold, film-grain textures. |
| **y2k-cyber** | Late-90s internet cafe. Electric blue, hot pink, acid green on void-black. |
| **kanagawa** | Inspired by the kanagawa.nvim colorscheme. |
| **kanagawa-contrast** | Higher contrast variant of kanagawa. |
| **plasma** | Vibrant plasma palette. |
| **dusty** | Muted, warm tones. |
| **zen-clear** | Clean, minimal, focused. |

## Installation

Copy the extensions and themes you want into your `~/.pi/agent/` directory:

```bash
# Copy all extensions
cp -r extensions/* ~/.pi/agent/extensions/

# Copy all themes
cp -r themes/* ~/.pi/agent/themes/
```

Then add them to your `~/.pi/agent/settings.json`:

```json
{
  "extensions": [
    "+extensions/navi/index.ts",
    "+extensions/music.ts",
    "+extensions/knowledge-graph/index.ts",
    "+extensions/llm-council/index.ts",
    "+extensions/git.ts",
    "+extensions/files.ts",
    "+extensions/project-manager/index.ts",
    "+extensions/background-tasks.ts",
    "+extensions/output-guard.ts",
    "+extensions/tmux-tabs.ts",
    "+extensions/notify.ts",
    "+extensions/tps.ts"
  ],
  "themes": [
    "+themes/terayama.json",
    "+themes/kill-the-past.json",
    "+themes/the-silver-case.json",
    "+themes/y2k-cyber.json",
    "+themes/kanagawa.json",
    "+themes/kanagawa-contrast.json",
    "+themes/plasma.json",
    "+themes/dusty.json",
    "+themes/zen-clear.json"
  ],
  "theme": "terayama"
}
```

### Dependencies

Some extensions require external tools:

- **Music**: [mpv](https://mpv.io/) and [yt-dlp](https://github.com/yt-dlp/yt-dlp)
- **Files / Git**: [fd](https://github.com/sharkdp/fd) and [rg](https://github.com/BurntSushi/ripgrep) (bundled with pi)

## License

MIT
