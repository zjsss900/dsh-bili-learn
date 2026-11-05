// dsh-bili-learn：把 B 站视频读成带时间锚点的知识卡片，并在后续会话里检索、复习、应用。
//
// 设计要点
// 1. 证据链优先：卡片必须挂时间戳，能回跳原视频；读不到就如实标 unread，不假装学会。
// 2. 学会 ≠ 读过：卡片进入知识库后，靠 bili_recall 检索 + bili_practice 复习闭环把知识变成可调用能力。
// 3. 只用宿主已有能力：网络用 fetch，提取用宿主配置的模型（默认就是本地 qwen），不引入第三方依赖。

import fs from 'node:fs';
import path from 'node:path';
import { BiliClient, normalizeCookie, parsePageIndex, parseVideoRef } from './lib/bili.js';
import { KnowledgeBase, defaultKbRoot } from './lib/kb.js';
import { distillSegments } from './lib/distill.js';
import { grabFrame, playurlMp4, resolveFfmpeg } from './lib/frames.js';
import { buildSkill, slugify, writeSkill } from './lib/skill.js';
import { pollQrLogin, renderQrPng, startQrLogin, whoami, writeCookieFile } from './lib/login.js';
import { fetchSubtitlesWithYtDlp, parseSubtitleFile } from './lib/subs.js';
import { clip, formatTime, parseTranscriptText, segmentTranscript, topTerms } from './lib/text.js';

export const inject = ['tools'];

const DEFAULTS = {
  kbDir: '',
  cookie: '',
  // 每次调用都重读这个文件，所以换 Cookie 不必重启 DSH。默认 <kbDir>/cookie.txt。
  cookieFile: '',
  // 扫码登录的二维码图渲染器（可选）。缺了就退回返回登录 URL。
  qrPython: 'python',
  qrPng: '',
  // 取帧：留空则自动找 PATH 上的 ffmpeg 或 python imageio-ffmpeg 自带的二进制。
  ffmpeg: '',
  frameQuality: 32,
  // 生成技能写到这里（留空 = <kbDir>/../skills，即 ~/.dsh/skills）。
  skillsDir: '',
  cookiesFromBrowser: '',
  ytDlp: 'yt-dlp',
  distill: true,
  distillProvider: '',
  distillModel: '',
  segmentMinutes: 8,
  maxCardsPerSegment: 5,
  distillMaxTokens: 2500,
  maxLearnMinutes: 0,
  injectIndex: true,
};

const SKILL_BODY = `# B 站视频学习闭环（dsh-bili-learn）

目标：把视频里的知识变成你在后续任务里能调用的能力，而不是生成一份摘要。

## 工具
- \`bili_search\`：按关键词找候选视频（匿名可用）。
- \`bili_learn\`：读视频 → 讲稿（带时间戳）→ 分段大纲 → 知识卡片，落盘到知识库。
- \`bili_recall\`：按问题检索已学会的卡片与讲稿证据（返回时间戳和回跳链接）。
- \`bili_note\`：由你（模型）直接写/改知识卡片。
- \`bili_practice\`：列出待复习卡片（\`due\`）、记录自测结果（\`grade\`），驱动间隔复习。
- \`bili_status\`：知识库总览（学了哪些、卡片数、待复习数、告警）。
- \`bili_login\`：扫码登录 B 站（action=start 出二维码 → 用户扫码 → action=poll 写入 Cookie）。读字幕需要登录态。
- \`bili_frame\`：按秒数抽帧存成本地图片，用 \`read_image\` 看画面。
- \`bili_skill\`：把已学会的卡片组装成 DSH 技能（SKILL.md，带证据回跳链接），写进技能目录。

## 标准流程
1. 用户给出视频链接 → \`bili_learn\`。看返回里的 \`coverage\` 与 \`warnings\`：
   - 报「没有字幕/匿名拿不到字幕」→ 调 \`bili_login\` 让用户扫码，Cookie 会写进 cookieFile，之后重跑即可；不要凭空编造内容。
   - 用户手上有文稿 → 直接传 \`transcript_path\` / \`transcript_text\`。
2. **画面比字幕多信息**：讲稿里出现「看这个画面 / 如图所示 / 参数如下 / 核心提示词：…」，或卡片涉及界面操作、参数、对比效果时，用 \`bili_frame\` 按 evidence 的秒数抽帧，再 \`read_image\` 看。实测教程视频会把提示词原文、参数、UI 只画在画面上，语音字幕里没有。
3. 提取完成后，**自己复核卡片**：读 \`cards.md\`，对照 \`transcript.md\` 的时间锚点，用 \`bili_note\` 修正含糊、错误或缺失的卡片（模型自己写的卡片比自动提取更可靠）。发现整片字幕与主题无关（如无旁白的效果展示片）→ 用 \`bili_note\` 的 \`replace: true\` 换成诚实的说明卡。
4. 用 \`bili_practice\`（action=due）取待复习卡片，逐张自测：先不看答案复述「结论/为什么/怎么做」，再用 action=grade 记录 ok/miss。
5. 想把知识变成可复用能力：\`bili_skill\` 把若干视频的卡片组装成 SKILL.md（写进技能目录，每条挂回跳链接），然后**读一遍并精修**措辞、合并重复、补上与其他技能的分工。技能需要重启或新会话才会出现在技能列表。
6. 之后任何相关任务，先 \`bili_recall\` 检索知识库（或直接用生成的技能），再据此作答或写代码，并说明依据来自哪个时间点。

## 诚实规则
- 卡片必须有时间戳证据；没有证据的判断标 \`confidence: low\` 或直接不写。
- 分段状态是 \`unread\` 的，明确告诉用户「这段没读懂」，不要用它做结论。
- 引用知识库内容时给出 \`https://www.bilibili.com/video/BVxxx?t=秒\` 形式的回跳链接。
`;

const TOOL_TEXT = (value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }];

export function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...(config ?? {}) };
  const kb = new KnowledgeBase(cfg.kbDir || defaultKbRoot());
  const disposers = [];

  /**
   * 登录态来源优先级：config.cookie → cookieFile → <kbDir>/cookie.txt。
   * 文件每次调用重读，换 Cookie 不用重启宿主。
   */
  function readCookie() {
    if (cfg.cookie) return cfg.cookie;
    const file = cfg.cookieFile || path.join(kb.root, 'cookie.txt');
    try {
      const text = fs.readFileSync(file, 'utf8').trim();
      if (text) return text;
    } catch {
      /* 没有文件就是匿名 */
    }
    return '';
  }

  const client = () => new BiliClient({ cookie: normalizeCookie(readCookie()) });

  /** 宿主默认模型，或配置里指定的提取模型。 */
  function resolveModel() {
    if (cfg.distillProvider && cfg.distillModel) return { provider: cfg.distillProvider, model: cfg.distillModel };
    const selection = ctx.get?.('agentDefaultModel')?.currentSelection?.();
    if (selection?.provider && selection?.model) return { provider: selection.provider, model: selection.model };
    return undefined;
  }

  async function acquireTranscript({ meta, page, args, warnings, signal }) {
    // 1) 用户直接给的文稿最可信。
    if (args.transcript_path) {
      const raw = fs.readFileSync(args.transcript_path, 'utf8');
      const lines = parseTranscriptText(raw);
      if (lines.length > 0) return { lines, source: 'user-file', note: args.transcript_path };
      warnings.push(`transcript_path 解析后为空：${args.transcript_path}`);
    }
    if (args.transcript_text) {
      const lines = parseTranscriptText(args.transcript_text);
      if (lines.length > 0) return { lines, source: 'user-text', note: '用户粘贴的文稿' };
      warnings.push('transcript_text 解析后为空');
    }

    const bili = client();
    // 2) B 站字幕轨（登录后可见 AI 字幕与 CC 字幕）。
    try {
      const tracks = await bili.subtitleTracks(meta.bvid, page.cid, { signal });
      if (tracks.length > 0) {
        const ranked = [...tracks].sort((a, b) => (a.ai_type || 0) - (b.ai_type || 0) || (a.lan.startsWith('zh') ? -1 : 1));
        const chosen = ranked[0];
        const lines = await bili.fetchSubtitle(chosen.url, { signal });
        if (lines.length > 0) {
          return { lines, source: chosen.ai_type ? 'bilibili-ai' : 'bilibili-cc', note: `${chosen.lan_doc || chosen.lan}（ai_type=${chosen.ai_type}）` };
        }
        warnings.push(`字幕轨 ${chosen.lan} 下载成功但没有内容`);
      } else if (!bili.loggedIn) {
        warnings.push('未取到字幕轨：B 站对匿名请求通常不下发字幕。请在插件 config 里填 cookie（浏览器里的整条 Cookie 或 SESSDATA），或提供 transcript_path。');
      } else {
        warnings.push('已登录但没有字幕轨：该视频可能确实没有 CC/AI 字幕。');
      }
    } catch (error) {
      warnings.push(`字幕接口失败：${error.message}`);
    }

    // 3) yt-dlp 兜底（可复用浏览器登录态）。
    if (cfg.cookiesFromBrowser) {
      try {
        const workDir = fs.mkdtempSync(`${kb.root}-subs-`);
        const files = await fetchSubtitlesWithYtDlp({
          url: `${meta.url}?p=${page.index}`,
          workDir,
          browser: cfg.cookiesFromBrowser,
          bin: cfg.ytDlp,
          signal,
        });
        for (const file of files) {
          const lines = parseSubtitleFile(file.file, file.format);
          if (lines.length > 0) return { lines, source: `ytdlp-${file.format}`, note: `cookies-from-browser=${cfg.cookiesFromBrowser}` };
        }
        warnings.push('yt-dlp 拿到的字幕文件都是空的（可能只有弹幕）。');
      } catch (error) {
        warnings.push(`yt-dlp 兜底失败：${error.message}${error.detail ? `｜${clip(error.detail, 200)}` : ''}`);
      }
    }
    return { lines: [], source: 'none', note: '没有拿到任何讲稿' };
  }

  // ---------------------------------------------------------------- 工具
  disposers.push(
    ctx.tools.register({
      name: 'bili_learn',
      description:
        '学习一个 B 站视频：抓元数据与字幕（带时间戳讲稿）→ 分段 → 提取知识卡片，写入本地知识库。返回产物路径、覆盖度与告警。字幕需要登录态：可在插件 config 配 cookie，或传 transcript_path/transcript_text。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string', description: 'B 站视频链接、BV 号或 av 号' },
          page: { type: 'integer', description: '分 P 序号（默认取链接里的 ?p=，否则 1）' },
          transcript_path: { type: 'string', description: '本地文稿路径（JSON 或带 [mm:ss] 的文本），优先于在线字幕' },
          transcript_text: { type: 'string', description: '直接粘贴的文稿' },
          distill: { type: 'boolean', description: '是否调用模型提取卡片（默认按插件配置）' },
          max_minutes: { type: 'integer', description: '只学前 N 分钟（0=全部）' },
          force: { type: 'boolean', description: '已学过也重新抓取提取' },
        },
        required: ['url'],
      },
      output: { schema: { type: 'object' }, render: (_args, value) => TOOL_TEXT(value) },
      timeoutMs: 3600000,
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        const warnings = [];
        const bili = client();
        const ref = parseVideoRef(args.url);
        const meta = await bili.view(ref, { signal: exec.signal });
        const pageIndex = Number(args.page ?? parsePageIndex(args.url) ?? 1) || 1;
        const page = meta.pages.find((p) => p.index === pageIndex) ?? meta.pages[0];
        if (!page) throw new Error(`${meta.bvid} 没有可用分 P`);

        const existing = kb.load(meta.bvid);
        if (existing?.cards?.length && args.force !== true) {
          return {
            ok: true,
            skipped: true,
            bvid: meta.bvid,
            title: meta.title,
            cards: existing.cards.length,
            note: '已学过。要重学传 force=true；要补卡片用 bili_note。',
            paths: { dir: kb.videoDir(meta.bvid) },
          };
        }

        const acquired = await acquireTranscript({ meta, page, args, warnings, signal: exec.signal });
        let lines = acquired.lines;
        let sourceNote = acquired.note;
        let sourceKind = acquired.source;
        // 没拿到新讲稿时，绝不覆盖已落盘的讲稿——否则一次失败的重新学习会毁掉已有知识。
        if (lines.length === 0 && existing?.lines?.length > 0) {
          lines = existing.lines;
          sourceKind = existing.meta?.transcriptSource ?? 'kept';
          sourceNote = `保留已有讲稿（${existing.lines.length} 行），本次没有取到新讲稿`;
          warnings.push('本次没有拿到讲稿，已保留原有讲稿与分段。');
        }

        const cap = Number(args.max_minutes ?? cfg.maxLearnMinutes) || 0;
        if (cap > 0 && lines.length > 0) {
          const limited = lines.filter((l) => l.t <= cap * 60);
          if (limited.length < lines.length) warnings.push(`只学前 ${cap} 分钟（${limited.length}/${lines.length} 行）`);
          lines = limited;
        }

        const segments = segmentTranscript(lines, { maxMinutes: cfg.segmentMinutes });
        for (const segment of segments) segment.terms = topTerms(segment.lines, 8);

        let cards = [];
        let distillReport = undefined;
        const wantDistill = args.distill ?? cfg.distill;
        if (segments.length > 0 && wantDistill) {
          const llm = ctx.get?.('llm');
          const model = resolveModel();
          if (!llm || !model) {
            warnings.push('没有可用的提取模型（llm 服务或默认模型缺失），只产出讲稿与大纲，卡片请用 bili_note 手写。');
          } else {
            const result = await distillSegments({
              llm,
              provider: model.provider,
              model: model.model,
              meta: { ...meta, title: `${meta.title}（P${page.index}${page.part ? ` ${page.part}` : ''}）` },
              segments,
              maxCardsPerSegment: cfg.maxCardsPerSegment,
              maxTokens: cfg.distillMaxTokens,
              signal: exec.signal,
            });
            cards = result.cards;
            distillReport = { model: `${model.provider}/${model.model}`, ...result.segmentReports.reduce(
              (acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }),
              { distilled: 0, unread: 0 },
            ), perSegment: result.segmentReports.filter((r) => r.status === 'unread') };
            if (cards.length === 0) warnings.push('模型没有产出任何卡片：讲稿已落盘，请自己读 transcript.md 并用 bili_note 写卡片。');
          }
        }

        const source = {
          bvid: meta.bvid,
          aid: meta.aid,
          cid: page.cid,
          page: page.index,
          part: page.part,
          title: meta.title,
          owner: meta.owner,
          duration: meta.duration,
          url: meta.url,
          pubdate: meta.pubdate,
          stat: meta.stat,
          tags: await bili.tags(meta.bvid, { signal: exec.signal }),
          description: clip(meta.description, 2000),
          transcriptSource: sourceKind,
          transcriptNote: sourceNote,
          coverage: {
            lines: lines.length,
            seconds: lines.length > 0 ? Math.round(Math.max(...lines.map((l) => l.t))) : 0,
            videoSeconds: page.duration || meta.duration,
            segments: segments.length,
            distilled: segments.filter((s) => s.status === 'distilled').length,
            unread: segments.filter((s) => s.status === 'unread').length,
            loggedIn: bili.loggedIn,
          },
          learnedAt: new Date().toISOString(),
        };
        kb.saveVideo({ meta: source, lines, segments, cards, warnings });

        return {
          ok: true,
          bvid: meta.bvid,
          title: meta.title,
          page: { index: page.index, part: page.part, duration: page.duration },
          transcript: { source: sourceKind, lines: lines.length, note: sourceNote },
          coverage: source.coverage,
          cards: cards.length,
          ...(distillReport ? { distill: distillReport } : {}),
          warnings,
          paths: {
            dir: kb.videoDir(meta.bvid),
            transcript: `${meta.bvid}/transcript.md`,
            outline: `${meta.bvid}/outline.md`,
            cards: `${meta.bvid}/cards.md`,
            study: `${meta.bvid}/study.md`,
          },
          next: cards.length > 0
            ? '复核 cards.md（对照 transcript.md 的时间锚点），必要时用 bili_note 修正；然后 bili_practice 自测。'
            : lines.length > 0
              ? '读 transcript.md 后用 bili_note 写卡片。'
              : '补齐字幕来源：插件 config 填 cookie，或提供 transcript_path。',
        };
      },
    }),
  );

  disposers.push(
    ctx.tools.register({
      name: 'bili_recall',
      description: '在已学会的 B 站知识库里检索知识卡片与讲稿证据（返回时间戳与回跳链接）。做相关任务前先调用它，把学到的知识用起来。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', description: '问题或关键词（中文/英文都行）' },
          bvid: { type: 'string', description: '限定某个视频（BV 号）' },
          limit: { type: 'integer', description: '最多返回多少条（默认 8）' },
          with_lines: { type: 'boolean', description: '是否同时检索讲稿原文（默认 true）' },
        },
        required: ['query'],
      },
      output: { schema: { type: 'object' }, render: (_args, value) => TOOL_TEXT(value) },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const hits = kb.search(args.query, { bvid: args.bvid, limit: Number(args.limit ?? 8), withLines: args.with_lines !== false });
        const empty = hits.cards.length === 0 && hits.lines.length === 0;
        return {
          ok: true,
          query: args.query,
          cards: hits.cards.map((c) => ({
            id: c.id,
            bvid: c._video.bvid,
            title: c.title,
            kind: c.kind,
            claim: c.claim,
            why: c.why,
            how: c.how,
            confidence: c.confidence,
            evidence: (c.evidence ?? []).map((e) => ({ t: formatTime(e.t), jump: `https://www.bilibili.com/video/${c._video.bvid}?t=${Math.floor(e.t)}`, quote: clip(e.quote, 160) })),
          })),
          lines: hits.lines.map((l) => ({ bvid: l.bvid, t: formatTime(l.t), text: clip(l.text, 200), jump: l.url })),
          note: empty ? '知识库里没有相关内容；可能还没学这个视频（bili_learn），或需要换关键词。' : '先按卡片作答，再用 jump 链接核对原视频。',
        };
      },
    }),
  );

  disposers.push(
    ctx.tools.register({
      name: 'bili_practice',
      description: '复习闭环：action=due 列出待复习卡片（含提问），action=grade 记录自测结果（ok/miss）并更新熟练度与下次复习时间。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['due', 'grade'], description: 'due=取待复习卡片；grade=记录结果' },
          bvid: { type: 'string', description: '限定视频（BV 号）；due 时可省略，逐个视频返回' },
          limit: { type: 'integer', description: 'due 的返回上限（默认 20）' },
          results: {
            type: 'array',
            description: 'grade 的结果数组',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                card_id: { type: 'string' },
                verdict: { type: 'string', enum: ['ok', 'miss'] },
              },
              required: ['card_id', 'verdict'],
            },
          },
        },
        required: ['action'],
      },
      output: { schema: { type: 'object' }, render: (_args, value) => TOOL_TEXT(value) },
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        if (args.action === 'grade') {
          if (!args.bvid) throw new Error('grade 需要 bvid');
          if (!Array.isArray(args.results) || args.results.length === 0) throw new Error('grade 需要 results');
          return { ok: true, bvid: args.bvid, applied: kb.applyReview(args.bvid, args.results) };
        }
        const bvids = args.bvid ? [args.bvid] : kb.listVideos().map((v) => v.bvid);
        const items = [];
        for (const id of bvids) items.push(...kb.dueCards(id, { limit: Number(args.limit ?? 20) }).map((c) => ({ bvid: id, ...c })));
        return { ok: true, due: items.slice(0, Number(args.limit ?? 20)), how: '先不看 claim 复述「结论/为什么/怎么做」，再用 action=grade 记录 ok/miss。' };
      },
    }),
  );

  disposers.push(
    ctx.tools.register({
      name: 'bili_note',
      description: '把你自己提炼的知识卡片写入知识库（覆盖同 id）。自动提取不够准时，读 transcript.md 后用它手写卡片；卡片必须带 evidence 时间戳。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          bvid: { type: 'string', description: 'BV 号' },
          cards: {
            type: 'array',
            description: '卡片数组',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', description: '卡片 id（省略则自动分配）' },
                title: { type: 'string' },
                kind: { type: 'string', enum: ['concept', 'procedure', 'fact', 'caution', 'example'] },
                claim: { type: 'string', description: '一句话结论' },
                why: { type: 'string' },
                how: { type: 'array', items: { type: 'string' } },
                evidence: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { t: { type: 'number' }, quote: { type: 'string' } }, required: ['t', 'quote'] } },
                tags: { type: 'array', items: { type: 'string' } },
                confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
              },
              required: ['title', 'claim'],
            },
          },
          replace: { type: 'boolean', description: 'true=只保留本次提交的卡片，删掉该视频其余卡片（用来清掉自动提取的废卡）' },
        },
        required: ['bvid', 'cards'],
      },
      output: { schema: { type: 'object' }, render: (_args, value) => TOOL_TEXT(value) },
      isConcurrencySafe: () => false,
      async execute(args) {
        const total = kb.saveCards(args.bvid, args.cards, { source: 'agent', replace: Boolean(args.replace) });
        return { ok: true, bvid: args.bvid, cards: total, path: `${args.bvid}/cards.md` };
      },
    }),
  );

  disposers.push(
    ctx.tools.register({
      name: 'bili_status',
      description: '查看 B 站知识库总览：学过哪些视频、卡片数、已掌握数、待复习数、告警与存放位置。',
      parameters: { type: 'object', additionalProperties: false, properties: {}, required: [] },
      output: { schema: { type: 'object' }, render: (_args, value) => TOOL_TEXT(value) },
      isConcurrencySafe: () => true,
      async execute() {
        const stats = kb.stats();
        const cookie = readCookie();
        const cookieFile = cfg.cookieFile || path.join(kb.root, 'cookie.txt');
        return {
          ok: true,
          ...stats,
          config: {
            cookie: cookie ? (/SESSDATA=/.test(cookie) ? '已配置（含 SESSDATA）' : '已配置（不含 SESSDATA，可能读不到字幕）') : '未配置',
            cookieFile,
            cookiesFromBrowser: cfg.cookiesFromBrowser || '未配置',
            distill: cfg.distill,
            model: resolveModel(),
          },
        };
      },
    }),
  );

  disposers.push(
    ctx.tools.register({
      name: 'bili_login',
      description:
        'B 站扫码登录（不需要密码、不需要浏览器）。action=start 生成二维码并给出 PNG 路径与登录 URL；action=poll 轮询一次，用户扫码确认后自动把会话 Cookie 写入 cookieFile（之后 bili_learn 就能读到字幕）；action=status 查看当前登录身份。二维码约 3 分钟过期。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['start', 'poll', 'status'] },
          qrcode_key: { type: 'string', description: 'poll 时传 action=start 返回的 qrcode_key' },
        },
        required: ['action'],
      },
      output: { schema: { type: 'object' }, render: (_args, value) => TOOL_TEXT(value) },
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        const cookieFile = cfg.cookieFile || path.join(kb.root, 'cookie.txt');
        if (args.action === 'start') {
          const { url, key } = await startQrLogin({ signal: exec.signal });
          const png = cfg.qrPng || path.join(kb.root, 'login-qr.png');
          let qrPng = '';
          let note = '用 B 站手机 App 扫码确认，然后调 action=poll。';
          try {
            qrPng = await renderQrPng(url, png, { python: cfg.qrPython, signal: exec.signal });
          } catch (error) {
            note = `${error.message}｜也可以直接用手机打开 url 再扫码。`;
          }
          return { ok: true, action: 'start', qrcode_key: key, qr_png: qrPng, url, note };
        }
        if (args.action === 'poll') {
          if (!args.qrcode_key) throw new Error('poll 需要 qrcode_key（来自 action=start）');
          const result = await pollQrLogin(args.qrcode_key, { signal: exec.signal });
          if (result.state === 'confirmed') {
            writeCookieFile(cookieFile, result.cookie);
            const who = await whoami(result.cookie, { signal: exec.signal });
            return {
              ok: true,
              state: 'confirmed',
              cookieFile,
              fields: result.fields ?? [],
              user: { mid: who.mid, uname: who.uname },
              note: 'Cookie 已写入，bili_learn 每次调用都会重读，不用重启 DSH。',
            };
          }
          return {
            ok: result.state !== 'denied' && result.state !== 'expired',
            state: result.state,
            note: result.message ?? '',
          };
        }
        const who = await whoami(readCookie(), { signal: exec.signal });
        return {
          ok: true,
          action: 'status',
          state: who.isLogin ? 'logged-in' : 'anonymous',
          cookieFile,
          user: { mid: who.mid, uname: who.uname },
        };
      },
    }),
  );

  disposers.push(
    ctx.tools.register({
      name: 'bili_search',
      description: '在 B 站搜索候选学习视频（标题、UP 主、时长、播放量），用于决定该学哪个视频。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          keyword: { type: 'string' },
          limit: { type: 'integer', description: '最多返回多少条（默认 10）' },
        },
        required: ['keyword'],
      },
      output: { schema: { type: 'object' }, render: (_args, value) => TOOL_TEXT(value) },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const results = await client().search(args.keyword, { limit: Number(args.limit ?? 10), signal: exec.signal });
        return { ok: true, keyword: args.keyword, results };
      },
    }),
  );

  disposers.push(
    ctx.tools.register({
      name: 'bili_frame',
      description:
        '从 B 站视频抽帧存成本地图片，用 read_image 看画面。很多教程把「提示词原文、参数、软件界面、对比效果」只写在画面上，语音字幕里根本没有——需要核对画面时就抽帧。实测教程视频画面上的「核心提示词：……」这类文字只能靠看，不能靠字幕。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string', description: 'B 站链接、BV 号或 av 号' },
          times: { type: 'array', items: { type: 'number' }, description: '要抽的秒数（最多 8 个，建议用卡片 evidence 的 t）' },
          page: { type: 'integer', description: '分 P 序号（默认取链接里的 ?p=，否则 1）' },
        },
        required: ['url', 'times'],
      },
      output: { schema: { type: 'object' }, render: (_args, value) => TOOL_TEXT(value) },
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        const bili = client();
        const ref = parseVideoRef(args.url);
        const meta = await bili.view(ref, { signal: exec.signal });
        const pageIndex = Number(args.page ?? parsePageIndex(args.url) ?? 1) || 1;
        const page = meta.pages.find((p) => p.index === pageIndex) ?? meta.pages[0];
        if (!page) throw new Error(`${meta.bvid} 没有可用分 P`);
        const ffmpeg = resolveFfmpeg({ bin: cfg.ffmpeg, python: cfg.qrPython, signal: exec.signal });
        if (!ffmpeg) {
          return { ok: false, bvid: meta.bvid, frames: [], how: '没有 ffmpeg：装一个、或 config 填 ffmpeg 路径、或 pip install imageio-ffmpeg（自带二进制）。' };
        }
        const mp4 = await playurlMp4(bili, { bvid: meta.bvid, cid: page.cid, qn: cfg.frameQuality, signal: exec.signal });
        const frames = [];
        for (const raw of (args.times ?? []).slice(0, 8)) {
          const t = Math.floor(Number(raw) || 0);
          const file = path.join(kb.videoDir(meta.bvid), 'frames', `t${t}.jpg`);
          try {
            await grabFrame({ ffmpeg, url: mp4.url, referer: meta.url, userAgent: bili.ua, t, outPath: file, signal: exec.signal });
            frames.push({ t, file, ok: true, note: '' });
          } catch (error) {
            frames.push({ t, file: '', ok: false, note: error.message });
          }
        }
        return {
          ok: frames.some((f) => f.ok),
          bvid: meta.bvid,
          quality: mp4.quality,
          frames,
          how: '用 read_image 逐张看。画面上的文字（提示词、参数、UI）通常不在语音字幕里；看完把要点写进卡片。',
        };
      },
    }),
  );

  disposers.push(
    ctx.tools.register({
      name: 'bili_skill',
      description:
        '把已学会的视频知识组装成 DSH 技能（SKILL.md，带 frontmatter、分组正文、每条挂回跳原视频的证据链接），写入技能目录。学完一个或几个视频后用它产出可复用技能；写完需要重启或开新会话才会出现在技能列表里。措辞是自动拼装的草稿，生成后应由模型精修。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          bvids: { type: 'array', items: { type: 'string' }, description: '用哪些视频的知识（BV 号）' },
          name: { type: 'string', description: '技能目录名，用英文/拼音短横线，如 h3-realism-camera' },
          title: { type: 'string', description: '技能标题（默认取 name）' },
          description: { type: 'string', description: 'frontmatter description：这个技能管什么' },
          whenToUse: { type: 'string', description: 'frontmatter whenToUse：什么时候该用它' },
          extra: { type: 'string', description: '要插在正文前面的自定义段落（如与其他技能的分工说明）' },
          force: { type: 'boolean', description: '已存在同名 SKILL.md 时是否覆盖' },
        },
        required: ['bvids', 'name'],
      },
      output: { schema: { type: 'object' }, render: (_args, value) => TOOL_TEXT(value) },
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        const name = slugify(args.name);
        const sources = [];
        const cards = [];
        const missing = [];
        for (const bvid of args.bvids ?? []) {
          const store = kb.load(bvid);
          if (!store?.meta || !store.cards?.length) {
            missing.push(bvid);
            continue;
          }
          sources.push({ bvid, title: store.meta.title, url: store.meta.url, owner: store.meta.owner, duration: store.meta.duration });
          cards.push(...store.cards.map((c) => ({ ...c, _bvid: bvid })));
        }
        if (cards.length === 0) throw new Error(`这些视频在知识库里没有卡片：${missing.join(',') || args.bvids.join(',')}；先 bili_learn`);
        const skillsDir = cfg.skillsDir || path.join(path.dirname(kb.root), 'skills');
        const content = buildSkill({
          name,
          title: args.title ?? args.name,
          description: args.description ?? `从 ${sources.length} 个 B 站视频学到的可复用知识（dsh-bili-learn 自动生成）`,
          whenToUse: args.whenToUse ?? args.description ?? `处理相关任务时使用；每条结论都能回跳原视频核对。`,
          sources,
          cards,
          extra: args.extra ?? '',
        });
        const { file } = writeSkill({ skillsDir, name, content, force: Boolean(args.force) });
        return {
          ok: true,
          file,
          name,
          cards: cards.length,
          sources: sources.map((s) => s.bvid),
          skipped: missing,
          note: '这是拼装草稿：读一遍并精修措辞、删掉互相重复的条目；技能需要重启或新会话才会出现在技能列表。',
        };
      },
    }),
  );

  // ---------------------------------------------------------------- 技能与提示
  const skills = ctx.get?.('skills');
  if (skills) {
    disposers.push(
      skills.register({
        name: 'bili-study',
        description: '用 B 站视频学习知识并在后续任务中应用：精读讲稿、提取带时间戳的知识卡片、复习自测、检索应用。',
        whenToUse: '用户给 B 站链接要求「学会/学一下/以后按这个做」，或需要调用已学过的视频知识时。',
        content: SKILL_BODY,
        source: 'runtime',
        invocation: { modelInvocable: true, userInvocable: true },
      }),
    );
  }

  const systemPrompt = ctx.get?.('systemPrompt');
  if (systemPrompt && cfg.injectIndex) {
    disposers.push(
      systemPrompt.section({
        name: 'bili-learn:index',
        order: 900,
        text: () => {
          const stats = kb.stats();
          if (stats.videos === 0) return '';
          const lines = stats.list.slice(0, 12).map((v) => `- ${v.bvid} ${clip(v.title, 48)}｜${v.cards} 张卡片`);
          return [
            `B 站知识库（${stats.root}）已学会 ${stats.videos} 个视频、${stats.cards} 张卡片，其中 ${stats.due} 张待复习。`,
            ...lines,
            '处理相关任务前先 bili_recall 检索这些知识；需要复习用 bili_practice；新视频用 bili_learn。',
          ].join('\n');
        },
      }),
    );
  }

  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose();
      } catch {
        /* 逐个释放，不因一个失败中断 */
      }
    }
  };
}
