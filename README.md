# ChatGPT Import

Import your ChatGPT data export into a Geode (or Obsidian) vault as Markdown notes. Desktop only.

**Status: Phase 1.** The parser and converter (`src/core/`) are built and tested. The plugin currently
registers one command, "Import ChatGPT export…", which only shows a notice that the import dialog
arrives in Phase 2. Nothing is written to your vault yet.

## Export your data from ChatGPT

1. In ChatGPT open **Settings > Data controls > Export data** and confirm.
2. OpenAI emails you a download link (it expires after about 24 hours). Download the ZIP.
3. Keep the ZIP as is. The importer reads it directly; you do not need to unzip it.

The ZIP contains `conversations.json` (or sharded `conversations-000.json`, `conversations-001.json`, ...
for large accounts), plus image/file attachments next to it.

## Vault mapping

| ChatGPT export | Vault |
| --- | --- |
| One conversation | One note: `ChatGPT/YYYY-MM-DD Title.md` (date is the conversation's creation date, UTC) |
| Title clash with a different file | ` (xxxxxxxx)` short id suffix is added before `.md` |
| Your messages | `## You` sections |
| ChatGPT replies | `## ChatGPT` sections, code blocks keep their language |
| System messages | Dropped |
| Tool/browsing/code-interpreter output | Folded into `> [!note]- Tool: <name>` callouts (or dropped, by option) |
| Images and files | Copied to `ChatGPT/attachments/` and embedded as `![[attachments/<file>]]` |
| Edits and regenerations | Only the active branch (root to `current_node`) by default; other branches can be included in collapsed `<details>` blocks |

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

### Re-importing is safe

`chatgpt_id` identifies a conversation. On re-import a note is

- **created** if no note has that id,
- **skipped** if it is identical to the last import,
- **updated** only if you have not touched it since the last import (its content still matches `chatgpt_import_hash`),
- **skipped as modified** if you edited it in any way, including frontmatter. Your edits are never overwritten.

Content types the importer does not understand are skipped and counted in a report rather than failing the import.

## Install (Geode)

Build, then copy `main.js` and `manifest.json` to `<vault>/.geode/plugins/threads-chatgpt-import/` and enable the
plugin in `<vault>/.geode/plugins.json`. For Obsidian, use `<vault>/.obsidian/plugins/threads-chatgpt-import/`.

## Develop

```bash
npm install --legacy-peer-deps   # npm 10's peer resolver crashes on the vitest/obsidian peer set without it
npm test
npm run typecheck
npm run build
```

`src/core/` has no Obsidian, Electron or DOM imports (only `node:crypto` and `yauzl`) so a CLI can reuse it.
ZIP reading uses [`yauzl`](https://github.com/thejoshwolfe/yauzl): it reads the central directory and then
extracts single entries on demand, so a multi-GB export is never held in memory (an in-memory unzipper such as
fflate's `unzipSync` would be). Each `conversations*.json` shard is parsed whole (shard-granular, not streamed),
which is why very large exports are sharded by OpenAI. A single shard over 128 MB is skipped and reported, and
`readEntry` refuses entries over 256 MiB by default; attachments should be copied with `copyEntryTo` / `openEntryStream`,
which stream and enforce the same limits on the bytes actually produced.

Imports are tolerant of bad data: out-of-range timestamps, unknown content or part types, duplicate conversation ids
(newest `update_time` wins) and malformed message trees (cycles, missing parents, extra roots) are counted in the
parse report instead of failing the run.
