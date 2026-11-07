# dsh-bili-learn · Turn Bilibili videos into reusable, evidence-linked knowledge

[中文](README.zh-CN.md) · English

This is **not** a video summarizer. It reads a video into **knowledge cards anchored to timestamps**, and then — in *later* sessions — retrieves them, drills them with spaced repetition, and assembles them into a reusable skill.

The difference in one line: a summary loses the evidence; here every claim carries "the original sentence + the second it was said + a link that jumps back to it".

```
[00:53] "these are only the model's outputs" → https://www.bilibili.com/video/BV1sLtm61Egx?t=53
```

## Why it is built this way

| Usual problem | What this plugin does |
|---|---|
| You forget it after watching, and the summary has nothing to verify against | Every card must carry `evidence: [{t, quote}]`; clicking it jumps to that second of the video |
| Learned but never used | `bili_recall` pulls relevant cards before a related task; `bili_practice` schedules spaced-repetition reviews |
| The real payload is on screen (prompts, parameters, UI), not in the subtitles | `bili_frame` extracts frames at given seconds and hands them to a local vision model — subtitles never contained them |
| Knowledge stays scattered and un-reusable | `bili_skill` compiles several videos' cards into a `SKILL.md`, every rule linked back to its source |
| Locked to one vendor's model | The card-extraction model is configurable (defaults to the current session model; can point at a fully local model) |

## The 10 tools

| Tool | Purpose |
|---|---|
| `bili_search` | Search candidate videos (title, uploader, duration, view count) to decide what to learn |
| `bili_learn` | Fetch metadata + subtitles → segment → extract knowledge cards into the local knowledge base; `pages` / `all_pages` batch multi-part videos |
| `bili_series` | Same uploader, same tutorial series: `find` / `list` / `next` / `learn` / `cluster` |
| `bili_recall` | Search what you already learned; returns cards and transcript evidence with timestamps and jump-back links |
| `bili_practice` | Review loop: `due` lists cards due, `grade` records ok/miss and updates mastery plus the next review time |
| `bili_note` | Write your own cards to override automatic extraction (`evidence` timestamps required) |
| `bili_status` | Knowledge-base overview: videos learned, card counts, reviews due, warnings |
| `bili_login` | QR login: render QR → poll → write the session cookie into `cookieFile` |
| `bili_frame` | Extract frames at specific seconds to local images, for reading on-screen text with a vision model |
| `bili_skill` | Assemble learned knowledge into a `SKILL.md` skill (frontmatter, grouped body, every rule carrying an evidence link) |

## Learning a whole series (same uploader, same collection)

Tutorials rarely arrive as a single video. `bili_series` lets the agent walk the collection itself instead of you pasting links one by one.

```jsonc
// 1) give any episode → find the collection it belongs to, list every episode, mark learned / unlearned
{ "action": "find", "url": "BVxxxxxxxxxx" }
// → key=season:1234567, total=22, learned=1, missing=21, next=#1 …

// 2) learn the next episodes in collection order (default 3, max 10; already-learned ones are skipped)
{ "action": "learn", "url": "BVxxxxxxxxxx", "limit": 3 }

// 3) what else does this uploader have?
{ "action": "list", "mid": 123456789 }

// 4) fallback when the video is not in any collection: cluster by title prefix
{ "action": "cluster", "keyword": "some tutorial", "owner": "some-uploader" }
```

Measured facts baked into the implementation:

- `view` no longer returns `ugc_season.sections[].archives` — it comes back `undefined`. Collection contents must come from `seasons_archives_list`, which is paginated and preserves the collection's own order (`index` starts at 1).
- Learned state is never duplicated: `index.series[key].episodes` stores only the episode list; whether an episode is learned is computed from `index.videos`.
- Episodes learned through a series carry a `series` tag, so `bili_recall` can be scoped with `{"series":"season:1234567"}` and `bili_skill` can compile the whole series into one skill with `{"series":"season:1234567"}`.
- `bili_status` reports `learned/total` and the next episode for every series; the injected system-prompt index carries the same line, so a fresh session already knows what is still missing.
- `cluster` is a heuristic fallback only (it strips 【】 brackets, parentheses and episode numbers, then groups by title prefix). A real collection always wins.

## Multi-part videos: one directory per page

A single `bvid` can hold dozens of parts. **Every part gets its own directory**: P1 stays `<bvid>/` (existing data is untouched), P2 becomes `<bvid>_p2/`. Before this, learning P2 overwrote P1's `cards.md` / `transcript.md` outright.

```jsonc
// batch learning (a course may have 35 parts — batching is usually wiser)
{ "url": "BVxxxxxxxxxx", "pages": [1, 2, 3] }
{ "url": "BVxxxxxxxxxx", "all_pages": true }
```

Consequences worth knowing:

- `bili_note` and `bili_practice grade` take a `page` (default 1); `bili_practice due` without `page` spans every learned part of that bvid.
- `bili_recall` with a `bvid` searches across parts, and jump links carry `?p=` for P2 and beyond.
- `bili_skill` given that bvid compiles **all learned parts into one skill**, sources labelled by part.
- `bili_status` and the injected index show `BVxxx P2`.

Measured on a 35-part course: learn P1 (15 cards), then `pages:[2,3]` → P1's 15 cards and 929 transcript lines survive untouched; re-learning P1 returns `skipped` and changes nothing.

## Install

1. Put `dsh-bili-learn/` into your DSH plugin directory (or install it through the plugin manager). The plugin registers itself via `cordis.patch.yml`; startup-scoped profiles need a restart.
2. Key configuration (under `config` in `cordis.patch.yml`):

| Key | Default | Notes |
|---|---|---|
| `kbDir` | empty = `$DSH_HOME/bili-kb` | Knowledge-base root directory |
| `cookie` | empty | Full browser cookie, or just `SESSDATA`. **Required to read subtitles** |
| `cookieFile` | empty = `<kbDir>/cookie.txt` | Keep the cookie in a file; **re-read on every call**, so swapping it needs no restart |
| `cookiesFromBrowser` | `edge` | Let yt-dlp read the browser's session. A running browser locks its cookie DB — quit it fully first |
| `distill` / `distillProvider` / `distillModel` | `true` / empty / empty | Which model extracts cards; empty = the current session model (a local one works) |
| `segmentMinutes` / `maxCardsPerSegment` | `8` / `5` | Segment length and per-segment card cap |
| `distillMaxTokens` | `2500` | Short output plus one retry (reasoning models blow up on long outputs) |
| `maxLearnMinutes` | `0` | `0` = whole video; `>0` = only the first N minutes |
| `injectIndex` | `true` | Inject a compact index of "what has been learned" into the system prompt |
| `qrPython` / `qrPng` | `python` / empty | QR rendered locally — **the login token never goes to any third party** |
| `ffmpeg` | empty | Falls back to `ffmpeg` on `PATH`, then to the bundled `imageio-ffmpeg` binary |
| `skillsDir` | empty = `<kbDir>/../skills` | Where `bili_skill` writes skills |

## Login (the precondition for subtitles)

Bilibili does not serve subtitle tracks to anonymous requests. Two ways in:

1. **Recommended: `bili_login`.** `action=start` renders a QR PNG locally; scan it with the Bilibili mobile app; `action=poll` writes the session cookie into `cookieFile`. No password, no browser needed.
2. Fill `cookie` or write `cookieFile` yourself. **Do not use `document.cookie`**: `SESSDATA` is HttpOnly and invisible to the console — without it, subtitles stay unavailable.

> ⚠️ **Security**: `cookie.txt` is the key to your account (it holds `SESSDATA` and `bili_jct`). It is excluded by `.gitignore`, but please use a secondary account, never commit it anywhere, and if you suspect a leak, log out on Bilibili immediately to rotate the session.

## A real loop (sample included in this repo)

```
bili_search  →  pick the tutorials
bili_learn   →  5 videos, 27 timestamped cards
bili_recall  →  pull the relevant cards before writing prompts
bili_skill   →  produce skills/h3-blocking-performance/SKILL.md
```

`skills/h3-blocking-performance/SKILL.md` in this repo is the output of exactly that chain: a reusable rule sheet on blocking, shot-to-shot continuity and performance for AI-generated video. Every rule links back to its source video at a timestamp, and conclusions that came from our own local render tests are labelled as such.

`examples/bili-kb/` shows what one learned video looks like on disk:

```
examples/bili-kb/BV1tRxt68EZa/
  source.json     metadata (title, uploader, duration, subtitle tracks)
  segments.json   segment boundaries
  outline.md      per-segment outline
  cards.md        knowledge cards (claim / why / how / evidence timestamps)
  cards.json      machine-readable version of the same
  study.md        study summary and coverage report
```

**The full transcript (`transcript.md` / `transcript.json`) is deliberately not published** — it is a complete transcription of a third party's video and belongs to its uploader. The cards keep only the short quotations they need.

## Tests

```bash
node tests/selftest.mjs   # PASS 47 checks   pure functions and knowledge-base gates (series progress + per-page isolation)
node tests/tool-test.mjs  # PASS 10 tools    drives the real tools with a fake ctx, checks lossless output
```

CI runs the first gate on every push; the second one touches the live Bilibili API, so it is allowed to fail on datacenter IPs (see [`.github/workflows/ci.yml`](.github/workflows/ci.yml)). Release notes live in [CHANGELOG.md](CHANGELOG.md).

## Privacy

This repository contains no cookies, account IDs, session tokens or machine-specific absolute paths. Commit history uses a GitHub noreply address.
`.gitignore` covers `cookie.txt`, `**/bili-kb/` (except the sample directory), `.out/` and `*.log`.

## License

Code and documentation are licensed under [CC BY-NC 4.0](LICENSE) (attribution, non-commercial).Quotations of third-party videos inside cards and skills are **short excerpts with timestamps and back-links**; copyright of that underlying content stays with the respective uploaders. If you consider an excerpt out of bounds, open an issue and it will be removed after review.
