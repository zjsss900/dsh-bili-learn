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
| `judgeAfterLearn` | `true` | 学完把卡片成批送模型质检（广告/引流/口水话）。判定由模型给，插件不写正则猜 |
| `judgeBatch` | 12 | 每次送判的卡片数（本地模型要小批量、短输出） |
| `judgeMaxTokens` | 1600 | 每次质检的 maxTokens；判定输出很短，够 |
| `sqliteIndex` | `true` | 用 SQLite 做检索索引层（`bili_recall`/待复习统计毫秒级）。设 `false` 就完全走 JSON 全扫 |
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

语音字幕只覆盖「说出来的话」。教程视频常把**提示词原文、参数、软件界面、对比效果**只画在画面上——实测 [BVDEMO000002] 在 00:17 的画面顶部写着「核心提示词：摄像机缓缓向他的面部移动，画面逐渐收窄。」，这句话在字幕里完全不存在。

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
| `bili_index` | SQLite 查询索引层：`status` 体检 / `rebuild` 重建 / `verify` 两条路双跑比对 |
| `bili_note` | 由模型/用户手写卡片，覆盖同 id |
| `bili_filter` | 卡片质检：送模型判「知识 / 广告引流 / 口水话」，`scan`/`apply`/`restore`/`stats` |
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
{ "action": "find", "url": "BVDEMO000009" }
// → key=season:1234567「MiniMax-H3系列」total=22｜learned=1｜missing=21｜next=#1 …

// 2) 按合集顺序连学（默认 3 集，limit 最多 10；已学的自动跳过）
{ "action": "learn", "url": "BVDEMO000009", "limit": 3, "max_minutes": 0 }

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
{ "url": "BVDEMO000008", "pages": [1, 2, 3] }
{ "url": "BVDEMO000008", "all_pages": true }
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
  bili.sqlite                # 查询索引（由 JSON 派生，可删可重建；删了自动回退 JSON 路线）
  BVxxxxxxxx/
    source.json              # 元数据 + 覆盖度 + 字幕来源
    transcript.json / .md    # 带时间锚点的讲稿
    segments.json / outline.md # 分段状态（distilled / unread）与关键词
    cards.json / cards.md    # 知识卡片：结论 / 为什么 / 怎么做 / 证据时间戳
    study.md                 # 学习契约：自测提问 + 应用任务
    review.json              # 熟练度与下次复习时间
    judgments.json           # 模型对每张卡的判定（knowledge/ad/filler + 理由，按卡片指纹缓存）
    filtered.json            # 被模型判成广告/口水而剔掉的卡片，连判定与理由一起存，可回滚
    pinned.json              # 用户 restore 回来、明确要留的卡片 id，规则不再动它们
  BVxxxxxxxx_p2/             # 多 P 的第 2 页起各存一份（P1 仍是 BVxxxxxxxx/）
  BVxxxxxxxx/frames/         # bili_frame 抽出来的画面
```

## 查询索引：SQLite 只做候选召回，排序口径只有一套

规模上去以后，「每次检索都扫全部 JSON」是线性变糟的那条路。实测本机：

| | 现在（342 页 / 1546 卡 / 48033 讲稿行） | 100× 外推（34200 页 / 154600 卡） |
| --- | --- | --- |
| 全库 JSON | 11.3 MB、2833 个文件 | ≈1.13 GB、≈28.3 万个文件 |
| `bili_recall` | 195 ms/查询 | ≈29 s/查询 |
| 走索引 | **1 ms/查询** | 同量级（毫秒） |
| 全库统计 / 待复习 | 234 ms / 234 ms | ≈23 s / ≈23 s |
| `index.json` 重写 | 378 KB | ≈37 MB |

设计原则（刻意的，别改）：

- **JSON 是真相源**。`bili.sqlite` 只是派生缓存：`bili_index action=rebuild` 2.4 秒重建完；删掉它就自动回退 JSON 路线，**不丢任何知识**。
- **索引只负责「含任一词元」的候选召回**——那正是打分 >0 的必要条件，所以候选集是 JSON 全扫结果的超集。最终排序仍走 `text.js` 的 `scoreCard` / `searchLines`，**口径只有一套**。谁想「让 bm25 直接决定 top8」就是在制造两条不同的检索结果，实测那样做 60 个查询里有 250 条命中对不上。
- 中文用 **bigram 灌 `fts5(tokenize='unicode61')`**：`trigram` 对「景别」「轴线」这类两字词**完全不命中**（实测 0 条），别用。
- 绑定收口：`node:sqlite` 不接受对象参数——实测 `series` 字段是对象时整页卡片静默漏索引（已修 + 门禁盯着）。
- 每次写卡片都会顺手镜像这一页；镜像失败只记一笔，绝不回滚知识落盘。

验收（真库、非合成）：`node tests/db-real-verify.mjs` → 60 个查询（含中英混合、专有名词）**卡片 top8 逐条一致、顺序一致、漏 0 条**；讲稿行 5 组一致；待复习列表跨页一致；整体 17.8× 提速（单查询 ~200×）。`bili_index action=verify` 把同一件事做成随时可跑的工具调用，`engine=json`/`engine=sql` 可强制对比。

## 卡片质检：判定交给模型，不写正则

B 站教程里混着求三连、加群领资料、卖课、片尾致谢，以及「这个功能很强大」这类没信息量的过渡话。插件**不用正则去猜**这些——判定由模型给，程序只做送判、记账、回滚三件事。

- 学完（`bili_learn`）自动把这一页的卡片成批（默认 12 张一批）送模型判：`knowledge` / `ad` / `filler`，每张附一句不超过 12 字的理由。
- 判成 `ad`/`filler` 的卡片从 `cards.json` 移到 `filtered.json`（判定与理由一起存，**没有真删**），`cards.md` 文末列出「已筛掉」清单与原因。
- 判不了（模型空正文、漏了 id）的卡片**一律保留**，只记 `uncertain`——没有判定就不删。
- 保守条款写在提示词里：「拿不准就写 knowledge——宁可留下，绝不误删知识」。
- `bili_filter`：`scan` 预览（判过的走 `judgments.json` 缓存，不重复调用）→ `apply` 落账 → `restore` 放回并**钉住**（`pinned.json`，以后重学重筛都不再删）→ `stats` 汇总全库。
- 提取阶段也要求模型自己别产这类卡片；整段只有广告/口水时模型输出 `[]`，该段标 `noise`（区别于「没读到」的 `unread`）。

真机验收（本机 qwen，真实知识库）：[BVDEMO000012] 4 张卡，9 秒、1 次调用，判掉 `领取萌宠脚本模板`（理由「评论区领资料引流」），其余 3 张保留。判定质量用 `tests/judge-live.mjs` 复跑（单进程串行、直连本地服务、只写缓存不动卡片）。

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
2. bili_filter(action=scan, bvid=…)     # 看模型判成广告/口水的是哪些、理由是什么
3. 读 cards.md，对照 transcript.md 复核 → bili_note 修正；判错了 bili_filter restore 放回
4. bili_practice(action=due) → 自测 → action=grade 记录
5. 以后做相关任务：先 bili_recall(query)
```

第 3 步不是可选项：自动提取（尤其本地模型）会漏、会含糊，模型自己复核后写的卡片质量明显更高。质检同理——它只是把可疑的挑出来给你看，判错了 restore 回来，别指望全自动。

## 自检

```bash
node tests/selftest.mjs       # 87 项：分段/文稿/知识库/复习/提取器两条路径（含长段截断切半补救、切半不撞 id）/质检记账与回滚/索引层两条路一致/索引陈旧自愈
node tests/tool-test.mjs      # 用假 ctx 跑全部 12 个工具，校验输出是 lossless JSON
node tests/db-smoke.mjs       # 索引层冒烟（22 项）：建/镜像/增量/重建/删掉后回退 JSON/指纹发现外部写入
node tests/db-real-verify.mjs # 真知识库双跑验收：60 查询卡片逐条一致 + 讲稿行 + 待复习 + 计时（要传 BILI_KB）
node tests/judge-live.mjs     # 真模型 + 真知识库验收判定（只写缓存，不动卡片）
node tests/relearn.mjs BV…    # 只重跑 status=unread 的段（补提取，按 id 去重追加）
```

