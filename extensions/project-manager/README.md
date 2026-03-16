# Project Manager Extension

A local project board for pi.

## Current behavior

- Board file: `<repo>/.pi/project-board.json`
- Statuses: `backlog` / `in_progress` / `done`
- IDs: `PM-1`, `PM-2`, ...
- Agent tool: `project_manager` with actions:
  - `list`, `get`, `add`, `remove`, `update`, `move`
- `project_manager` is intended for daily task management, not just storage:
  - capture review findings
  - turn plans into executable tasks
  - list work by status and next-up tasks
  - move work as execution progresses
- `remove` is direct (no confirmation)

## User interaction model

All user operations happen inside **`/pm` UI**.

- Subcommands are disabled (for example `/pm add ...` will show a tip and open the board).
- Use `/pm` and manage issues with keyboard actions in the board.

## `/pm` board keys

- `↑/↓`: select issue
- `←/→`: switch column
- `a`: add issue (interactive form)
- `e`: edit selected issue (interactive form)
- `m`: move to next status
- `d`: move to done
- `x`: remove issue
- `enter`: show selected issue summary
- `esc`: close board

## Interactive fields (add/edit)

- Title (required)
- Description
- Status
- Assignee
- Due date (`YYYY-MM-DD`)
- Labels (comma-separated)

## Footer status

Shows a compact summary plus 1-2 next tasks:

`PM B:<backlog> P:<in_progress> D:<done> | PM-14:Title · PM-16:Title`

## Tool examples (for Agent)

```json
{ "action": "add", "title": "Design API", "labels": ["backend", "api"] }
```

```json
{ "action": "update", "id": "PM-1", "patch": { "status": "in_progress", "assignee": "marv" } }
```

```json
{ "action": "remove", "id": "PM-1" }
```

## Phase-2 reserve

Path resolver already supports a future scope switch:

- `repo` (current default)
- `cwd` (future: each directory has its own board)
