# AgentScope

A local-first observability dashboard for code agent sessions across Claude Code, Codex, Copilot, Cursor, and imported archives. Reads directly from local agent data directories to give you visibility into sessions, projects, tools, usage, costs, and code changes — no cloud, no telemetry, just your data.

![Overview Dashboard](./screenshots/overview.png)

## Features

**Dashboard Overview** — Total sessions, messages, tokens, and estimated costs at a glance. Usage-over-time charts, model breakdown donut, GitHub-style activity heatmap, and peak hours distribution.

**Projects** — See all tracked agent projects with session counts, token usage, cost estimates, provider badges, and last activity. Drill into any project to see its sessions and most-used tools.

![Projects](./screenshots/projects.png)

**Sessions** — Browse all sessions with duration, message count, tool calls, token usage, and cost. Compaction events are highlighted in amber so you can see which sessions hit context limits.

![Sessions](./screenshots/sessions.png)

**Session Detail** — Full conversation replay with user prompts and assistant responses, tool call badges, token-per-message counts, and a sidebar with token breakdown, tools used, compaction timeline, provider ids, and metadata.

![Session Detail](./screenshots/session-detail.png)

**Cost Analytics** — Cost-over-time stacked by model, cost-by-project bar chart, per-model token breakdown, cache efficiency metrics, and a pricing reference table.

![Cost Analytics](./screenshots/costs.png)

**Data Export/Import** — Export selected agent data as a full backup ZIP or a smaller standardized-only ZIP. Import full exports on another machine to view the same dashboard, and toggle between live and imported data sources.

![Data Management](./screenshots/data.png)

### What data does it read?

| Source | Path | Contains |
|--------|------|----------|
| Claude session logs | `~/.claude/projects/<project>/<session>.jsonl` | Messages, tool calls, token usage, model, timestamps, compaction events |
| Claude stats cache | `~/.claude/stats-cache.json` | Pre-computed daily activity, model usage, hourly distribution |
| Claude history | `~/.claude/history.jsonl` | Prompts with project context |
| Claude plans/todos | `~/.claude/plans/*.md`, `~/.claude/todos/*.json` | Implementation plans and task lists from sessions |
| Codex rollout logs | `~/.codex/sessions/**/*.jsonl` | Codex turns, reasoning summaries, shell/apply_patch activity, token counts, compactions |
| Codex session index | `~/.codex/session_index.jsonl` | Optional session title hints |
| Copilot chat storage | VS Code/Copilot user data directories | Chat sessions, transcripts, project context, and model/tool metadata where available |
| Cursor project data | `~/.cursor/projects/**`, Cursor user storage | Agent transcripts, project mappings, and local session metadata |

Claude live sessions and resume continue to work. Codex, Copilot, and Cursor sources are historical/read-only in this version, so live input and resume remain Claude-only until those providers have stable local control semantics.

### Local data cache

Overview, Sessions, Projects, Costs, and common searches use a local per-session summary cache so unchanged transcript files do not need to be reparsed on every page load. The cache stores normalized metadata, token totals, cost inputs, tool counts, and bounded search text; it does not store full raw transcripts, and session detail pages still read the selected source file. Set `AGENT_SCOPE_CACHE_DIR` to override the cache location for development or tests. See [docs/CacheArchitecture.md](./docs/CacheArchitecture.md) for details.

## Quick Start

```bash
git clone https://github.com/deshraj/AgentScope.git
cd AgentScope
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The dashboard detects supported local agent directories automatically and lets you select one provider or a combined view.

## Desktop App

AgentScope can also be packaged as a Windows desktop app with Electron. The Electron shell starts the existing Next.js standalone server on a local port, opens it in a desktop window, and shuts the server down when the app exits.

The packaged app still reads live local agent data from supported provider directories. Imported desktop data is stored in the Electron user data directory instead of the install folder.

### Desktop Development

Run the Next dev server and Electron together:

```bash
npm run electron:dev
```

This opens an Electron window backed by `next dev` at `127.0.0.1:3000`.

### Build Desktop Artifacts

Prepare a standalone Next build and copy the static assets needed by Electron:

```bash
npm run electron:prepare
```

Create an unpacked app for smoke testing:

```bash
npm run electron:pack
```

Create Windows `.exe` artifacts:

```bash
npm run electron:dist
```

This command builds local artifacts only. GitHub Releases are published by the release workflow after artifacts are built and smoke-tested.

Release outputs are written to `dist-electron/`:

| Artifact | Purpose |
|----------|---------|
| `AgentScope-Setup-<version>-x64.exe` | NSIS installer |
| `AgentScope-Portable-<version>-x64.exe` | Portable executable |
| `win-unpacked/AgentScope.exe` | Unpacked app for local smoke testing |

See [docs/electron-exe-packaging-design.md](./docs/electron-exe-packaging-design.md) for the packaging architecture and follow-up work.

## GitHub Automation

GitHub Actions workflows live under `.github/workflows/`:

| Workflow | Trigger | What it does |
|----------|---------|--------------|
| `CI` | Pushes to `main`, pull requests, manual dispatch | Installs dependencies, typechecks, lints, runs unit tests, installs Chromium, and runs Playwright e2e tests |
| `Release` | Tags matching `v*`, manual dispatch | Builds Windows Electron artifacts, smoke-tests the packaged Next server, uploads artifacts, and publishes a GitHub Release |

The release workflow uses the repository `GITHUB_TOKEN` with `contents: write` permission. No extra secret is required for unsigned Windows builds.

## Release Checklist

1. Update the version in `package.json`.
2. Install dependencies from the lockfile:

   ```bash
   npm ci
   ```

3. Run validation:

   ```bash
   npx tsc --noEmit
   npm run lint
   npm run test:unit
   npm run test:e2e
   ```

4. Build the desktop release:

   ```bash
   npm run electron:dist
   ```

5. Smoke test the unpacked app:

   ```bash
   .\dist-electron\win-unpacked\AgentScope.exe
   ```

   Verify Overview loads, live/imported data controls render, session detail pages open, and closing the window stops the local server.

6. Smoke test the installer or portable executable from `dist-electron/`.
7. Create and push a git tag that matches `package.json`, for example:

   ```bash
   git tag v0.1.0
   git push origin v0.1.0
   ```

8. Watch the **Release** workflow in GitHub Actions. It publishes the `.exe` artifacts and `latest.yml` to the GitHub Release.

Current release caveats: the Windows app is unsigned and uses the default Electron icon. Unsigned builds may trigger Windows SmartScreen warnings.

## Tech Stack

- **Next.js 16** (App Router, Turbopack)
- **TypeScript**
- **Tailwind CSS v4** + **shadcn/ui**
- **Recharts** for charts
- **SWR** for data fetching
- **Lucide** icons
- **Electron** + **electron-builder** for Windows desktop packaging

No database required. Reads local agent files directly via Node.js API routes.

## Project Structure

```
src/
├── app/
│   ├── page.tsx                 # Overview dashboard
│   ├── projects/                # Projects list + detail
│   ├── sessions/                # Sessions list + detail
│   ├── costs/                   # Cost analytics
│   ├── data/                    # Export/import management
│   └── api/
│       ├── stats/               # Dashboard stats
│       ├── projects/            # Project data
│       ├── sessions/            # Session list + detail
│       ├── export/              # ZIP export
│       ├── import/              # ZIP import
│       └── data-source/         # Live vs imported toggle
├── components/
│   ├── charts/                  # Recharts components
│   ├── cards/                   # Stat cards
│   └── layout/                  # Sidebar
├── lib/
│   ├── agent-data/              # Provider registry, route ids, archive helpers
│   │   └── providers/
│   │       ├── claude/           # Claude provider adapter
│   │       ├── codex/            # Codex discovery, parsing, stats, export
│   │       ├── copilot/          # Copilot chat/session readers
│   │       └── cursor/           # Cursor transcript and state readers
│   ├── claude-data/
│   │   ├── types.ts             # Shared dashboard interfaces
│   │   ├── reader.ts            # Claude file parsers + aggregation
│   │   └── data-source.ts       # Compatibility exports for data source helpers
│   ├── hooks.ts                 # SWR hooks
│   └── format.ts                # Number/date formatters
└── config/
    └── pricing.ts               # Model pricing + cost calculator
electron/
└── main.cjs                     # Desktop shell + local Next server lifecycle
scripts/
├── prepare-electron-next.cjs    # Copies Next standalone static assets
└── electron-after-pack.cjs      # Copies traced server dependencies after packaging
docs/
└── electron-exe-packaging-design.md
```

## Data Export/Import

Export your data to share across machines or keep as a backup:

1. Go to the **Data** page in the sidebar
2. Select any detected agent provider or all detected agents
3. Click **Full export ZIP** to download selected safe raw session data plus standardized data
4. Click **Standardized only ZIP** when you only need the smaller provider-normalized dataset
5. On another machine, upload a full ZIP via **Import** to view the dashboard with that data
6. Toggle between **Live** and **Imported** data at any time

Codex exports include rollout JSONL files plus `session_index.jsonl`/`version.json` when present. They intentionally exclude `auth.json`, capability/session ids, sandbox/temp folders, SQLite/log files, plugin caches, and skill caches.

Full exports also include a provider-normalized copy under `agent-data/standardized/`. Standardized-only exports contain just that normalized folder, where `projects.json`, `sessions.json`, and per-session detail files use the same dashboard schema for every provider.

## License

MIT
