# 更新日志 / Changelog

本文件遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 风格，版本号遵循
[语义化版本](https://semver.org/lang/zh-CN/)。

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
