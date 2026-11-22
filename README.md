# dsh-bili-learn · Turn Bilibili videos into reusable, evidence-linked knowledge

[中文](README.zh-CN.md) · English

This is **not** a video summarizer. It reads a video into **knowledge cards anchored to timestamps**, and then — in *later* sessions — retrieves them, drills them with spaced repetition, and assembles them into a reusable skill.

The difference in one line: a summary loses the evidence; here every claim carries "the original sentence + the second it was said + a link that jumps back to it".

```
[00:53] "these are only the model's outputs" → https://www.bilibili.com/video/BVDEMO000001?t=53
```

## Why it is built this way

| Usual problem | What this plugin does |
|---|---|
| You forget it after watching, and the summary has nothing to verify against | Every card must carry `evidence: [{t, quote}]`; clicking it jumps to that second of the video |
| Learned but never used | `bili_recall` pulls relevant cards before a related task; `bili_practice` schedules spaced-repetition reviews |
| The real payload is on screen (prompts, parameters, UI), not in the subtitles | `bili_frame` extracts frames at given seconds and hands them to a local vision model — subtitles never contained them |
| Knowledge stays scattered and un-reusable | `bili_skill` compiles several videos' cards into a `SKILL.md`, every rule linked back to its source |
| Locked to one vendor's model | The card-extraction model is configurable (defaults to the current session model; can point at a fully local model) |

## The 12 tools

| Tool | Purpose |
|---|---|
| `bili_search` | Search candidate videos (title, uploader, duration, view count) to decide what to learn |
| `bili_learn` | Fetch metadata + subtitles → segment → extract knowledge cards into the local knowledge base; `pages` / `all_pages` batch multi-part videos |
| `bili_series` | Same uploader, same tutorial series: `find` / `list` / `next` / `learn` / `cluster` |
| `bili_recall` | Search what you already learned; returns cards and transcript evidence with timestamps and jump-back links |
| `bili_index` | Retrieval index layer (SQLite): `status` health check / `rebuild` / `verify` dual-run comparison of both code paths |
| `bili_practice` | Review loop: `due` lists cards due, `grade` records ok/miss and updates mastery plus the next review time |
| `bili_note` | Write your own cards to override automatic extraction (`evidence` timestamps required) |
| `bili_filter` | Card quality control: send cards to the model to be judged `knowledge` / `ad` / `filler`; `scan` / `apply` / `restore` / `stats` |
| `bili_status` | Knowledge-base overview: videos learned, card counts, reviews due, warnings |
| `bili_login` | QR login: render QR → poll → write the session cookie into `cookieFile` |
| `bili_frame` | Extract frames at specific seconds to local images, for reading on-screen text with a vision model |
| `bili_skill` | Assemble learned knowledge into a `SKILL.md` skill (frontmatter, grouped body, every rule carrying an evidence link) |

## Learning a whole series (same uploader, same collection)

Tutorials rarely arrive as a single video. `bili_series` lets the agent walk the collection itself instead of you pasting links one by one.

```jsonc
// 1) give any episode → find the collection it belongs to, list every episode, mark learned / unlearned
{ "action": "find", "url": "BVDEMO000008" }
// → key=season:1234567, total=22, learned=1, missing=21, next=#1 …

// 2) learn the next episodes in collection order (default 3, max 10; already-learned ones are skipped)
{ "action": "learn", "url": "BVDEMO000008", "limit": 3 }

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
{ "url": "BVDEMO000008", "pages": [1, 2, 3] }
{ "url": "BVDEMO000008", "all_pages": true }
```

Consequences worth knowing:

- `bili_note` and `bili_practice grade` take a `page` (default 1); `bili_practice due` without `page` spans every learned part of that bvid.
- `bili_recall` with a `bvid` searches across parts, and jump links carry `?p=` for P2 and beyond.
- `bili_skill` given that bvid compiles **all learned parts into one skill**, sources labelled by part.
- `bili_status` and the injected index show `BVxxx P2`.

Measured on a 35-part course: learn P1 (15 cards), then `pages:[2,3]` → P1's 15 cards and 929 transcript lines survive untouched; re-learning P1 returns `skipped` and changes nothing.

## Card quality control: the model judges, not regex

Bilibili tutorials carry "smash the like button" begging, group-join lead magnets, course upsells, outro thanks, and filler such as "this feature is amazing". The plugin does **not** pattern-match those away — the judgment is the model's. The code only does three things: batch the cards, book the result, make it reversible.

- After learning, that page's cards go to the model in batches of 12: `knowledge` / `ad` / `filler`, each with a reason of at most a dozen characters.
- Cards judged `ad`/`filler` move out of `cards.json` into `filtered.json` — verdict and reason included, **nothing is silently deleted** — and `cards.md` grows an appendix listing what was dropped and why.
- Anything the model cannot judge (empty output, missing id) stays in `cards.json` and is recorded as `uncertain`. No verdict, no deletion.
- The judge prompt carries an explicit bias: "when unsure, answer `knowledge` — keep it, never drop knowledge by mistake."
- `bili_filter`: `scan` previews (verdicts are cached in `judgments.json`, keyed by a card digest, so a re-run costs zero calls) → `apply` books it → `restore` returns a card and **pins** it (`pinned.json`; later re-learns and re-judges never touch a pinned card) → `stats` summarizes the whole base.
- Extraction is also told not to emit such cards in the first place; when a whole segment is only ads and filler the model returns `[]` and the segment is marked `noise` — different from `unread`, which means "we never got the transcript".

Verified against the real knowledge base with the local model: one video, 4 cards, 1 call, 9 seconds — it dropped the "comment a keyword to get my script template" card (reason: lead magnet in the comments) and kept the other three. Reproduce with `node tests/judge-live.mjs <bvids>` (single process, serial, writes only the verdict cache, never touches cards).

## At scale: SQLite narrows candidates, it does not rank

Once the base grows to a few thousand cards, "scan every JSON file on each recall" degrades linearly. Measured on the real base (342 pages / 1546 cards / 48033 transcript lines, 11.3 MB of JSON): **195 ms → 1 ms** per query; at 100× (34200 pages / 154600 cards) the JSON path extrapolates to **29 seconds per query**, while the indexed path stays in milliseconds.

- `bili.sqlite` is a **derived cache**, never the source of truth: `bili_index action=rebuild` rebuilds it in 2.4 s; delete it and every query silently falls back to the JSON path. No knowledge is ever lost.
- **One ranking semantic only**: SQLite only does candidate retrieval — "the card contains at least one query token" is precisely the necessary condition for a score above zero, so the candidate set is a superset of what a full scan would find. Final ranking still comes from the same `scoreCard` and comparator. Letting bm25 decide the top 8 is wrong: measured, 250 of 60 queries' hits disagreed with the JSON path.
- Chinese needs **bigrams inside `fts5(tokenize='unicode61')`**: the `trigram` tokenizer returns zero hits for two-character terms such as 景别 or 轴线.
- Zero dependencies: `node:sqlite` ships with Node ≥ 22.5 (FTS5 included); when unavailable everything falls back to JSON, and `sqliteIndex: false` turns the layer off entirely.

Acceptance (real base, not synthetic): `node tests/db-verify.mjs` → 60 queries (mixed Chinese/English, proper nouns) return **identical top-8 cards, identical order, zero lost hits**; transcript-line groups identical on 5 queries; cross-page due lists identical; 17.8× faster overall. `bili_index action=verify` makes the same dual run a tool call you can fire any time.

> **Want semantic recall** (so "how do I pick the aspect ratio" also hits the card that says "9:16")? That line needs
> torch + transformers plus a 91 MB Chinese embedding model, which not every machine has — so it lives on the
> **`semantic-vector` branch** (tag `v0.6.0-semantic`) and the main line keeps **zero Python dependencies**.
> `git clone -b semantic-vector …`; the knowledge base format is identical on both lines — the branch only adds
> `mode:semantic|mixed` and a disposable vector cache, and the default path is still keyword search.

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
| `judgeAfterLearn` / `judgeBatch` / `judgeMaxTokens` | `true` / `12` / `1600` | Card quality control: batch cards to the model for an `ad`/`filler` verdict. The verdict is the model's; the plugin writes no ad regexes |
| `sqliteIndex` | `true` | Retrieval index layer (SQLite). `false` = always scan JSON; the index is only a cache, always disposable |
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
bili_skill   →  write skills/h3-blocking-performance/SKILL.md into ~/.dsh/skills/ (on your machine, never shipped)
```

That chain produced a reusable rule sheet on blocking, shot-to-shot continuity and performance for AI-generated video: every rule links back to its source video at a timestamp, and conclusions from our own local render tests are labelled as such. It lives in the author's local `~/.dsh/skills/` and is **not in this repository** — cards and skills distilled from real videos belong to whoever learned them, so the repo ships code plus a clearly synthetic example, never a learned knowledge base and never a vector store.

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
node tests/selftest.mjs   # PASS 87 checks   pure functions and knowledge-base gates (series progress, per-page isolation, judgment bookkeeping + rollback, index-layer parity, stale-index self-heal, colliding card ids renamed)
node tests/tool-test.mjs  # PASS 12 tools    drives the real tools with a fake ctx, checks lossless output
node tests/repo-hygiene.mjs # PASS repo-hygiene asserts the repo holds no vector store, no index, no learned cards or skills (synthetic sample excluded; runs in CI)
node tests/db-smoke.mjs   # PASS 22 checks   index layer smoke: build / mirror / incremental / rebuild / fallback after deletion / external-write detection
node tests/fix-dup-ids.mjs # repairs history: renames colliding card ids within a page (both cards kept), then rebuilds the index (needed for libraries learned on 0.5.2 or earlier)
node tests/db-verify.mjs  # optional: dual-run acceptance against your own knowledge base
node tests/relearn.mjs    # optional: re-distill only the segments stuck at status=unread
node tests/judge-live.mjs # optional: real model + your own knowledge base, verdict cache only, never touches cards
```

CI runs the first gate on every push; the second one touches the live Bilibili API, so it is allowed to fail on datacenter IPs (see [`.github/workflows/ci.yml`](.github/workflows/ci.yml)). Release notes live in [CHANGELOG.md](CHANGELOG.md).

## Privacy

This repository contains no cookies, account IDs, session tokens or machine-specific absolute paths; and no learned cards, generated skills, query index (`bili.sqlite`) or vector store (`*.jsonl`, `vec0.*`) — those stay on the user's machine, and `tests/repo-hygiene.mjs` asserts it in CI. Commit history uses a GitHub noreply address.
`.gitignore` covers `cookie.txt`, `**/bili-kb/` (except the sample directory), `.out/` and `*.log`.

## License

Code and documentation are licensed under [CC BY-NC 4.0](LICENSE) (attribution, non-commercial).Quotations of third-party videos inside cards and skills are **short excerpts with timestamps and back-links**; copyright of that underlying content stays with the respective uploaders. If you consider an excerpt out of bounds, open an issue and it will be removed after review.
