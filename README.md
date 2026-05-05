# Claud-ometer

A local-first analytics dashboard for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Reads directly from `~/.claude/` to give you full visibility into your usage, costs, sessions, and projects — no cloud, no telemetry, just your data.

![Overview Dashboard](./screenshots/overview.png)

## Features

**Dashboard Overview** — Total sessions, messages, tokens, and estimated costs at a glance. Usage-over-time charts, model breakdown donut, GitHub-style activity heatmap, and peak hours distribution.

**Projects** — See all your Claude Code projects with session counts, token usage, cost estimates, and last activity. Drill into any project to see its sessions and most-used tools.

![Projects](./screenshots/projects.png)

**Sessions** — Browse all sessions with duration, message count, tool calls, token usage, and cost. Compaction events are highlighted in amber so you can see which sessions hit context limits.

![Sessions](./screenshots/sessions.png)

**Session Detail** — Full conversation replay with user prompts and Claude responses, tool call badges, token-per-message counts, and a sidebar with token breakdown, tools used, compaction timeline, and metadata.

![Session Detail](./screenshots/session-detail.png)

**Cost Analytics** — Cost-over-time stacked by model, cost-by-project bar chart, per-model token breakdown, cache efficiency metrics, and a pricing reference table.

![Cost Analytics](./screenshots/costs.png)

**Data Export/Import** — Export all your Claude Code data as a ZIP. Import it on another machine to view the same dashboard. Toggle between live and imported data sources.

![Data Management](./screenshots/data.png)

### What data does it read?

| Source | Path | Contains |
|--------|------|----------|
| Session logs | `~/.claude/projects/<project>/<session>.jsonl` | Every message, tool call, token usage, model, timestamps, compaction events |
| Stats cache | `~/.claude/stats-cache.json` | Pre-computed daily activity, model usage, hourly distribution |
| History | `~/.claude/history.jsonl` | Every prompt you've typed with project context |
| Plans | `~/.claude/plans/*.md` | Implementation plans from sessions |
| Todos | `~/.claude/todos/*.json` | Task lists from sessions |

## Quick Start

```bash
git clone https://github.com/deshraj/Claud-ometer.git
cd Claud-ometer
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The dashboard reads from your local `~/.claude/` directory automatically.

## Desktop App

Claud-ometer can also be packaged as a Windows desktop app with Electron. The Electron shell starts the existing Next.js standalone server on a local port, opens it in a desktop window, and shuts the server down when the app exits.

The packaged app still reads live Claude Code data from `~/.claude/`. Imported desktop data is stored in the Electron user data directory instead of the install folder.

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

Release outputs are written to `dist-electron/`:

| Artifact | Purpose |
|----------|---------|
| `Claud-ometer-Setup-<version>-x64.exe` | NSIS installer |
| `Claud-ometer-Portable-<version>-x64.exe` | Portable executable |
| `win-unpacked/Claud-ometer.exe` | Unpacked app for local smoke testing |

See [docs/electron-exe-packaging-design.md](./docs/electron-exe-packaging-design.md) for the packaging architecture and follow-up work.

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
   .\dist-electron\win-unpacked\Claud-ometer.exe
   ```

   Verify Overview loads, live/imported data controls render, session detail pages open, and closing the window stops the local server.

6. Smoke test the installer or portable executable from `dist-electron/`.
7. Publish the `.exe` artifacts and `latest.yml` if using updater metadata.
8. Create a git tag for the release, for example:

   ```bash
   git tag v0.1.0
   git push origin v0.1.0
   ```

Current release caveats: the Windows app is unsigned and uses the default Electron icon. Unsigned builds may trigger Windows SmartScreen warnings.

## Tech Stack

- **Next.js 16** (App Router, Turbopack)
- **TypeScript**
- **Tailwind CSS v4** + **shadcn/ui**
- **Recharts** for charts
- **SWR** for data fetching
- **Lucide** icons
- **Electron** + **electron-builder** for Windows desktop packaging

No database required. Reads `~/.claude/` files directly via Node.js API routes.

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
│   ├── claude-data/
│   │   ├── types.ts             # TypeScript interfaces
│   │   ├── reader.ts            # File parsers + aggregation
│   │   └── data-source.ts       # Live vs imported source
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
2. Click **Export as ZIP** to download all your Claude Code data
3. On another machine, upload the ZIP via **Import** to view the dashboard with that data
4. Toggle between **Live** (reads ~/.claude/) and **Imported** data at any time

## License

MIT
