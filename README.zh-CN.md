# dsh-bili-learn · 把 B 站视频「学」成可复用的知识

中文 · [English](README.md)

这不是视频摘要工具。它把视频读成**带时间锚点的知识卡片**，然后在**以后的会话里**检索它、间隔复习它、并把它组装成可复用的技能。

一句话区别：摘要会丢证据，而这里每条结论都挂着「原话 + 第几秒 + 回跳链接」。

```
[00:53] 但这些只是结果模型 → https://www.bilibili.com/video/BVDEMO000001?t=53
```

## 为什么这样做

| 常见问题 | 这个插件的做法 |
|---|---|
| 看完就忘，摘要里没有可核对的出处 | 每张卡片必须带 `evidence: [{t, quote}]`，点开就跳到原视频那一秒 |
| 学完用不上 | `bili_recall` 在相关任务前主动检索；`bili_practice` 按间隔重复提醒你复习 |
| 教程的关键信息只在画面上（提示词、参数、软件界面） | `bili_frame` 按秒抽帧，交给本地视觉模型读画面文字——字幕里根本没有这些 |
| 知识散落，无法复用 | `bili_skill` 把若干视频的知识拼成 `SKILL.md` 技能，每条规则挂回跳链接 |
| 只有某个模型能用 | 提取卡片用哪个模型是可配的（默认当前会话模型，可指向本地模型），不绑定任何厂商 |

## 12 个工具

| 工具 | 作用 |
|---|---|
| `bili_search` | 搜候选视频（标题、UP 主、时长、播放量），用来决定学哪个 |
| `bili_learn` | 抓元数据与字幕 → 分段 → 提取知识卡片；`pages` / `all_pages` 批量学多 P |
| `bili_series` | 同一 UP 主的同一系列教程：`find` / `list` / `next` / `learn` / `cluster` |
| `bili_recall` | 在已学知识里检索卡片与讲稿证据（返回时间戳与回跳链接） |
| `bili_index` | 检索索引层（SQLite）：`status` 体检 / `rebuild` 重建 / `verify` 两条路双跑比对 |
| `bili_practice` | 复习闭环：`due` 列出待复习卡片，`grade` 记录 ok/miss 并更新熟练度与下次复习时间 |
| `bili_note` | 由你自己写卡片覆盖自动提取结果（必须带 `evidence` 时间戳） |
| `bili_filter` | 卡片质检：把卡片交给模型判 `knowledge`/`ad`/`filler`，`scan`/`apply`/`restore`/`stats` |
| `bili_status` | 知识库总览：学过哪些视频、卡片数、待复习数、告警 |
| `bili_login` | 扫码登录：出二维码 → 轮询 → 把会话 Cookie 写进 `cookieFile` |
| `bili_frame` | 按秒抽帧存本地图片，配合视觉模型读画面上的文字与界面 |
| `bili_skill` | 把已学知识组装成技能 `SKILL.md`（带 frontmatter、分组正文、每条挂证据链接） |

## 按系列学：同一 UP 主的同一系列教程

教程很少只有一个视频。合集一旦存在，逐集手动喂链接就很蠢——`bili_series` 让 AI 自己顺着合集往下学。

```jsonc
// 1) 给系列里任意一集 → 反查它所属的合集，列出全部集数并标出已学/未学
{ "action": "find", "url": "BVDEMO000008" }
// → key=season:1234567，total=22，learned=1，missing=21，next=#1 …

// 2) 按合集顺序连学（默认 3 集，上限 10；已学的自动跳过）
{ "action": "learn", "url": "BVDEMO000008", "limit": 3 }

// 3) 这个 UP 主还有哪些合集/系列
{ "action": "list", "mid": 123456789 }

// 4) 稿件不在任何合集时的兜底：按标题前缀聚组
{ "action": "cluster", "keyword": "某个教程", "owner": "某个UP主" }
```

写进实现里的实测事实：

- `view` 返回的 `ugc_season.sections[].archives` 现在是 `undefined`，合集内容必须走 `seasons_archives_list`（分页、保留合集自身顺序，`index` 从 1 开始）。
- 已学状态不另存一份：`index.series[key].episodes` 只存清单，学没学按 `index.videos` 现算，避免两处真相。
- 按系列学的稿件会带 `series` 标记，于是 `bili_recall` 可以用 `{"series":"season:1234567"}` 限定检索，`bili_skill` 可以用 `{"series":"season:1234567"}` 把整个系列一次出成一个技能。
- `bili_status` 会列出每个系列的 `learned/total` 与下一集；注入到系统提示里的索引也带这行，新会话一上来就知道还差几集。
- `cluster` 只是启发式兜底（去掉【】、括号、集数编号后按标题前缀聚组），有真合集时优先用真合集。

## 多 P 合集：一门课几十 P，一页一目录

一个 bvid 可以有多个 P。现在**每一页存自己的目录**：P1 仍是 `<bvid>/`（老数据不动），P2 是 `<bvid>_p2/`。以前学 P2 会把 P1 的 `cards.md`/`transcript.md` 整份冲掉。

```jsonc
// 批量学（一门课可能 35 P，分批更稳）
{ "url": "BVDEMO000008", "pages": [1, 2, 3] }
{ "url": "BVDEMO000008", "all_pages": true }
```

配套口径：

- `bili_note`、`bili_practice` 的 `grade` 要带 `page`（不带就是 P1）；`due` 不给 `page` 会把这个 bvid 的所有页一起算。
- `bili_recall` 传 `bvid` 会跨页检索，P2 起的回跳链接自动带 `?p=`。
- `bili_skill` 传这个 bvid，会把它的**所有已学页汇总成一个技能**，来源按页标注。
- `bili_status` 与注入的系统提示里显示成 `BVxxx P2`。

实测（35 P 的《影视导演基础》）：先学 P1（15 张卡），再 `pages:[2,3]` → P1 的 15 张卡与 929 行讲稿**完好无损**；再学 P1 直接 `skipped`，不动别的页。

## 卡片质检：判定交给模型，插件不写正则

B 站教程里混着求三连、加群领资料、卖课优惠、片尾致谢，还有「这个功能很强大」这类没信息量的过渡话。插件**不用正则去猜**这些——判定由模型给，程序只做三件事：成批送判、把结果记账、保证可回滚。

- 学完（`bili_learn`）把这一页的卡片成批（默认 12 张一批）送模型判 `knowledge` / `ad` / `filler`，每张附一句不超过 12 字的理由。
- 判成 `ad`/`filler` 的卡片从 `cards.json` 移到 `filtered.json`（判定与理由一起存，**没有真删**），`cards.md` 文末列出「已筛掉」清单与原因。
- 模型判不了的（空正文、漏了 id）**一律保留**，只记 `uncertain`——没有判定就不删。
- 提示词里写死保守条款：「拿不准就写 knowledge——宁可留下，绝不误删知识」。
- `bili_filter`：`scan` 预览（判定按卡片指纹缓存进 `judgments.json`，重跑不重复调用）→ `apply` 落账 → `restore` 放回并**钉住**（`pinned.json`，以后重学重筛都不再动它）→ `stats` 汇总全库。
- 提取阶段就要求模型别产这类卡片；整段只有广告/口水时模型输出 `[]`，该段标 `noise`——与「没读到字幕」的 `unread` 区分开。

真机验收（本机 qwen、真实知识库）：20 页共 168 张卡，22 次调用约 8 分钟，模型挑出 7 张——1 张教程运营计划 + 6 张口水话（如「本段结束景别内容，其他内容以后讲」「掌握这两点即可上手画分镜」），其余 161 张知识卡**零误杀**。另一个样本 4 张卡 1 次调用 9 秒，判掉「评论区扣关键词领模板」那张（理由：评论区领资料引流）。复跑：`node tests/judge-live.mjs <BV号,...>`（单进程串行，只写判定缓存，绝不动卡片）。

## 规模上去以后：SQLite 只做候选召回

库里到几千张卡之后，「每次检索把 JSON 全扫一遍」会线性变慢。实测（真实库 342 页 / 1546 卡 / 48033 讲稿行，全库 JSON 11.3 MB）：单查询 **195 ms → 1 ms**；100× 规模（34200 页 / 154600 卡）外推 **29 秒/查询**，而索引路线仍是毫秒。

- `bili.sqlite` 是**派生缓存**，不是真相源：`bili_index action=rebuild` 2.4 秒重建完；删掉它就自动回退 JSON 路线，不丢任何知识。
- **排序口径只有一套**：SQLite 只负责「卡片里出现了任一个查询词元」的候选召回——那正是打分 >0 的必要条件，所以候选集是 JSON 结果的超集；最终排序仍由同一套 `scoreCard` / 比较器决定。把 bm25 直接当最终排序是错的：实测 60 个查询里有 250 条命中与 JSON 路线对不上。
- 中文必须用 **bigram 灌 `fts5(tokenize='unicode61')`**：`trigram` 对「景别」「轴线」这类两字词完全不命中（实测 0 条）。
- 依赖为零：Node ≥ 22.5 自带 `node:sqlite`（FTS5 可用）；不可用时自动退回 JSON 路线，`sqliteIndex: false` 可整体关掉。

验收（真实库，不是合成数据）：`node tests/db-verify.mjs` → 60 个查询（含中英混排、专有名词）卡片 top8 **逐条一致、顺序一致、漏 0 条**；讲稿行 5 组一致；跨页待复习列表一致；整体 17.8× 提速。`bili_index action=verify` 把同样的双跑做成随手可跑的工具调用。

## 安装

1. 把 `dsh-bili-learn/` 放进 DSH 的插件目录（或通过插件管理安装）。插件通过 `cordis.patch.yml` 注册，启动期配置需要重启生效。
2. 关键配置（`cordis.patch.yml` 的 `config`）：

| 键 | 默认 | 说明 |
|---|---|---|
| `kbDir` | 空 = `$DSH_HOME/bili-kb` | 知识库根目录 |
| `cookie` | 空 | 浏览器整条 Cookie，或只填 `SESSDATA`。**读字幕必需** |
| `cookieFile` | 空 = `<kbDir>/cookie.txt` | 把 Cookie 放文件里，**每次调用重读**，换 Cookie 不必重启 |
| `cookiesFromBrowser` | `edge` | 让 yt-dlp 从浏览器读登录态；浏览器正在运行时 Cookie 库会被锁，要先完全退出浏览器 |
| `distill` / `distillProvider` / `distillModel` | `true` / 空 / 空 | 提取卡片的模型；留空 = 当前会话默认模型（可以是完全本地的模型） |
| `segmentMinutes` / `maxCardsPerSegment` | `8` / `5` | 分段长度与每段卡片上限 |
| `distillMaxTokens` | `2500` | 短输出 + 失败重试一次（思考型模型长输出会翻车） |
| `judgeAfterLearn` / `judgeBatch` / `judgeMaxTokens` | `true` / `12` / `1600` | 卡片质检：成批送模型判 `ad`/`filler`。判定由模型给，插件里没有任何广告正则 |
| `sqliteIndex` | `true` | 检索索引层（SQLite）。设 `false` 就完全走 JSON 全扫；索引只是缓存，随时可删 |
| `maxLearnMinutes` | `0` | `0` = 整段都学；`>0` 只学前 N 分钟 |
| `injectIndex` | `true` | 把「已学会什么」的紧凑索引注入系统提示 |
| `qrPython` / `qrPng` | `python` / 空 | 二维码本地渲染（**不把登录令牌交给任何第三方**） |
| `ffmpeg` | 空 | 留空则自动找 PATH 上的 ffmpeg，再退回 `imageio-ffmpeg` 自带二进制 |
| `skillsDir` | 空 = `<kbDir>/../skills` | `bili_skill` 生成技能的落盘位置 |

## 登录（读字幕的前提）

B 站对匿名请求不下发字幕轨。两条路：

1. **推荐：`bili_login` 扫码**。`action=start` 在本地渲染二维码 PNG，手机 B 站 App 扫一下，`action=poll` 就把会话 Cookie 写进 `cookieFile`。不需要密码、不需要浏览器。
2. 手动填 `cookie` 或写 `cookieFile`。**别用 `document.cookie`**：`SESSDATA` 是 HttpOnly，控制台拿不到，缺它照样读不到字幕。

> ⚠️ **安全提醒**：`cookie.txt` 等于账号钥匙（含 `SESSDATA` 与 `bili_jct`）。它已被 `.gitignore` 排除，但请：用次要账号、别把它提交到任何仓库、一旦怀疑泄露立刻在 B 站退出登录以轮换会话。

## 一次真实闭环（本仓库自带样例）

```
bili_search  →  挑教程
bili_learn   →  5 期教程，27 张带时间戳的卡片
bili_recall  →  写分镜前先把相关卡片捞出来
bili_skill   →  生成技能 skills/h3-blocking-performance/SKILL.md
```

仓库里 `skills/h3-blocking-performance/SKILL.md` 就是这条链路的产物：一份关于「AI 视频的人物站位、镜头衔接与表演」的可复用规则清单，每条规则都挂着原视频的时间戳链接，另外标注了哪些结论来自本地实测而非教程。

`examples/bili-kb/` 是一个学完的视频长什么样：

```
examples/bili-kb/BV1tRxt68EZa/
  source.json     元数据（标题、UP 主、时长、字幕轨）
  segments.json   分段边界
  outline.md      分段大纲
  cards.md        知识卡片（结论 / 为什么 / 怎么做 / 证据时间戳）
  cards.json      同样内容的机器可读版
  study.md        学习小结与覆盖度
```

**讲稿全文（`transcript.md` / `transcript.json`）故意不入库**——那是第三方视频的完整转录，版权归 UP 主。卡片里只保留必要的短引用。

## 测试

```bash
node tests/selftest.mjs   # PASS 83 checks   纯函数与知识库门禁（系列进度、多 P 互不覆盖、质检记账与回滚、索引层两条路一致、长段截断切半补救）
node tests/tool-test.mjs  # PASS 12 tools    用假 ctx 驱动 12 个真实工具，验证输出无损
node tests/db-smoke.mjs   # 索引层冒烟：建/镜像/增量/重建/删掉后自动回退 JSON
node tests/db-verify.mjs  # 可选：拿你自己的知识库做双跑验收（卡片逐条一致 + 讲稿行 + 待复习 + 计时）
node tests/relearn.mjs    # 可选：只重跑 status=unread 的段（补提取，按 id 去重追加）
node tests/judge-live.mjs # 可选：真模型 + 你自己的知识库，验收判定质量（只写缓存，不动卡片）
```

CI 每次推送都跑第一个门禁；第二个会真的访问 B 站接口，数据中心 IP 可能被限流，因此允许失败（见 [`.github/workflows/ci.yml`](.github/workflows/ci.yml)）。版本记录在 [CHANGELOG.md](CHANGELOG.md)。

## 隐私

本仓库不含 Cookie、账号 ID、会话令牌或本机绝对路径。提交历史使用 GitHub noreply 邮箱。
`.gitignore` 已覆盖 `cookie.txt`、`**/bili-kb/`（样例目录除外）、`.out/`、`*.log`。

## 许可

代码与文档采用 [CC BY-NC 4.0](LICENSE)（署名、非商业）。
卡片与技能中对第三方视频的引用为**短引用 + 时间戳 + 回链**，相应内容的版权归各 UP 主所有；如认为引用越界，请开 Issue，核实后移除。
