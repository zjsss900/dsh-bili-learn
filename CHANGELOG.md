# 更新日志 / Changelog

本文件遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 风格，版本号遵循
[语义化版本](https://semver.org/lang/zh-CN/)。

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
