# @clipy/cli

> This repository is the public mirror of **`@clipy/cli`**. The package is developed in
> the Clipy monorepo and synced here with each npm release — browse the source or file
> issues here.

[![npm version](https://img.shields.io/npm/v/%40clipy%2Fcli)](https://www.npmjs.com/package/@clipy/cli)
[![license: MIT](https://img.shields.io/npm/l/%40clipy%2Fcli)](https://github.com/manovagyanik1/clipy-cli/blob/main/LICENSE)
[![node >= 18](https://img.shields.io/node/v/%40clipy%2Fcli)](https://www.npmjs.com/package/@clipy/cli)

The [Clipy](https://clipy.online) command line. List, search, and read your screen
recordings — transcripts, AI summaries, key moments — from the terminal, download the
MP4s, or export subtitles. No browser needed.

[Clipy](https://clipy.online) is a free screen recorder ([Chrome extension and Mac app](https://clipy.online/download),
plus a [web recorder](https://clipy.online/screen-recorder)) that gives every
recording an instant share link, an AI transcript and summary, and
[agent-readable context](https://clipy.online/for-agents) — so both humans and AI
agents can act on what was recorded. This package is its terminal client.

The read commands are **read-only** with any key. The write commands —
[`record`](#record), the `session`/`mark` flow, and `transcript --replace` — create
recordings or replace a transcript, and work only with an `ingest`-scoped key.

```bash
npx @clipy/cli agents install claude   # browser-approve login + install the Clipy skill
```

## Setup

```bash
clipy login
```

`clipy login` opens your browser to approve this device — like `gh auth login` — and
stores the key in `~/.config/clipy/config.json` (mode 0600). No copy-pasting a key.

Wiring up a coding agent? One command does both the browser login and the skill install:

```bash
npx @clipy/cli agents install claude   # or: codex / cursor
```

**Prefer to paste a key you minted yourself?** Create one at
**https://clipy.online/settings/api-keys** (it looks like `clipy_sk_live_…`) and store it
without the browser:

```bash
clipy login --key clipy_sk_live_…      # or: clipy login --paste to be prompted
```

**On SSH or a display-less Linux box**, `clipy login` automatically switches to a
copy-code flow (also available anywhere as `clipy login --no-browser`): it prints the
approval URL for you to open on **any** device — your laptop, your phone — and after you
click Approve the page shows a one-time code to paste back into the waiting terminal.
The code alone is useless without the PKCE verifier held by that terminal, so it's safe
to ferry by hand. Without a TTY at all (scripts, CI), use `CLIPY_API_KEY` or
`clipy login --key`.

## Commands

```text
clipy list [-n 20] [--page 2] [--status ready,processing] [--json]
clipy search <query>                 # full-text search titles + descriptions
clipy show <id|share-url>            # metadata + share link
clipy transcript <id> [--srt|--vtt]  # plaintext, or export subtitles
clipy summary <id>                   # TL;DR, key points, action items
clipy moments <id>                   # key moments: timestamps, captions, click coords
clipy context <id>                   # the full agent-context bundle as markdown
clipy download <id> [-o out.mp4]     # download the MP4
clipy open <id>                      # open the share page in your browser
clipy wait <id> --for both           # block until transcript/summary are ready
clipy record --url <app> [--for 15]  # record a web app headlessly → a Clipy recording
clipy session start --url <app>      # start recording in the background while you work
clipy mark "reproduced the bug"      # drop a live-timestamped note into the session
clipy session stop                   # finish + upload; your marks become the transcript
clipy mcp                            # run the Clipy MCP server (npx -y @clipy/mcp)
```

Every recording-reading command accepts either the bare public id (`3kelcef8wo8h`) or the
full share URL (`https://clipy.online/video/3kelcef8wo8h`).

## Record

`clipy record` captures a web app in a **headless** browser and uploads it as a Clipy
recording — no display needed, so it works in CI and cloud sandboxes. Made for agents:
build a feature, then record the running app so it can be shared or read back.

```bash
# Record a running app for 20s, wait for the transcript, print the links
clipy record --url http://localhost:3000 --for 20 --wait
```

It needs two things beyond a normal install:

1. **Playwright** (kept out of the base install so the read-only commands stay tiny):
   ```bash
   npm install -g playwright && npx playwright install chromium
   ```
2. An API key with the **"Record & upload" (ingest)** permission — pick it when you
   create the key at [clipy.online/settings/api-keys](https://clipy.online/settings/api-keys).

Flags: `--for <sec>` (record duration after load, default 15; per viewport), `--title <t>`
/ `--description <d>`, `--viewports mobile,tablet,desktop` (or `390x844,1440x900` — records
every size sequentially into ONE video with a transcript chapter per pass),
`--note "12: opened settings"` (repeatable timestamped narration notes),
`--width`/`--height` (viewport + video size, default 1280×720), `--wait` (block until the
transcript is ready), `--json` (print `{id, shareUrl, contextUrl, sizeBytes}`).

**Narration = the transcript.** Headless captures have no audio, so Clipy uses your
notes (and session marks, below) as the recording's transcript, summary input, and
agent-context — clearly marked as agent narration, never passed off as speech-to-text.

## Session mode — you work, Clipy records

For recordings where an agent (or you) drives the app live, don't script the capture:
start a session, work normally, and narrate with marks as you go.

```bash
clipy session start --url http://localhost:3000 --title "Settings overflow fix"
# … drive the app with your own tools …
clipy mark "reproduced the overflow on the settings page"
clipy mark "after the fix: the sidebar wraps correctly"
clipy session stop        # closes the browser, uploads, prints the share link
```

The session records in a detached background daemon, so every command returns
immediately. `clipy mark` stamps notes against the live recording clock; navigations and
console errors are added automatically as `[auto]` marks. One session per directory.

Safety rails are built in: the session **auto-stops and uploads** at `--max <sec>`
(default 600, hard cap 1800) so a forgotten session can never run away; `clipy session
abort` discards everything; a crashed daemon is detected and cleared on the next command;
corrupt captures are refused before upload, and a failed upload keeps the local file.

## Record the real screen — a window, a display (Mac)

`--source mac-screen` on `record` / `session start` records through the **running Clipy
Mac app** (ScreenCaptureKit — real screen, real logged-in browser, not a headless page).
First use shows a consent dialog in the app; the recording indicator is always visible.

By default it captures the primary display. Target one window instead:

```bash
clipy sources                                   # list displays + windows with ids
clipy session start --source mac-screen --window "Chrome" --title "Fix walkthrough"
# … the agent drives the real, logged-in Chrome while Clipy records that window …
clipy mark "reproduced the bug"
clipy mark "fix applied — retesting"
clipy session stop                              # uploads, prints the share link
```

`--window` takes a window id from `clipy sources`, or an app/title substring
(case-insensitive; ambiguous matches list the candidates instead of guessing).
`--display <id>` records a specific display. Both also work on one-shot
`clipy record --source mac-screen --for 30`.

## Scripting

`--json` prints the raw API response for `list`, `search`, `show`, `transcript`,
`summary`, `moments`, and `wait`:

```bash
# Newest recording's id
clipy list -n 1 --json | jq -r '.recordings[0].id'

# Export subtitles for a recording
clipy transcript 3kelcef8wo8h --srt > recording.srt

# Record with anything, then block until Clipy finished transcribing
clipy wait 3kelcef8wo8h --for both && clipy summary 3kelcef8wo8h
```

Exit codes: `0` ok · `1` error · `2` usage · `3` artifact not ready yet.

## Configuration

| Setting  | Flag        | Env             | Stored (via `clipy login`)     |
| -------- | ----------- | --------------- | ------------------------------ |
| API key  | `--key`     | `CLIPY_API_KEY` | `~/.config/clipy/config.json`  |
| API base | `--api-url` | `CLIPY_API_URL` | `~/.config/clipy/config.json`  |

Precedence: flag → env → stored config.

## For AI agents

If you're wiring Clipy into an MCP-capable agent (Claude Code, Cursor, Codex, …),
use the [`@clipy/mcp`](https://www.npmjs.com/package/@clipy/mcp) server instead — same
API, but with agent-native tools and inline key-moment frames
([source](https://github.com/manovagyanik1/clipy-mcp) ·
[setup docs](https://clipy.online/docs/mcp)). `clipy mcp` is a shortcut that runs it.

Also: every **public** Clipy watch link is agent-readable without any install — append
`.md` to it (`https://clipy.online/video/<id>.md`) and it serves a markdown context
document with the summary, key moments, and transcript. Details at
[clipy.online/for-agents](https://clipy.online/for-agents).

## Links

- Website: [clipy.online](https://clipy.online) · [free online screen recorder](https://clipy.online/screen-recorder)
- CLI docs: [clipy.online/docs/cli](https://clipy.online/docs/cli)
- MCP server: [`@clipy/mcp`](https://www.npmjs.com/package/@clipy/mcp) · [docs](https://clipy.online/docs/mcp) · [source](https://github.com/manovagyanik1/clipy-mcp)
- Free browser tools (converters, GIF makers, downloaders): [clipy.online/tools](https://clipy.online/tools)
- API keys: [clipy.online/settings/api-keys](https://clipy.online/settings/api-keys)

## License

MIT © [Codersera](https://codersera.com)
