# dsh-bili-learn — 让 AI 学会并应用 B 站视频里的知识

不是「视频摘要」插件。它的目标是一条闭环：**读进带证据的讲稿 → 提炼成知识卡片 → 复习自测 → 在后续任务里被检索调用**。

## 它解决什么

普通摘要插件只给结论，AI 学到的是一次性文本，下次会话就忘了。这个插件把知识落成**可检索、可复习、可追溯**的文件，并把「我学过什么」注入系统提示，所以后续会话里 AI 会主动去查。

三条硬规则：

1. **证据链**：每张卡片必须挂时间戳，能回跳原视频（`https://www.bilibili.com/video/BVxxx?t=秒`）。
2. **诚实标注**：某段没提取出卡片，就标 `unread` 并写原因，不会假装学会。
3. **学会 = 能用**：卡片进入间隔复习队列；相关任务先 `bili_recall` 再作答。

## 安装

```bash
# 在 DSH 里让 Agent 执行（需要 Full access 或批准）
plugin_manager: action=install_bundle, target=<本地路径>/dsh-bili-learn
```

或手动把目录放进 profile 后 `pnpm install`（推荐用 `install_bundle`，它会处理 patch 层与依赖）。

## 配置（`cordis.patch.yml` 里改 `bili-learn` 这一行）

| 字段 | 默认 | 说明 |
|---|---|---|
| `kbDir` | `$DSH_HOME/bili-kb` | 知识库根目录 |
| `cookie` | 空 | 浏览器整条 Cookie，或只填 `SESSDATA`。**读字幕必需** |
| `cookieFile` | `<kbDir>/cookie.txt` | 把 Cookie 放文件里，**每次调用重读**，换 Cookie 不必重启 DSH |
| `cookiesFromBrowser` | 空 | 让插件调 `yt-dlp --cookies-from-browser chrome/edge/firefox` |
| `ytDlp` | `yt-dlp` | yt-dlp 可执行文件 |
| `distill` | `true` | 是否调用模型提取卡片 |
| `distillProvider` / `distillModel` | 空 | 留空 = 当前会话默认模型（本机即本地 qwen，免费） |
| `segmentMinutes` | 8 | 分段粒度 |
| `maxCardsPerSegment` | 5 | 每段最多几张卡片 |
| `distillMaxTokens` | 1400 | 本地思考型模型长输出会翻车，短输出 + 失败重试一次 |
| `maxLearnMinutes` | 0 | 0 = 整段都学 |
| `injectIndex` | `true` | 把「已学会 N 个视频」的紧凑索引注入系统提示 |

### 关于字幕（重要）

实测：B 站对**匿名**请求不下发字幕轨（`x/player/wbi/v2` 的 `subtitle.subtitles` 恒为空），AI 摘要接口返回 `-403`。所以想自动读讲稿，必须给登录态，四选一：

1. **推荐：`bili_login` 扫码登录**。`action=start` 生成二维码 PNG（本地渲染，不经过任何第三方），手机 B 站 App 扫一下，`action=poll` 就把会话 Cookie 写进 `cookieFile`。实测一次通过，不需要密码、不需要浏览器。
2. 插件 config 填 `cookie`，或把 Cookie 写进 `<kbDir>/cookie.txt`（改完即生效，不用重启）。
   取法：B 站页面 F12 → Network → 刷新 → 点任意 `api.bilibili.com` 请求 → Request Headers → 整条 `cookie:` 复制。
   **别用 `document.cookie`**：`SESSDATA` 是 HttpOnly，控制台拿不到，缺它照样读不到字幕。
3. 配 `cookiesFromBrowser: chrome`（或 `edge`），插件调 yt-dlp 复用浏览器登录态。
   实测坑：浏览器开着时 Cookie 数据库被独占（`PermissionError`），**必须先完全退出该浏览器**。
4. 不给登录态：把文稿喂给它 —— `bili_learn` 支持 `transcript_path` / `transcript_text`（JSON 或带 `[mm:ss]` 的纯文本）。

没有讲稿时插件不会瞎编：只落元数据、标签、简介，并在 `warnings` 里说清楚缺什么。

### 画面（抽帧）

语音字幕只覆盖「说出来的话」。教程视频常把**提示词原文、参数、软件界面、对比效果**只画在画面上——实测 [BV1xBjW6pEym] 在 00:17 的画面顶部写着「核心提示词：摄像机缓缓向他的面部移动，画面逐渐收窄。」，这句话在字幕里完全不存在。

所以 `bili_frame` 走这条路：`player/wbi/playurl` 拿 mp4 直链 → ffmpeg 抽帧（带 `Referer`/`UA`，缺头 CDN 直接 403）。B 站公开的快照接口都不可用（实测 `player/snapshot` 404、`player/preview` 返回 HTML），别指望它。

ffmpeg 从哪来：config 的 `ffmpeg` → PATH 上的 `ffmpeg` → `pip install imageio-ffmpeg` 自带的二进制（本机就是这么解决的，无需装系统级 ffmpeg）。360P/480P 足够读画面文字，匿名也能取到部分视频的 360P。

### 生成技能

`bili_skill` 把已学会的卡片组装成 DSH 技能（`~/.dsh/skills/<name>/SKILL.md`，带 frontmatter 与逐条回跳链接）。插件只做**可靠拼装**，不调模型——措辞由会话模型精修。写完需要重启或开新会话才会出现在技能列表。

## 工具

| 工具 | 作用 |
|---|---|
| `bili_search` | 搜候选视频（匿名可用） |
| `bili_learn` | 抓讲稿 → 分段 → 提取卡片 → 落盘 |
| `bili_series` | 同一 UP 主的系列教程：`find`/`list`/`next`/`learn`/`cluster` |
| `bili_recall` | 检索已学会的卡片与讲稿证据（带时间戳、回跳链接） |
| `bili_note` | 由模型/用户手写卡片，覆盖同 id |
| `bili_practice` | `due` 取待复习卡片；`grade` 记录 ok/miss，驱动间隔复习 |
| `bili_status` | 知识库总览与告警 |
| `bili_login` | 扫码登录：出二维码 → 轮询 → 把 Cookie 写进 cookieFile |
| `bili_frame` | 按秒数抽帧存本地图片，用 read_image 看画面 |
| `bili_skill` | 把已学会的卡片组装成 DSH 技能 SKILL.md，写进技能目录 |

同时注册技能 `bili-study`（教 AI 怎么跑完整闭环）。

## 按系列学：同一 UP 主的同一系列教程

教程一旦是合集，逐集手动喂链接就很蠢。`bili_series` 让 AI 自己顺着合集往下学。

```jsonc
// 1) 给系列里任意一集，反查它所属的合集，列出全部集数 + 已学/未学
{ "action": "find", "url": "BV1uuHy6hEfe" }
// → key=season:1234567「MiniMax-H3系列」total=22｜learned=1｜missing=21｜next=#1 …

// 2) 按合集顺序连学（默认 3 集，limit 最多 10；已学的自动跳过）
{ "action": "learn", "url": "BV1uuHy6hEfe", "limit": 3, "max_minutes": 0 }

// 3) 想知道这个 UP 主还有哪些合集
{ "action": "list", "mid": 123456789 }

// 4) 稿件不在任何合集里时的兜底：按标题前缀聚组
{ "action": "cluster", "keyword": "MiniMax H3 打斗", "owner": "某UP主" }
```

要点（都是实测）：

- `view` 返回的 `ugc_season.sections[].archives` 现在是 `undefined`，合集内容必须走 `seasons_archives_list`（分页、保留合集自身顺序，`index` 从 1 开始）。
- 已学状态不另存一份：`index.series[key].episodes` 只存清单，学没学按 `index.videos` 现算，避免两处真相。
- 按系列学的稿件会带 `series` 标记，于是 `bili_recall` 可以 `{"series":"season:1234567"}` 限定检索，`bili_skill` 可以 `{"series":"season:1234567"}` 一次把整个系列出成一个技能。
- `bili_status` 会列出每个系列的 `learned/total` 与下一集；注入的系统提示里也带这行，新会话直接知道还差几集。
- `cluster` 只是启发式兜底（去掉【】、括号、集数编号后按前缀聚组），真合集优先。

## 多 P 合集：一门课几十 P，一页一目录

一个 bvid 有多个 P 时，**每一页存自己的目录**：P1 是 `<bvid>/`（老数据不动），P2 是 `<bvid>_p2/`。之前学 P2 会把 P1 的 `cards.md`/`transcript.md` 整份冲掉，现在不会。

```jsonc
// 批量学（合集可能几十 P，建议分批）
{ "url": "BVxxxxxxxxxx", "pages": [1, 2, 3] }
{ "url": "BVxxxxxxxxxx", "all_pages": true }
```

配套口径：

- `bili_note`、`bili_practice` 的 `grade` 要带 `page`（不带就是 P1）；`due` 不给 `page` 会把这个 bvid 的所有页一起算。
- `bili_recall` 传 `bvid` 会跨页检索，回跳链接自动带 `?p=`（P1 不带，P2+ 必带）。
- `bili_skill` 传这个 bvid，会把它的**所有已学页汇总成一个技能**，来源列表按页标注。
- `bili_status` 与注入的系统提示里，多 P 会显示成 `BVxxx P2`。

实测（35 P 的《影视导演基础》）：先学 P1（15 张卡），再 `pages:[2,3]` → 学完 P1 的 15 张卡与 929 行讲稿**完好无损**，`P2/`、`P3/` 各自独立；再学 P1 直接 `skipped`，不动别的页。

## 知识库产物

```
$DSH_HOME/bili-kb/
  index.json                 # 视频索引 + 系列清单（series[key].episodes）
  BVxxxxxxxx/
    source.json              # 元数据 + 覆盖度 + 字幕来源
    transcript.json / .md    # 带时间锚点的讲稿
    segments.json / outline.md # 分段状态（distilled / unread）与关键词
    cards.json / cards.md    # 知识卡片：结论 / 为什么 / 怎么做 / 证据时间戳
    study.md                 # 学习契约：自测提问 + 应用任务
    review.json              # 熟练度与下次复习时间
  BVxxxxxxxx_p2/             # 多 P 的第 2 页起各存一份（P1 仍是 BVxxxxxxxx/）
  BVxxxxxxxx/frames/         # bili_frame 抽出来的画面
```

## 实测边界（2026-11，本机匿名）

| 能力 | 匿名 | 说明 |
|---|---|---|
| 元数据 / 分 P / 标签 | ✅ | `view`、`pagelist`、`tag/archive/tags` |
| 视频搜索 | ✅ | 需先引导 `buvid3`（插件自动调 `finger/spi`）；`wbi/search/type` 会返回空结果，插件自动退回普通端点 |
| 字幕轨 | ❌ | `player/wbi/v2` 的 `subtitle.subtitles` 恒为空；yt-dlp 匿名也只拿到弹幕 |
| AI 摘要 | ❌ | `view/conclusion/get` 返回 `-403` |
| 评论 | ❌ | 需要登录态 |

所以：**讲稿必须靠登录态或你自己提供**，插件不会假装读到了。

提取速度（本机 llama.cpp，`qwen3.8-flash-next-iq3_s`，单并发）：一段 5 分钟讲稿 ≈ 345 秒。60 分钟课程约 8 段 ≈ 45 分钟。慢但免费，可以丢后台跑；想快就在 config 里把 `distillProvider/distillModel` 指向在线模型。

本地思考型模型的坑已处理：提示里带 `/no_think`，正文为空时如实标 `unread` 并记录「思考占 N 字」，第二次重试禁止思考并加倍预算。

改过插件源码后要**重启 DSH** 才会加载新的模块代际；`set_plugin` 开关不会重载 JS。

## 推荐用法

```
1. bili_learn(url)                      # 看 coverage 和 warnings，别只看 cards 数
2. 读 cards.md，对照 transcript.md 复核 → bili_note 修正
3. bili_practice(action=due) → 自测 → action=grade 记录
4. 以后做相关任务：先 bili_recall(query)
```

第 2 步不是可选项：自动提取（尤其本地模型）会漏、会含糊，模型自己复核后写的卡片质量明显更高。

## 自检

```bash
node .tools/selftest.mjs     # 24 项：分段/文稿解析/知识库/复习/字幕格式/提取器两条路径
node .tools/tool-test.mjs    # 用假 ctx 直接跑 6 个工具，校验输出是 lossless JSON
```

