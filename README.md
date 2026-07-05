# @clipy/cli

The [Clipy](https://clipy.online) command line. List, search, and read your screen
recordings — transcripts, AI summaries, key moments — from the terminal, download the
MP4s, or export subtitles. No browser needed.

[Clipy](https://clipy.online) is a free screen recorder ([Chrome extension and Mac app](https://clipy.online/download),
plus a [web recorder](https://clipy.online/screen-recorder)) that gives every
recording an instant share link, an AI transcript and summary, and
[agent-readable context](https://clipy.online/for-agents) — so both humans and AI
agents can act on what was recorded. This package is its terminal client.

It is **read-only**: it can never create, edit, or delete your recordings.

```bash
npx @clipy/cli list          # or: npm i -g @clipy/cli && clipy list
```

## Setup

1. Create a free API key at **https://clipy.online/settings/api-keys** (it looks like
   `clipy_sk_live_…`). Copy it — it's shown only once.
2. Log in (stores the key in `~/.config/clipy/config.json`, mode 0600):

```bash
clipy login
```

Or skip the stored login entirely and set `CLIPY_API_KEY` in your environment.

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
clipy mcp                            # run the Clipy MCP server (npx -y @clipy/mcp)
```

Every recording-reading command accepts either the bare public id (`3kelcef8wo8h`) or the
full share URL (`https://clipy.online/video/3kelcef8wo8h`).

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
