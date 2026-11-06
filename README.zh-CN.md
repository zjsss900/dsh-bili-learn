# dsh-bili-learn · 把 B 站视频「学」成可复用的知识

中文 · [English](README.md)

这不是视频摘要工具。它把视频读成**带时间锚点的知识卡片**，然后在**以后的会话里**检索它、间隔复习它、并把它组装成可复用的技能。

一句话区别：摘要会丢证据，而这里每条结论都挂着「原话 + 第几秒 + 回跳链接」。

```
[00:53] 但这些只是结果模型 → https://www.bilibili.com/video/BV1sLtm61Egx?t=53
```

## 为什么这样做

| 常见问题 | 这个插件的做法 |
|---|---|
| 看完就忘，摘要里没有可核对的出处 | 每张卡片必须带 `evidence: [{t, quote}]`，点开就跳到原视频那一秒 |
| 学完用不上 | `bili_recall` 在相关任务前主动检索；`bili_practice` 按间隔重复提醒你复习 |
| 教程的关键信息只在画面上（提示词、参数、软件界面） | `bili_frame` 按秒抽帧，交给本地视觉模型读画面文字——字幕里根本没有这些 |
| 知识散落，无法复用 | `bili_skill` 把若干视频的知识拼成 `SKILL.md` 技能，每条规则挂回跳链接 |
| 只有某个模型能用 | 提取卡片用哪个模型是可配的（默认当前会话模型，可指向本地模型），不绑定任何厂商 |

## 10 个工具

| 工具 | 作用 |
|---|---|
| `bili_search` | 搜候选视频（标题、UP 主、时长、播放量），用来决定学哪个 |
| `bili_learn` | 抓元数据与字幕 → 分段 → 提取知识卡片，写入本地知识库 |
| `bili_series` | 同一 UP 主的同一系列教程：`find` / `list` / `next` / `learn` / `cluster` |
| `bili_recall` | 在已学知识里检索卡片与讲稿证据（返回时间戳与回跳链接） |
| `bili_practice` | 复习闭环：`due` 列出待复习卡片，`grade` 记录 ok/miss 并更新熟练度与下次复习时间 |
| `bili_note` | 由你自己写卡片覆盖自动提取结果（必须带 `evidence` 时间戳） |
| `bili_status` | 知识库总览：学过哪些视频、卡片数、待复习数、告警 |
| `bili_login` | 扫码登录：出二维码 → 轮询 → 把会话 Cookie 写进 `cookieFile` |
| `bili_frame` | 按秒抽帧存本地图片，配合视觉模型读画面上的文字与界面 |
| `bili_skill` | 把已学知识组装成技能 `SKILL.md`（带 frontmatter、分组正文、每条挂证据链接） |

## 按系列学：同一 UP 主的同一系列教程

教程很少只有一个视频。合集一旦存在，逐集手动喂链接就很蠢——`bili_series` 让 AI 自己顺着合集往下学。

```jsonc
// 1) 给系列里任意一集 → 反查它所属的合集，列出全部集数并标出已学/未学
{ "action": "find", "url": "BVxxxxxxxxxx" }
// → key=season:1234567，total=22，learned=1，missing=21，next=#1 …

// 2) 按合集顺序连学（默认 3 集，上限 10；已学的自动跳过）
{ "action": "learn", "url": "BVxxxxxxxxxx", "limit": 3 }

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
node tests/selftest.mjs   # PASS 39 checks   纯函数与知识库读写门禁（含系列进度）
node tests/tool-test.mjs  # PASS 10 tools    用假 ctx 驱动真实工具，验证输出无损
```

CI 每次推送都跑第一个门禁；第二个会真的访问 B 站接口，数据中心 IP 可能被限流，因此允许失败（见 [`.github/workflows/ci.yml`](.github/workflows/ci.yml)）。版本记录在 [CHANGELOG.md](CHANGELOG.md)。

## 隐私

本仓库不含 Cookie、账号 ID、会话令牌或本机绝对路径。提交历史使用 GitHub noreply 邮箱。
`.gitignore` 已覆盖 `cookie.txt`、`**/bili-kb/`（样例目录除外）、`.out/`、`*.log`。

## 许可

代码与文档采用 [CC BY-NC 4.0](LICENSE)（署名、非商业）。
卡片与技能中对第三方视频的引用为**短引用 + 时间戳 + 回链**，相应内容的版权归各 UP 主所有；如认为引用越界，请开 Issue，核实后移除。
