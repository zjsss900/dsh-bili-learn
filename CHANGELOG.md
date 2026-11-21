# 更新日志 / Changelog

本文件遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 风格，版本号遵循
[语义化版本](https://semver.org/lang/zh-CN/)。

## [0.5.2] - 2026-11-22

### 修复 / Fixed

- **索引会静默变陈旧，检索照常返回结果却少答** — 只有「新代码写的页」会镜像进索引；旧版本插件、另一个进程、
  手工改 JSON 写的页不会。真库实测：366 页里 **8 页 / 106 卡落在索引外面**，`bili_recall` 照样出结果，看不出来。
  现在 `index.json` 的指纹（size:mtime）一变，下次检索前只重镜像过期的页（每页记 `updated` 比对），
  JSON 里删掉的页也从索引删掉；索引页全空时小库自动整库补建。真库补齐一次 15.7 s，之后单查询 ~1 ms。
  / the index no longer goes stale silently: a fingerprint on index.json triggers a per-page re-mirror
- `syncPage` 现在把 `index.json` 里的 `updated` 写进索引（之前写的是镜像时刻，没法用来判断哪页过期）

### 门禁 / Gates

- selftest 83 → **85 checks**：外部写入的页会自动补镜像；JSON 删页后索引不留幽灵
- db-smoke 17 → **22 checks**：`meta` 指纹读写、`pageStamps`、`deletePage`、清空后自动补建、
  以及一条实测教训——**SQL 候选空时会按设计回落 JSON**，别把它当漏删查

## [0.5.1] - 2026-11-22

### 修复 / Fixed

- **本地模型长段提取会被 maxTokens 截断** — 实测连续两个视频各有一段输出被截断，整段只能标 `unread`。
  现在第三道兜底：整段失败且讲稿超过 900 字时，自动切两半分别提（各 ≤3 张卡），收紧提示同时要求
  「evidence 只留 1 条、quote ≤ 20 字」。真库验收：两段原本 `unread` 的段补出 4 张卡，各 43 秒
  / long segments are now split in half when the model's JSON output gets truncated
- 附带 `.tools/relearn.mjs`（发布树 `tests/relearn.mjs`）：只重跑 `segments.json` 里 `status=unread` 的段，
  按时间窗从讲稿重建正文，补出的卡按 id 去重后追加，并把该段改标 `distilled`

### 门禁 / Gates

- selftest 82 → **83 checks**：新增「长段截断会切两半补救，而不是直接 unread」断言

## [0.5.0] - 2026-11-22

### 新增 / Added

- **查询索引层（第 12 个工具 `bili_index`）** — 规模上去以后「每次检索扫全部 JSON」是线性变糟的那条路。
  新增 `<kb>/bili.sqlite`：`page` / `card` / `card_fts` / `line` / `line_fts` / `review` 六张表，
  `status` 体检、`rebuild` 全量重建（实测 342 页 1546 卡 48033 讲稿行 2.4 秒，索引 15.3 MB）、
  `verify` 两条路双跑比对 / A derived SQLite index for retrieval; rebuild, status, dual-run verify
- **索引只是派生缓存** — JSON 仍是唯一真相源：删掉 `bili.sqlite` 就自动回退 JSON 全扫，不丢任何知识；
  每次写卡片顺手镜像该页，镜像失败只记一笔，绝不回滚知识落盘 / disposable, never authoritative
- **中文检索用 bigram 灌 `fts5(tokenize='unicode61')`** — 实测 `trigram` 对「景别」「轴线」这类两字词**完全不命中**（0 条），不可用
  / bigram-indexed FTS5; the trigram tokenizer fails on 2-character Chinese terms
- **口径只有一套** — SQLite 只做「含任一词元」的候选召回（那正是 `scoreCard` 打分 >0 的必要条件，所以候选集是 JSON 结果的超集），
  最终排序仍由 `text.js` 那套打分与比较器决定；`bili_recall` 新增 `engine=auto|sql|json` 可强制对比
  / SQL narrows candidates, the existing scorer decides ranking — one ranking semantic only
- **配置** — `sqliteIndex`（默认 `true`）；老库索引为空时小库自动补建，大库提示用 `bili_index action=rebuild`

### 变更 / Changed

- `bili_recall` 修一个真洞：schema 里有 `series` 但 `execute` 没往下传，系列限定被静默忽略
  / `series` filter was declared but never applied
- 两条路的 tie-break 改为确定性比较（分数 → bvid → page → id），不再依赖索引插入顺序

### 门禁 / Gates

- selftest 47 → 65 → **82 checks**（新增索引层 17 项：bigram、候选召回、增量镜像、重建、删索引回退、
  「两条路结果必须逐条一致」、以及「不许存在把排序交给 bm25 的写法」这类断言）
- tool-test 覆盖 **12 个工具**（含 `bili_index` 的 rebuild/status/verify 端到端）
- 新增 `tests/db-smoke.mjs`（任何运行时都能跑的索引冒烟）与 `tests/db-verify.mjs`（拿你自己的库做双跑验收）
- CI 的 Node 从 20 升到 22：`node:sqlite` 从 22.5 起内置，CI 现在真的会跑 SQL 路线

### 实测 / Measured（真实知识库，非合成数据）

- 342 页 / 1546 卡 / 48033 讲稿行；全库 JSON 11.3 MB、2833 个文件
- `bili_recall` 单查询 **195 ms → 1 ms**；60 个查询整体 11.8 s → 0.66 s（**17.8×**）
- 双跑验收 **PASS**：60 个查询（含中英混排与专有名词）卡片 top8 **逐条一致、顺序一致、漏 0 条**；
  讲稿行 5 组一致；跨页待复习列表一致
- 100× 规模合成基准：15.46 万张卡插入含索引 13.4 s / 221 MB；bigram 查询 0–2 ms；无索引 `LIKE` 83 ms；
  JSON 路线外推 29 s/查询 —— 这就是为什么需要索引层

## [0.4.0] - 2026-11-22

### 新增 / Added

- **卡片质检（第 11 个工具 `bili_filter`）**：广告、引流、求三连、片尾致谢、「这个功能很强大」这类口水话，
  **判定交给模型**，插件不写一条广告正则。学完把卡片成批（默认 12 张）送模型判
  `knowledge`/`ad`/`filler`，每张附不超过 12 字的理由；`scan` 预览 → `apply` 落账 → `restore` 放回并钉住 → `stats` 汇总
  / Card quality control: the model judges, the plugin only books the result
- **三个新落盘文件** — `judgments.json`（按卡片指纹缓存的判定，重跑零调用）、`filtered.json`（被剔卡片连判定与理由一起存，
  可回滚，绝不静默删除）、`pinned.json`（用户 `restore` 回来并钉住的卡片，之后重学重筛都不再动它）
- **诚实边界** — 模型判不了（空正文、漏了 id）的卡片一律保留并记 `uncertain`：没有判定就没有删除。
  提示词写死保守条款「拿不准就写 knowledge——宁可留下，绝不误删知识」
- **提取阶段同步收紧** — 要求模型自己别产这类卡片；整段只有广告/口水时输出 `[]`，该段标 `noise`，
  与「没拿到字幕」的 `unread` 明确区分
  / Segment-level `noise` status, distinct from `unread`
- **配置** — `judgeAfterLearn` / `judgeBatch` / `judgeMaxTokens`（默认 `true` / `12` / `1600`）；`bili_learn` 新增 `judge` 参数可单独关掉

### 变更 / Changed

- 撤掉上一版实验里的**正则判类**：实测它会把「秩=主元个数」这类极简真卡误判成口水话。
  现在判定一律由模型给，程序只做送判、记账、回滚三件事；`lib/filter.js` 已删除
  / The experimental regex classifier is gone — judgment belongs to the model

### 门禁 / Gates

- `tests/selftest.mjs` 47 → **65 项**：新增 18 项质检管线用例（假模型送判、缓存命中零调用、`pinned` 不送判、
  模型漏 id → 保留并标 `uncertain`、空正文 → 全部保留并报 `unjudged`、`applyJudgments` 落账与 `restore` 回滚、
  `cards.md` 的「已筛掉」附录、断言仓库里不存在正则判定模块）
- `tests/tool-test.mjs` 覆盖 **11 个工具**，含 `bili_filter` 全链：scan → 缓存命中 → apply → stats → restore → 钉住后不再被剔

### 实测 / Measured

- 真实知识库 20 页 / 168 张卡：22 次本地调用约 8 分钟，模型挑出 7 张（1 张教程运营计划 + 6 张口水话，
  如「本段结束景别内容，其他内容以后讲」），其余 161 张知识卡**零误杀**
- 另一样本 4 张卡、1 次调用、9 秒：判掉「评论区扣关键词领模板」（理由：评论区领资料引流），其余保留
  / Reproducible with `node tests/judge-live.mjs <BV号,...>`（verdict cache only, never touches cards）

## [0.3.0] - 2026-11-07

### 修复 / Fixed

- **多 P 合集不再互相覆盖**：每个分 P 存自己的目录（P1=`<bvid>/`，P2=`<bvid>_p2/`）。之前学 P2 会把 P1 的
  `cards.json` / `cards.md` / `transcript.md` 整份冲掉——跨页知识活不过下一次 learn
  / Multi-part videos no longer clobber each other: each part gets its own directory
- 回跳链接对 P2+ 自动带 `?p=`（`bili_recall`、`bili_skill` 都修了）——否则跳过去的是 P1 的那一秒
  / Jump links carry `?p=` for part 2 and beyond

### 新增 / Added

- **`bili_learn` 批量学多 P** — `pages:[1,2,3]` 或 `all_pages:true`，逐页跑同一条管线
  / Batch learning for multi-part videos
- **按页操作** — `bili_note` 与 `bili_practice` 接受 `page`；`due` 不给 `page` 时跨页汇总；
  `grade` 的每条结果可带 `page`，各页写各自的 `review.json`
  / Page-scoped note and practice
- **跨页检索与汇总出技能** — `bili_recall` 传 bvid 会搜这个 bvid 的所有已学页；`bili_skill` 传 bvid
  会把所有已学页汇总成一个技能，来源按页标注
  / Cross-part recall; one skill compiled from every learned part
- **门禁 / Gates** — `tests/selftest.mjs` 增至 47 项，新增 8 项多 P 隔离用例（学 P2 后 P1 的卡片与讲稿仍在、
  `saveCards` 只写指定页、`due` 跨页、`grade` 分页写、回跳链接带 `?p=`、技能链接带 `?p=`）

### 实测 / Measured

- 35 P 的《影视导演基础》：先学 P1（15 张卡），再 `pages:[2,3]` → P1 的 15 张卡与 929 行讲稿完好无损；
  再学 P1 返回 `skipped`，不动别的页；`bili_skill` 汇总出 27 张卡、47 条带 `?p=` 的证据链接
  / Verified end to end on a real 35-part course

## [0.2.0] - 2026-11-07

### 新增 / Added

- **`bili_series`：同一 UP 主的同一系列教程** — `find` 反查合集并列出全部集数与已学/未学；`list` 列该 UP 主的全部合集与系列；`next` 取下一集未学的；`learn` 按合集顺序连学（默认 3 集、上限 10、已学自动跳过）；`cluster` 在稿件不属于任何合集时按标题前缀聚组
  / Series learning for one uploader: find / list / next / learn / cluster
- **系列进度** — `index.series[key].episodes` 只存清单，已学状态按 `index.videos` 现算（避免两处真相）；`bili_status` 与注入到系统提示的索引都带 `learned/total` 与下一集
  / Series progress derived from a single source of truth
- **按系列检索与出技能** — `bili_recall` 与 `bili_skill` 接受 `series`，整个系列可以一次组装成一个技能
  / Series-scoped recall and one skill per series
- **门禁 / Gates** — `tests/selftest.mjs` 增至 39 项（新增系列 fixture 用例，不联网），`tests/tool-test.mjs` 覆盖 10 个工具

### 修复 / Fixed

- `tests/tool-test.mjs` 残留的本机绝对路径改为仓库内 `tests/fixtures/linear-algebra-rank.txt`
  / A leftover machine-absolute fixture path now lives in the repo
- 文档与参数示例里出现的真实合集 ID / UID / UP 主名已匿名化
  / Real collection IDs, UIDs and uploader names in docs anonymized

### 实测事实 / Measured facts

- `view` 不再返回 `ugc_season.sections[].archives`（实测为 `undefined`）；合集清单必须走 `seasons_archives_list`（分页、保留合集自身顺序）
  / Collection contents must come from `seasons_archives_list`; `view` omits the archive list now

## [0.1.0] - 2026-11-05

### 新增 / Added

- **9 个工具 / 9 tools**：`bili_search`、`bili_learn`、`bili_recall`、`bili_practice`、
  `bili_note`、`bili_status`、`bili_login`、`bili_frame`、`bili_skill`
- **带时间锚点的知识卡片**：每张卡片必须携带 `evidence: [{t, quote}]`，可回跳原视频对应秒数
  / Timestamped evidence on every card, with jump-back links to the source video
- **间隔复习闭环**：`bili_practice` 的 `due` / `grade` 维护熟练度与下次复习时间
  / Spaced-repetition loop
- **画面读取**：`bili_frame` 按秒抽帧，配合视觉模型读取字幕里不存在的提示词、参数与软件界面
  / Frame extraction for on-screen text that subtitles never contain
- **技能生成**：`bili_skill` 把多个视频的知识组装成 `SKILL.md`，每条规则挂证据链接
  / Skill generation with per-rule evidence links
- **扫码登录**：`bili_login` 本地渲染二维码 → 轮询 → 写入 `cookieFile`，不把登录令牌交给第三方
  / QR login rendered locally; the token never leaves your machine
- **样例技能**：`skills/h3-blocking-performance/SKILL.md`（AI 视频的人物站位、镜头衔接与表演）
  / A sample skill produced by the loop
- **门禁 / Gates**：`tests/selftest.mjs`（24 项）、`tests/tool-test.mjs`（9 个工具输出无损）
- **CI**：`.github/workflows/ci.yml`

### 隐私 / Privacy

- 仓库不含 Cookie、账号 ID、会话令牌或本机绝对路径；提交历史使用 GitHub noreply 邮箱
  / No cookies, account IDs, tokens or machine paths; commits use a noreply address
- 第三方视频的**完整讲稿转录不入库**，卡片只保留必要的短引用
  / Full transcripts of third-party videos are not published; cards keep short excerpts only
- `.gitignore` 覆盖 `cookie.txt`、`**/bili-kb/`（样例目录除外）、`.out/`、`*.log`
