# ChatGPT Import

Import your ChatGPT data export into a Geode (or Obsidian) vault as Markdown notes. Desktop only.

The importer reads the export ZIP directly (no unzipping), shows a dry-run preview of exactly what it
would do, and only writes to your vault when you press **Import**.

## Export your data from ChatGPT

1. In ChatGPT open **Settings > Data controls > Export data** and confirm.
2. OpenAI emails you a download link (it expires after about 24 hours). Download the ZIP.
3. Keep the ZIP as is.

The ZIP contains `conversations.json` (or sharded `conversations-000.json`, `conversations-001.json`, ...
for large accounts), plus image/file attachments next to it.

## Install (Geode)

Download `main.js`, `manifest.json` and `styles.css` from the latest GitHub release (the repository is private, so
use `gh release download --repo rbcodelabs/threads-chatgpt-import --dir <vault>/.geode/plugins/threads-chatgpt-import`),
then enable the plugin in `<vault>/.geode/plugins.json` or in Settings > Community plugins. For Obsidian, use
`<vault>/.obsidian/plugins/threads-chatgpt-import/`. To build from source instead:
`npm install --legacy-peer-deps && npm run build`.

## Use

1. Command palette: **Import ChatGPT export…**
2. Choose (or drop) the ZIP, set the options below, press **Preview import**.
3. Read the preview: how many notes will be created, updated or skipped (and why), the date range, how many
   attachments and how many bytes will be copied, content types that will be left out, and any notes renamed
   to avoid a name clash. Nothing has been written at this point.
4. Press **Import**. A progress bar shows each note; **Cancel** stops at the next note boundary (notes already
   written stay). The summary lists failures and warnings and has a button to reveal the destination folder.

### Options

Defaults live in **Settings > ChatGPT Import**; the dialog can override them for a single run.

| Option | Default | Effect |
| --- | --- | --- |
| Destination folder | `ChatGPT` | Vault folder for notes. Validated up front; absolute paths and `..` are rejected. Empty means the vault root. |
| Group by year-month | off | Notes go in `ChatGPT/YYYY-MM/` (by creation month; `undated` when unknown). |
| Include other branches | off | Edits and regenerations are kept in collapsed `<details>` blocks instead of dropped. |
| Import attachments | on | Copy images/files into `<folder>/attachments/` and embed them as `![[attachments/<file>]]`. |
| Tool and browsing output | callouts | Fold into `> [!note]- Tool: <name>` callouts, or leave out. |

### Continue in Agent Threads

With an imported note open, run **Continue in Agent Threads** from the command palette. It starts a new
[Agent Threads](https://github.com/rbcodelabs/agent-threads) thread whose first prompt points at the note, and opens it.
The command only appears for notes with a `chatgpt_id` in their frontmatter. Agent Threads is optional: if it is not
installed or enabled you get a notice and nothing else happens; the importer never depends on it.

## Vault mapping

| ChatGPT export | Vault |
| --- | --- |
| One conversation | One note: `ChatGPT/YYYY-MM-DD Title.md` (date is the conversation's creation date, UTC) |
| Title clash with a different file | ` (xxxxxxxx)` short id suffix is added before `.md` (names are compared case-insensitively) |
| Your messages | `## You` sections |
| ChatGPT replies | `## ChatGPT` sections, code blocks keep their language |
| System messages | Dropped |
| Tool/browsing/code-interpreter output | Folded into `> [!note]- Tool: <name>` callouts (or dropped, by option) |
| Images and files | Copied to `ChatGPT/attachments/` and embedded as `![[attachments/<file>]]` |
| Edits and regenerations | Only the active branch (root to `current_node`) by default |

Frontmatter on every note:

```yaml
---
title: "Planning a garden"
source: chatgpt
chatgpt_id: "..."          # stable key used for re-imports
model: "gpt-4o"
created: "2023-11-14T22:13:20.500Z"
updated: "2023-11-14T22:18:20.250Z"
tags: [chatgpt]
chatgpt_import_hash: "..." # sha256 of the note as imported
---
```

The note's modified time is set to the conversation's `update_time` where the host allows it (best effort).

### Re-importing is safe

`chatgpt_id` identifies a conversation (wherever you moved the note). On re-import a note is

- **created** if no note has that id,
- **skipped** if it is identical to the last import,
- **updated** only if you have not touched it since the last import (its content still matches `chatgpt_import_hash`),
- **skipped as modified** if you edited it in any way, including frontmatter. Your edits are never overwritten.

The check is repeated immediately before each write: the note is re-read and re-hashed, so an edit made (or a sync that
landed) after the preview is still respected.

### Attachments

Attachments live in one shared `attachments` folder, so a file used by several conversations is stored once. An
attachment is reused when an identical file (by SHA-256) already sits at the target path. A different file at the same
path (or a case-variant of it) is never overwritten: the new one gets a `-2`, `-3`, ... suffix and the note's embed is
rewritten to match. The vault API cannot stream, so each attachment is read into memory once (cap 128 MiB per file;
larger ones are skipped with a warning and the note is still written).

## Limitations

- **Shard-granular parsing.** Each `conversations*.json` shard is parsed whole, not streamed. OpenAI shards large
  exports for this reason. A single shard over 128 MB is skipped and reported, and conversations in it are not
  imported.
- Rendered notes are held in memory between the preview and the import, so a very large export needs RAM roughly
  proportional to the Markdown it produces.
- Content types the importer does not understand are skipped and counted in the preview rather than failing the import.
- Per-month index notes are not implemented.
- When an attachment had to be renamed, the stored import hash describes the rewritten note, so a later re-import
  reports that note as an update (harmless, same result) instead of unchanged.

## Develop

```bash
npm install --legacy-peer-deps   # npm 10's peer resolver crashes on the vitest/obsidian peer set without it
npm test
npm run typecheck
npm run build                    # writes main.js at the repo root
```

Layout:

- `src/core/` has no Obsidian, Electron or DOM imports (only `node:crypto` and `yauzl`) so a CLI can reuse it:
  parser, branch linearizer, Markdown converter, import planner, ZIP reader.
- `src/writer.ts` executes a plan through a small `VaultPort` interface; `src/vaultPort.ts` is the only file that
  maps that port onto the Obsidian Vault API. The writer is unit-tested against an in-memory fake vault.
- `src/session.ts` is the dry-run / import orchestration; `src/preview.ts` builds the preview numbers.
- `src/ImportModal.ts`, `src/SettingsTab.ts`, `src/main.ts` are the Obsidian-facing shell (not unit-tested).
- `src/agentThreads.ts` reaches Agent Threads' public API v1 through `app.plugins.plugins['claude-threads'].api.v1`.

ZIP reading uses [`yauzl`](https://github.com/thejoshwolfe/yauzl): it reads the central directory and then extracts
single entries on demand, so a multi-GB export is never held in memory. `readEntry` refuses entries over 256 MiB by
default.

Imports are tolerant of bad data: out-of-range timestamps, unknown content or part types, duplicate conversation ids
(newest `update_time` wins) and malformed message trees (cycles, missing parents, extra roots) are counted in the
parse report instead of failing the run.
