# @clipy/cli

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
clipy mark "on redemptions" --assert-url '**/redemptions'   # assert what you claim
clipy chapter "AFTER — fix applied"  # split the recording into before/after sections
clipy session run --url <app> -- npm run demo   # start, run a command, auto stop/abort
clipy session stop                   # finish + upload; your marks become the transcript
clipy doctor                         # health check: key, Mac bridge, Playwright, install mode
clipy playwright-path                # node_modules dir of the Playwright this CLI resolves
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
/ `--description <d>`, `--type <kind>` (what the recording IS — see below),
`--viewports mobile,tablet,desktop` (or `390x844,1440x900` — records every size sequentially
into ONE video with a transcript chapter per pass), `--note "12: opened settings"` (repeatable
timestamped narration notes), `--width`/`--height` (viewport + video size, default 1280×720),
`--wait` (block until the transcript is ready), `--json` (print `{id, shareUrl, contextUrl, sizeBytes}`).

**`--type <kind>` declares what the recording is** so the AI summary reads it correctly (a demo
isn't a bug report). Accepts `bug_report`, `feature_request`, `product_demo`,
`walkthrough_tutorial`, `feedback_review`, `discussion_talk`, `other` — and the short aliases
`bug`, `feature`, `demo`/`product`, `walkthrough`/`tutorial`/`guide`, `feedback`/`review`,
`discussion`/`talk`/`meeting`. An unrecognized value is a usage error. (Applied on the web path
today; `--source mac-screen` support is pending a Clipy app update.)

**Note timestamps.** A `--note` is absolute by default (`"12: opened settings"` → 12s).
With `--viewports`, anchor a note to a pass instead so it can't drift when load time
shifts the pass boundaries: `--note "pass2: mobile layout"` lands at the real start of
pass 2, and `--note "pass2@5: after scrolling"` lands 5s into it. Recording starts the
note clock on the first non-blank frame (up to a 10s wait), so `"0: …"` isn't pinned to a
still-compiling dev server's blank screen.

**Narration = the transcript.** Headless captures have no audio, so Clipy uses your
notes (and session marks, below) as the recording's transcript, summary input, and
agent-context — clearly marked as agent narration, never passed off as speech-to-text.

### Recording a logged-in app

**If something is driving the browser — prefer that.** Clipy is a recorder, not a driver.
When an agent (or you) drives a real, already-logged-in browser, don't hand Clipy the
credentials at all: record the real screen and attach evidence as you go.

```bash
clipy session start --source mac-screen --window "Chrome" --title "PR-1234 verification"
clipy mark "redemptions tab active" --observed "tab=Redemptions, rows=14" --verdict pass
clipy chapter "AFTER — fix applied"
clipy session stop
```

No auth to reproduce, no credentials in flags, and the recording shows the real app.

**The flags below are the agentless / CI fallback** — for a one-shot `clipy record` in CI,
or a headless session nothing is steering, where Clipy needs its own logged-in context.
Seed the session **before** the browser navigates — Clipy applies all of these to the
Playwright context ahead of the first page load, so the app's route guard sees the auth
state on first paint (seeding `localStorage` *after* visiting a guarded route loses that
race and bounces you to `/login`). They apply to headless web capture on `record` and
`session start`; they're rejected on `--source mac-screen` (which records the real,
already-logged-in screen).

- `--storage-state <file>` — a Playwright [`storageState`](https://playwright.dev/docs/auth)
  JSON (cookies + per-origin `localStorage`), passed straight to `browser.newContext()`.
  The easiest path: log in once with Playwright and save `context.storageState({ path })`,
  then hand that file to Clipy. Its contents are never printed or logged.
- `--cookie "name=value[; Domain=d; Path=p; Secure; HttpOnly; SameSite=Lax]"` — set one
  cookie (repeatable). Without a `Domain` it's scoped to the target URL; with one it's
  domain-scoped.
- `--local-storage "key=value"` — set one `localStorage` pair for the target origin
  (repeatable).
- `--init-script <file>` — run a JS file in every page before its own scripts (e.g. to
  stub a feature flag or inject a token).
- `--user-data-dir <dir>` — launch a **persistent** Chromium profile from the user-data
  **root** `dir` (`launchPersistentContext`), so the recording carries that profile's
  whole logged-in identity. Web only; **mutually exclusive with `--storage-state`** (a
  profile already carries its own storage). `--cookie` / `--local-storage` / `--init-script`
  still compose. Pass the **root**, not a profile subdir — Clipy refuses a `Default`/`Profile N`
  directory and tells you the parent dir + `--profile-directory` to use. In direct mode
  (no `--profile-directory`) it also refuses a live-locked root (`SingletonLock`/`SingletonSocket`).
- `--profile-directory "<name>"` — with `--user-data-dir`, select a **named** profile
  (e.g. `Profile 12`, from `chrome://version` → "Profile Path"). Because Playwright can't
  select a named profile in place, Clipy **copies** that profile into a temporary recording
  root and launches the copy — **loudly** (it prints what it's copying and the size). Your
  real profile is never opened or written, and the copy is deleted after upload. No need to
  quit Chrome (Clipy warns if it's running, since in-use databases may copy inconsistently —
  quit it for a guaranteed-clean copy).

> **⚠ macOS: a copied Chrome profile can open silently signed out.** Chrome encrypts its
> cookies with a Keychain key scoped to *Chrome Safe Storage*; the recorder runs
> Playwright's **Chromium**, which reads *Chromium Safe Storage*. So a copied real-Chrome
> profile may open looking like you — bookmarks, preferences, `localStorage` all intact —
> while every cookie-based login is gone. `localStorage`/`Preferences`-based sessions
> survive; cookie sessions may not. Clipy prints this warning before recording whenever
> copy mode runs on macOS. **If the recording lands logged out, this is why** — use
> `--source mac-screen` with your real browser, or the agent-driven path (drive your own
> browser and attach evidence with `--observed`/`--verdict`).

```bash
# Reuse a saved Playwright login
clipy record --url https://app.example.com/dashboard --for 20 \
  --storage-state ./auth.json

# Or seed a token directly
clipy record --url https://app.example.com/dashboard \
  --local-storage "authToken=eyJ…" --cookie "sid=abc; Domain=app.example.com; Secure"

# Or record your real logged-in Chrome profile (copied, never modified)
clipy record --url https://app.example.com/dashboard --for 20 \
  --user-data-dir "$HOME/Library/Application Support/Google/Chrome" \
  --profile-directory "Profile 12"
```

#### The auth boundary

`--storage-state` seeds only the cookies and `localStorage` the **file contains** — it
can't conjure a whole browser identity, so an app that also needs cross-origin or
auth-host cookies (SSO, a separate API domain) can still bounce to `/login`. Three
reliable ways to get a real logged-in recording:

1. **Produce the state file with a real interactive login** (it captures cross-domain
   cookies a hand-built file misses):
   ```bash
   npx playwright open --save-storage=auth.json https://login.example.com
   # sign in, close the window, then:
   clipy record --url https://app.example.com/dashboard --storage-state auth.json
   ```
2. **Your real Chrome profile, copied:** `--user-data-dir "<chrome user-data root>"
   --profile-directory "<name>"` (name from `chrome://version`). Clipy copies that profile
   to a temp root and records the copy — no manual export, and your real profile is untouched.
3. **`--source mac-screen --window "Chrome"`** — record your real, already-logged-in
   Chrome window through the Mac app; there's no headless auth to reproduce at all.

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

**Drive the recorded browser (opt-in).** Pass `--expose-cdp` to `session start` and the
daemon's headless Chromium opens a CDP endpoint you can attach to and drive navigation, clicks,
and viewport while Clipy records the same page. It's **off by default** — while it's open, any
local process can attach to and control that browser, so only enable it when you intend to drive
the session. `clipy session start --expose-cdp` prints the endpoint (and `session start --json`
/ `session status --json` return it as `cdpHttpUrl` / `cdpUrl`, also written to the `0600`
session state file). The env var `CLIPY_DISABLE_CDP=1` is a hard kill switch that overrides the
flag.

```bash
clipy session start --url http://localhost:3000 --expose-cdp --title "Overflow fix"
```

```js
const { chromium } = require("playwright");
const browser = await chromium.connectOverCDP(cdpHttpUrl); // from `clipy session status --json`
const page = browser.contexts()[0].pages()[0];             // the page being recorded (a NEW context is not captured)
await page.goto("http://localhost:3000/settings");         // navigate / click / fill as usual

// page.viewportSize() is null over a CDP attach — resize via the device-metrics override:
const cdp = await browser.newCDPSession(page);
await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });

await browser.close();                                     // detaches; the recording keeps going
```

Four things that otherwise cost a debugging round: attach with `connectOverCDP`; the
recorded page is `browser.contexts()[0].pages()[0]` (a brand-new context/page you open
won't be captured); `page.viewportSize()` is `null` on a CDP attach; and a resize needs a
CDP `Emulation.setDeviceMetricsOverride`, not `setViewportSize`. Your driver script
resolves Playwright from **its own** directory — if `require("playwright")` can't find it,
run the script with `NODE_PATH=$(clipy playwright-path) node driver.js`.

**In-page marks (zero spawn latency).** While `--expose-cdp` is on, the daemon also exposes
`window.__clipyMark("text", opts?)` and `window.__clipyChapter("label")` in the recorded
page. Calling them from your driver emits a mark/chapter *without* spawning a `clipy mark`
process, so it lands exactly when your code runs, and it runs **daemon-side with the page in
hand**. `__clipyMark`'s second argument takes the same assertions as the CLI flags —
evaluated and annotated ✓/✗ identically:

```js
await page.evaluate(() => window.__clipyMark("clicked Export"));
await page.evaluate(() =>
  window.__clipyMark("status is Active", {
    assertSelector: ".status-badge",
    assertText: "Active",     // needs assertSelector — otherwise the call rejects
    assertUrl: "**/redemptions", // optional
    failMode: "abort",           // optional; "warn" is the default
  }),
);
```

It returns the annotated `{ tMs, text, assert }`; `failMode: "abort"` discards the session
just like the flag. These marks land in the same transcript and count toward the same
200-mark cap. Note: while CDP is exposed the page's **own** scripts can call these too —
the same trust boundary as `--expose-cdp` itself (any local process can already drive the
browser), so only enable it when you intend to drive the session.

`session start` also accepts the same auth flags as `record`
(`--storage-state` / `--cookie` / `--local-storage` / `--init-script`) to record a
logged-in app; see [Recording a logged-in app](#recording-a-logged-in-app).

Safety rails are built in: the session **auto-stops and uploads** at `--max <sec>`
(default 600, hard cap 1800) so a forgotten session can never run away; `clipy session
abort` discards everything; a crashed daemon is detected and cleared on the next command;
corrupt captures are refused before upload, and a failed upload keeps the local file.

### Evidence marks — two provenances, never pooled

A plain mark is an unverified claim: an agent can write `clipy mark "the Redemptions
tab is active"` whether or not it is, and the transcript reads as authoritative either
way. Evidence marks fix that — in one of two ways, and Clipy **labels which**, so a
claim you attested can never be read as something Clipy checked.

**Driver-attested — you brought the browser.** Clipy is a recorder, not a driver: when
you're driving a real browser with your own tooling (or recording the screen), attach the
values you observed and your verdict.

```bash
clipy mark "redemptions tab active" --observed "tab=Redemptions, rows=14" --verdict pass
clipy mark "totals still stale"     --observed "total=\$0.00 (expected \$412.50)" --verdict fail
```

Stored as `redemptions tab active [ASSERT ✓ driver-attested; observed=tab=Redemptions, rows=14]`
(or `✗`). Both flags are required together, a mark carries exactly **one** provenance
(mixing with `--assert-*` is a usage error), and this works in **every** session type —
including `--source mac-screen`.

> **The honesty rule:** driver-attested means Clipy vouches that the agent **said** it,
> not that Clipy verified it. Put real observed values in `--observed` — the point of the
> ledger is that a reviewer can check the attestation against the video.

**Clipy-verified — Clipy owns the page.** In a headless web session the daemon owns the
live Playwright page, so it can check the claim against the real DOM itself:

```bash
# Assert a URL (globs: ** = anything, * = any non-slash segment, no * = substring)
clipy mark "opened the redemptions tab" --assert-url "**/redemptions"

# Assert an element exists and contains text
clipy mark "status flipped to Active" --assert-selector ".status-badge" --assert-text "Active"
```

- **Pass** → `status flipped to Active [assert ✓ verified-by-clipy; .status-badge="Active"]`
  and the CLI prints a green `✓`.
- **Fail** → `status flipped to Active [ASSERT ✗ verified-by-clipy; expected "Active"; observed .status-badge="Pending"]`
  and the CLI prints a red `✗`. The wrong claim is preserved *as a failed assertion*, not
  as a fact.

`--assert-selector <css>` checks an element matches (its trimmed text becomes the
`observed` value); `--assert-text <substr>` requires that element's text to contain a
substring (it needs a selector); `--assert-url <glob>` matches the page URL. Combine them
freely — all provided checks must pass. These need a Clipy-owned page, so they're rejected
on `--source mac-screen` (use `--observed`/`--verdict` there).

`--fail-mode` decides what a failed assertion does: `warn` (default) records the `✗` and
keeps recording; **`abort` discards the whole session** — nothing is uploaded and the CLI
exits non-zero, so a driver that asserts its way to a broken state doesn't ship a misleading
clip.

The leading `[verification]` note reports the two provenances as **separate segments** and
never pools them:

```text
[verification] 2 clipy-verified: 1 passed, 1 failed, 1 unverified · 3 driver-attested: 2 passed, 1 failed
```

An empty segment is omitted; with only clipy-verified marks the rendering stays the legacy
`N assertion(s): P passed, F failed[, K unverified]`.

**A mark is never dropped, and a late verdict never rewrites it.** If the daemon can't be
reached to evaluate an assertion — its event loop briefly starved during a heavy dev-server
recompile, say — `clipy mark` doesn't fail and lose the note. It records the narration
anyway, tags it `[ASSERT ⚠ could not evaluate — <reason>]`, prints a loud `⚠`, and exits 0.
An unverified claim is flagged as unverified (the `K` in the tally), never silently promoted
to a `✓`. That ⚠ is the **mark of record**: if the daemon was only slow (not gone) and
evaluates the same claim a moment later, that verdict judged a *later* page state, so it does
**not** overwrite the ⚠. It's recorded as a separate, honestly-timestamped
`[late check of "…" — evaluated Ns after the claim: …]` note at the moment it actually ran,
and it counts toward neither passed, failed, nor unverified. (Plain, non-asserted marks that
the daemon later processes are simply deduped — they appear exactly once.)

Assertions evaluate against a real page, so they need a **web** session (they're rejected on
`--source mac-screen`, which records the real screen with no page to probe).

### Before/after in one recording — `clipy chapter`

`clipy chapter "<label>"` drops a section boundary so a single video can carry both a
BEFORE and an AFTER state — exactly the shape of a PR-review recording:

```bash
clipy session start --url http://localhost:3000/settings --title "Sidebar overflow fix"
# … demo the bug on the base branch …
clipy mark "sidebar overflows on mobile" --assert-selector ".sidebar.is-overflowing"
clipy chapter "AFTER — fix applied"
# … git switch fix-branch, restart the dev server, reload …
clipy mark "sidebar wraps correctly" --assert-selector ".sidebar:not(.is-overflowing)"
clipy session stop
```

### `session run` — crash-safe wrapping

If a driver script crashes mid-session, a plain `session start` keeps recording dead air
up to `--max` and then uploads it. `session run` wraps a command so cleanup is guaranteed:

```bash
clipy session run --url http://localhost:3000 --expose-cdp -- node driver.js
```

It starts the session, runs everything after `--` with inherited stdio, and then: **exit 0
→ `session stop`** (upload + share link); **any non-zero exit or a signal → `session abort`**
(discard) and the child's exit code is propagated. The command runs with `CLIPY_SESSION=1`,
`CLIPY_SESSION_FILE=<path>`, and (when `--expose-cdp`) `CLIPY_CDP_URL=<cdpHttpUrl>` in its
environment. `Ctrl-C` is forwarded to the child, then the session is discarded. All the
`session start` flags (`--url`, `--title`, `--max`, `--type`, `--expose-cdp`, auth flags)
apply before the `--`.

`clipy mark` / `clipy chapter` resolve the session from `CLIPY_SESSION_FILE` first and the
current directory second — so a driver you launch with `session run` can shell out
`clipy mark …` from **any working directory** and still hit the right session, instead of
failing with "no recording session in this workspace".

### Backdating a mark

Each `clipy mark` is a short process spawn (~100–300 ms), so a mark can land slightly after
the state it describes. Backdate it onto the recording clock:

```bash
clipy mark "the toast appeared" --ago 2     # 2 seconds before now
clipy mark "page finished loading" --at 4   # at an absolute 4s on the recording clock
```

Backdating an **asserted** mark is a subtlety: the mark lands at the backdated time, but the
assertion still judges the **live** page (the daemon can't rewind). When the verdict was
observed more than 2 s from the backdated position, the mark stays where you put it and the
text gains `(assertion observed Ns after this backdated mark — the verdict describes the page
at observation time)`, with a signed `assert.driftSec` in `--json` — so a ✓/✗ is never read
as describing the earlier moment. Live-clock asserted marks and backdated plain marks are
unaffected.

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

Every command has machine-readable output. `--json` is supported on **`list`, `search`,
`show`, `transcript`, `summary`, `moments`, `wait`, `record`, `session start/stop/status`,
`mark`, `chapter`, `doctor`, and `playwright-path`** — stdout is the JSON payload, stderr is progress
and hints, and errors exit non-zero with a message on stderr prefixed `error:`. For the
full capability manifest (every command, flag, env var, and exit code) run
`clipy guide --json`.

```bash
# Newest recording's id
clipy list -n 1 --json | jq -r '.recordings[0].id'

# Export subtitles for a recording
clipy transcript 3kelcef8wo8h --srt > recording.srt

# Record headlessly and capture the share link
clipy record --url http://localhost:3000 --for 20 --json | jq -r '.shareUrl'

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
