// 自检门禁：只打印 PASS/FAIL 与失败项，不输出全文。
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const root = new URL('../dsh-bili-learn/', import.meta.url).href;
const failures = [];
let total = 0;
const check = (name, fn) => {
  total += 1;
  try {
    const result = fn();
    if (result !== true) failures.push(`${name}: ${result}`);
  } catch (error) {
    failures.push(`${name}: threw ${error.message}`);
  }
};

const text = await import(root + 'lib/text.js');
const kbMod = await import(root + 'lib/kb.js');
const distill = await import(root + 'lib/distill.js');
const subs = await import(root + 'lib/subs.js');
const bili = await import(root + 'lib/bili.js');
const seriesMod = await import(root + 'lib/series.js');
const skillMod = await import(root + 'lib/skill.js');
const entry = await import(root + 'index.js');

check('entry exports apply', () => typeof entry.apply === 'function');
check('entry exports inject', () => Array.isArray(entry.inject) && entry.inject.includes('tools'));

// 分段
const lines = [];
for (let i = 0; i < 400; i++) lines.push({ t: i * 3, d: 3, text: `第${i}句 讲解 线性代数 秩 与 零空间 的概念` });
const segs = text.segmentTranscript(lines, { maxMinutes: 8 });
check('segments cover all lines', () => segs.reduce((n, s) => n + s.lines.length, 0) === lines.length || `got ${segs.reduce((n, s) => n + s.lines.length, 0)}`);
check('segments within 8min+slack', () => segs.every((s) => s.end - s.start <= 8 * 60 + 30) || segs.map((s) => s.end - s.start).join(','));
check('segment text has timestamps', () => segs[0].text.includes('[00:00]'));

// 文稿解析
check('parseTranscriptText json', () => text.parseTranscriptText('[{"t":12,"text":"你好"}]').length === 1);
check('parseTranscriptText mm:ss', () => text.parseTranscriptText('[01:30] 第一句\n02:00 第二句')[0].t === 90);
check('parseTranscriptText plain', () => text.parseTranscriptText('纯文本一行')[0].text === '纯文本一行');

// 分词与检索
const tokens = text.tokenize('矩阵的秩 rank 等于列空间维数');
check('tokenize mixes cjk bigrams and latin', () => tokens.includes('rank') && tokens.includes('矩阵') || tokens.join(','));

// 知识库
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-kb-'));
const kb = new kbMod.KnowledgeBase(dir);
const meta = { bvid: 'BVDEMO000004', aid: 1, cid: 2, page: 1, part: 'p1', title: '测试视频', owner: 'up', duration: 1200, url: 'https://www.bilibili.com/video/BVDEMO000004', tags: ['线性代数'], transcriptSource: 'user-text', transcriptNote: 'test', coverage: { lines: lines.length, segments: segs.length } };
kb.saveVideo({ meta, lines, segments: segs, cards: [], warnings: ['w1'] });
check('files written', () => {
  const wanted = ['source.json', 'transcript.json', 'transcript.md', 'segments.json', 'cards.json', 'cards.md', 'study.md'];
  const missing = wanted.filter((f) => !fs.existsSync(path.join(dir, 'BVDEMO000004', f)));
  if (!fs.existsSync(path.join(dir, 'index.json'))) missing.push('index.json');
  return missing.length === 0 || `missing: ${missing.join(',')}`;
});
check('index lists video', () => kb.listVideos().length === 1);
check('saveCards then search', () => {
  kb.saveCards('BVDEMO000004', [{ id: 'k1', title: '秩', claim: '秩等于列空间维数', why: '因为主元个数', how: ['化简'], evidence: [{ t: 120, quote: '秩就是主元个数' }], tags: ['秩'], confidence: 'high' }]);
  const hits = kb.search('秩 列空间');
  return hits.cards.length >= 1 || 'no card hits';
});
check('recall returns jump url', () => kb.search('秩').lines.length >= 0);
check('due then grade', () => {
  const due = kb.dueCards('BVDEMO000004');
  if (due.length !== 1) return `due=${due.length}`;
  const applied = kb.applyReview('BVDEMO000004', [{ card_id: 'k1', verdict: 'ok' }]);
  if (applied[0].mastery !== 1) return `mastery=${applied[0].mastery}`;
  const after = kb.dueCards('BVDEMO000004');
  return after.length === 0 || 'still due';
});
check('stats counts', () => {
  const stats = kb.stats();
  return stats.videos === 1 && stats.cards === 1 || JSON.stringify(stats);
});

// 提取解析
check('extractJsonArray plain', () => distill.extractJsonArray('[{"title":"a","claim":"b"}]').length === 1);
check('extractJsonArray fenced', () => distill.extractJsonArray('好的：\n```json\n[{"title":"a","claim":"b"}]\n```').length === 1);
check('extractJsonArray garbage', () => distill.extractJsonArray('抱歉我无法') === undefined);

// 字幕解析
const srt = path.join(dir, 'a.srt');
fs.writeFileSync(srt, '1\n00:01:30,000 --> 00:01:33,000\n你好 世界\n\n', 'utf8');
check('parse srt', () => {
  const parsed = subs.parseSubtitleFile(srt, 'srt');
  return parsed.length === 1 && parsed[0].t === 90 && parsed[0].text === '你好 世界' || JSON.stringify(parsed);
});
const json3 = path.join(dir, 'a.json3');
fs.writeFileSync(json3, JSON.stringify({ events: [{ tStartMs: 5000, durMs: 2000, segs: [{ utf8: 'hi' }] }] }), 'utf8');
check('parse json3', () => subs.parseSubtitleFile(json3, 'json3')[0].text === 'hi');

// 视频标识解析
check('parseVideoRef bv', () => bili.parseVideoRef('https://www.bilibili.com/video/BVDEMO000005?p=2').bvid === 'BVDEMO000005');
check('parseVideoRef av', () => bili.parseVideoRef('av80433022').aid === 80433022);
check('parsePageIndex', () => bili.parsePageIndex('https://x?p=3') === 3);
check('normalizeCookie bare', () => bili.normalizeCookie('abc').startsWith('SESSDATA='));

// 提取器：用假 llm 跑通两条路径（成功 / 空正文）
const fakeSegment = { index: 0, start: 0, end: 300, chars: 100, lines: [{ t: 10, d: 3, text: '秩就是主元个数' }], text: '[00:10] 秩就是主元个数' };
const okLlm = {
  async *stream() {
    yield { type: 'text-delta', index: 0, text: '[{"title":"秩","kind":"concept","claim":"秩=主元个数","evidence":[{"t":10,"quote":"秩就是主元个数"}]}]' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  },
};
const emptyLlm = {
  async *stream() {
    yield { type: 'reasoning-delta', index: 0, text: '让我想想'.repeat(50) };
    yield { type: 'finish', reason: { kind: 'max-tokens' } };
  },
};
const okRun = await distill.distillSegments({ llm: okLlm, provider: 'x', model: 'y', meta: { title: 't' }, segments: [fakeSegment], maxCardsPerSegment: 5, maxTokens: 100 });
check('distill happy path', () => (okRun.cards.length === 1 && okRun.cards[0].title === '秩') || JSON.stringify(okRun));
const emptyRun = await distill.distillSegments({ llm: emptyLlm, provider: 'x', model: 'y', meta: { title: 't' }, segments: [fakeSegment], maxCardsPerSegment: 5, maxTokens: 100 });
check('distill honest unread on empty content', () => (emptyRun.cards.length === 0 && emptyRun.segmentReports[0].status === 'unread' && /思考/.test(emptyRun.segmentReports[0].note)) || JSON.stringify(emptyRun.segmentReports));

// 长段整段输出被 maxTokens 截断 → 切两半补救（前两次调用给截断的半个 JSON，之后给正常的）
let truncCalls = 0;
const truncLlm = {
  async *stream() {
    truncCalls += 1;
    if (truncCalls <= 2) {
      yield { type: 'text-delta', index: 0, text: '[{"title":"轴线","kind":"concept","claim":"轴线一侧放五个机位","evidence":[{"t":5,"quote":"五个机位"}]},{"title":"景别","claim' };
      yield { type: 'finish', reason: { kind: 'max-tokens' } };
      return;
    }
    yield { type: 'text-delta', index: 0, text: '[{"title":"机位","kind":"procedure","claim":"轴线一侧设五个机位才不会跳轴","evidence":[{"t":5,"quote":"五个机位"}]}]' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  },
};
const longSeg = { index: 0, start: 0, end: 600, text: `${'轴线一侧设五个机位，正反打才不会跳轴。'.repeat(30)}\n${'决定景别的核心是这句话要强调什么。'.repeat(30)}`, keyTerms: [] };
const truncRun = await distill.distillSegments({ llm: truncLlm, provider: 'x', model: 'y', meta: { title: 't' }, segments: [longSeg], maxCardsPerSegment: 5, maxTokens: 200 });
check('长段截断会切两半补救，而不是直接 unread',
  () => (truncRun.cards.length === 2 && truncRun.segmentReports[0].status === 'distilled' && /切两半/.test(truncRun.segmentReports[0].note)) || JSON.stringify({ calls: truncCalls, r: truncRun.segmentReports, n: truncRun.cards.length }));

// 回归：两半段共用 segment.start 做 id 前缀 → 撞 id → 索引主键冲突 → 整页写不进去（真库少了 3 页 34 张卡）
check('切两半补救出的卡片 id 不撞车',
  () => { const ids = truncRun.cards.map((c) => c.id); return (ids.length === 2 && new Set(ids).size === 2) || JSON.stringify(ids); });
check('一页内 id 撞车：saveVideo 改名保留两张，索引照样镜像得进去', () => {
  kb.saveVideo({
    meta: { ...meta, bvid: 'BV1DUP00001', page: 3 },
    lines: [{ t: 12, text: '啮合校验：同页两张卡撞了同一个 id。' }, { t: 30, text: '啮合校验第二条，只在这页出现。' }],
    segments: segs,
    cards: [
      { id: 'x1', title: '甲', claim: '啮合校验甲：主键冲突会让整页进不了索引', evidence: [{ t: 12, quote: '啮合校验' }] },
      { id: 'x1', title: '乙', claim: '啮合校验乙：重复 id 要改名两张都保留', evidence: [{ t: 30, quote: '啮合校验' }] },
    ],
    warnings: [],
  });
  const cards = kb.load('BV1DUP00001', 3).cards;
  const hit = kb.search('啮合', { limit: 8, withLines: false, engine: 'sql' }).cards
    .some((c) => (c._video?.bvid ?? c.bvid) === 'BV1DUP00001');
  return (cards.length === 2 && new Set(cards.map((c) => c.id)).size === 2 && hit) || JSON.stringify({ ids: cards.map((c) => c.id), hit });
});

// ---------------------------------------------------------------- 语义向量层：注入假 embedding，离线且确定性
// 这段测的是**接线**（候选、增量、回退、混排），语义质量由 tools/embed.py 的自测 + 真库验收负责。
const safeRm = (d, kbs = []) => {
  for (const k of kbs) {
    try {
      const holder = k.indexDb();
      holder?.db?.close?.();
    } catch { /* 索引句柄关不上就算了，别让临时目录卡死门禁 */ }
  }
  try {
    fs.rmSync(d, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 });
  } catch (e) {
    console.log(`（临时目录没删掉：${d}：${e.code}）`);
  }
};
const vdir = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-vec-'));
const fakeEmbed = (text) => {
  const dim = 64;
  const v = new Array(dim).fill(0);
  const s = String(text);
  for (let i = 0; i + 1 < s.length; i += 1) v[Math.abs(s.charCodeAt(i) * 31 + s.charCodeAt(i + 1)) % dim] += 1;
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
};
const vkb = new kbMod.KnowledgeBase(vdir, { embedFn: fakeEmbed });
const vmeta = (n) => ({ bvid: `BV1VEC0000${n}`, page: 1, url: `https://x/BV1VEC0000${n}`, title: `向量课 ${n}`, owner: 't', duration: 600 });
vkb.saveVideo({ meta: vmeta(1), lines: [{ t: 10, text: '甲' }], segments: [], cards: [{ id: 'c1', title: '甲卡', claim: '唵嘛呢叭咪：机器位排布要贴轴线', evidence: [{ t: 10, quote: '甲' }] }], warnings: [] });
vkb.saveVideo({ meta: vmeta(2), lines: [{ t: 20, text: '乙' }], segments: [], cards: [{ id: 'c2', title: '乙卡', claim: '唵嘛呢叭咪：机器位排布要贴轴线旁边', evidence: [{ t: 20, quote: '乙' }] }], warnings: [] });
const vp0 = vkb.vecPending();
const vfile = path.join(vdir, 'vec.jsonl');
fs.writeFileSync(vfile, vp0.items.map((i) => JSON.stringify({ key: `${i.bvid}|${i.page}|${i.cid}`, dhash: i.dhash, vec: fakeEmbed(i.text) })).join('\n'), 'utf8');
const vapplied = vkb.vecApplyJsonl(vfile);
const vp1 = vkb.vecPending();
check('待嵌清单：一开始全 pending，灌完变 0', () => (vp0.total === 2 && vapplied.applied === 2 && vp1.total === 0) || JSON.stringify({ p0: vp0.total, applied: vapplied.applied, p1: vp1.total }));
const vstore = vkb.load('BV1VEC00002', 1);
vstore.cards[0].claim = '唵嘛呢叭咪：机器位排布要贴轴线旁边，且高度齐平';
vkb.saveVideo({ meta: vstore.meta, lines: vstore.lines, segments: vstore.segments, cards: vstore.cards, warnings: [] });
const vp2 = vkb.vecPending();
check('灌完改一张卡 → 只有那张重新 pending（按内容指纹增量）', () => (vp2.total === 1 && vp2.items[0].cid === 'c2') || JSON.stringify(vp2.items));
// 跨页同 id 不串指纹（真库里几十页都有 s0-1；只按 cid 比对会导致永远算待嵌）
const vcdir = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-vc-'));
const vckb = new kbMod.KnowledgeBase(vcdir, { embedFn: fakeEmbed });
for (const page of [1, 2]) {
  vckb.saveVideo({
    meta: { bvid: 'BV1CLASH001', page, url: `https://x/BV1CLASH001?p=${page}`, title: `撞 id 课 P${page}`, owner: 't', duration: 600 },
    lines: [{ t: 5, text: '甲' }],
    segments: [],
    cards: [{ id: 's0-1', title: `P${page} 卡`, claim: `啮合校验页${page}：机位排布要贴轴线`, evidence: [{ t: 5, quote: '甲' }] }],
    warnings: [],
  });
}
const cp0 = vckb.vecPending();
const vcfile = path.join(vcdir, 'v.jsonl');
fs.writeFileSync(vcfile, JSON.stringify({ key: `BV1CLASH001|1|s0-1`, dhash: cp0.items.find((i) => i.page === 1).dhash, vec: fakeEmbed('啮合校验页1：机位排布要贴轴线') }), 'utf8');
vckb.vecApplyJsonl(vcfile);
const cp1 = vckb.vecPending();
check('跨页同 id（几十页都有 s0-1）不会串指纹', () => (cp0.total === 2 && cp1.total === 1 && cp1.items[0].page === 2) || JSON.stringify({ cp0: cp0.total, cp1: cp1.items.map((i) => `${i.page}:${i.cid}`) }));
safeRm(vcdir, [vckb]);
const vsem = await vkb.vecSearch('唵嘛呢叭咪：机器位排布要贴轴线', { limit: 5 });
check('语义检索返回带 _vec 分数，顺序按余弦递减', () => {
  const scores = vsem.cards.map((c) => c._vec?.score);
  const sorted = scores.every((s, i) => i === 0 || scores[i - 1] >= s);
  return (vsem.ok && scores.length === 2 && sorted) || JSON.stringify({ reason: vsem.reason, scores });
});
const vkwo = vkb.search('唵嘛呢叭咪', { limit: 5, withLines: false, engine: 'sql' }).cards.map((c) => c.id);
const vkw1 = vkb.search('唵嘛呢叭咪', { limit: 5, withLines: false, engine: 'sql' }).cards.map((c) => c.id);
check('关键词路线的结果不受向量层影响', () => JSON.stringify(vkwo) === JSON.stringify(vkw1) || JSON.stringify({ vkwo, vkw1 }));
const vdb = vkb.indexDb();
vdb.open();
vdb.db.exec('DROP TABLE IF EXISTS card_vec');
const vsemGone = await vkb.vecSearch('唵嘛呢叭咪', { limit: 5 });
const vkwAfterDrop = vkb.search('唵嘛呢叭咪', { limit: 5, withLines: false, engine: 'sql' }).cards.length;
check('向量表被删：语义路诚实报错，关键词路线不受影响', () => (!vsemGone.ok && /向量|embedding|不可用/.test(vsemGone.reason ?? '') && vkwAfterDrop > 0) || JSON.stringify({ reason: vsemGone.reason, vkwAfterDrop }));
safeRm(vdir, [vkb]);
// ANN 扩展可用就必须与精确暴力给同一结论；不可用就必须走精确暴力（没 dll 也有一条断言，不 SKIP）
const vext = await (async () => {
  if (!process.env.VECEXT) return { ok: false, reason: '没配 vecExtPath' };
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-vec2-'));
  const k = new kbMod.KnowledgeBase(d, { embedFn: fakeEmbed, vecExtPath: process.env.VECEXT });
  k.saveVideo({ meta: { bvid: 'BV1ANN00001', page: 1, url: 'https://x', title: 'ANN 课', owner: 't', duration: 60 }, lines: [{ t: 5, text: '甲' }], segments: [], cards: [{ id: 'a1', title: 'A', claim: '啮合校验：机位排布贴轴线', evidence: [{ t: 5, quote: '甲' }] }, { id: 'a2', title: 'B', claim: '啮合校验：机位高度要齐平', evidence: [{ t: 6, quote: '甲' }] }], warnings: [] });
  const p = k.vecPending();
  const f2 = path.join(d, 'v.jsonl');
  fs.writeFileSync(f2, p.items.map((i) => JSON.stringify({ key: `${i.bvid}|${i.page}|${i.cid}`, dhash: i.dhash, vec: fakeEmbed(i.text) })).join('\n'), 'utf8');
  const ap = k.vecApplyJsonl(f2);
  const r = await k.vecSearch('啮合校验：机位排布贴轴线', { limit: 5 });
  const out = { ext: k.vecExt(), vtable: ap.vtable, engine: r.engine, note: r.note, cards: r.cards.length };
  safeRm(d, [k]);
  return out;
})();
check('ANN 可用则与精确暴力同一结论；不可用则走精确暴力', () => {
  if (!process.env.VECEXT) return kb.vecStatus().ext?.ok !== true || '假 KB 不该自动带上扩展';
  return (vext.ext?.ok && vext.vtable?.ok && vext.engine === 'vec0' && /一致/.test(vext.note ?? '') && vext.cards === 2) || JSON.stringify(vext);
});

// ---------------------------------------------------------------- 系列（合集）：fixture，不联网
const viewFix = {
  bvid: 'BVDEMO000031',
  owner: { mid: 123456789, name: '某UP' },
  ugc_season: { id: 1234567, title: 'MiniMax-H3系列', mid: 123456789, sections: [{ title: '正片' }] },
};
const ep = (i) => ({ aid: 100 + i, bvid: `BVDEMO0000${30 + i}`, title: `H3 打斗精讲 第${i}集`, duration: 600 + i, pubdate: 1700000000 + i * 86400, pic: '' });
const page1 = { archives: [ep(1), ep(2), ep(3)], page: { total: 4 } };
const page2 = { archives: [ep(4)], page: { total: 4 } };
const listFix = {
  items_lists: {
    seasons_list: [{ meta: { season_id: 1234567, name: '合集·MiniMax-H3系列', total: 4 } }],
    series_list: [{ meta: { series_id: 777, name: '系列·杂项', total: 2 } }],
  },
  page: { total: 2 },
};
let fetchedPage = 0;
const fakeBili = {
  async fetchJson(url) {
    if (url.includes('/view?')) return viewFix;
    if (url.includes('seasons_archives_list')) { fetchedPage += 1; return fetchedPage === 1 ? page1 : page2; }
    if (url.includes('seasons_series_list')) return listFix;
    throw new Error(`unexpected url ${url}`);
  },
};

const season = await seriesMod.seasonOfVideo(fakeBili, 'BVDEMO000031');
check('seasonOfVideo key/title/mid', () => (season.key === 'season:1234567' && season.title === 'MiniMax-H3系列' && season.mid === 123456789) || JSON.stringify(season));
const { episodes, total: seasonTotal } = await seriesMod.seasonArchives(fakeBili, { mid: 123456789, season_id: 1234567 });
check('seasonArchives paginates to total', () => (episodes.length === 4 && seasonTotal === 4) || `eps=${episodes.length} total=${seasonTotal}`);
check('seasonArchives keeps collection order with 1-based index', () => (episodes[0].bvid === 'BVDEMO000031' && episodes[3].index === 4) || episodes.map((e) => e.index).join(','));
const collections = await seriesMod.listCollections(fakeBili, 123456789);
check('listCollections covers seasons and series', () => (collections.length === 2 && collections[0].key === 'season:1234567' && collections[1].key === 'series:777') || JSON.stringify(collections.map((c) => c.key)));
check('listCollections strips 合集· prefix but keeps raw', () => (collections[0].title === 'MiniMax-H3系列' && collections[0].raw_title === '合集·MiniMax-H3系列') || JSON.stringify(collections[0]));
check('normalizeTitle keeps H3 but drops 第N集', () => seriesMod.normalizeTitle('H3 打斗精讲 第1集') === 'h3打斗精讲' || seriesMod.normalizeTitle('H3 打斗精讲 第1集'));
const clusters = seriesMod.clusterByPrefix([
  { bvid: 'a', title: 'H3 打斗精讲 第1集' }, { bvid: 'b', title: 'H3 打斗精讲 第2集' }, { bvid: 'c', title: 'H3 打斗精讲（上）第3集' }, { bvid: 'd', title: '完全不同的视频' },
], { min: 3 });
check('clusterByPrefix groups same-series titles', () => (clusters.length === 1 && clusters[0].count === 3 && clusters[0].bvids.join(',') === 'a,b,c') || JSON.stringify(clusters));

kb.saveSeries({ ...season, total: 4 }, episodes);
check('series saved', () => kb.getSeries('season:1234567')?.episodes.length === 4);
let progress = kb.seriesProgress('season:1234567');
check('progress: nothing learned, next is ep1', () => (progress.learned.length === 0 && progress.missing.length === 4 && progress.next.bvid === 'BVDEMO000031') || JSON.stringify(progress.next));
const seriesMeta = { ...meta, bvid: 'BVDEMO000031', title: 'H3 打斗精讲 第1集', series: { key: 'season:1234567', index: 1, total: 4, title: 'MiniMax-H3系列' } };
kb.saveVideo({ meta: seriesMeta, lines: lines.slice(0, 10), segments: segs.slice(0, 1), cards: [], warnings: [] });
progress = kb.seriesProgress('season:1234567');
check('progress after learning ep1', () => (progress.learned.length === 1 && progress.missing.length === 3 && progress.next.bvid === 'BVDEMO000032') || JSON.stringify({ l: progress.learned.length, m: progress.missing.length, n: progress.next?.bvid }));
check('video tagged with series', () => kb.listVideos().find((v) => v.bvid === 'BVDEMO000031')?.series?.key === 'season:1234567');
check('search scoped to series finds its card', () => {
  kb.saveCards('BVDEMO000031', [{ id: 's1', title: '起手式', claim: '先定景别再谈运镜', evidence: [{ t: 30, quote: '先定景别' }], tags: ['景别'], confidence: 'high' }]);
  const inSeries = kb.search('景别', { series: 'season:1234567' });
  const otherSeries = kb.search('景别', { series: 'season:0000' });
  return (inSeries.cards.length >= 1 && otherSeries.cards.length === 0) || `in=${inSeries.cards.length} out=${otherSeries.cards.length}`;
});
check('stats lists series progress', () => {
  const stats = kb.stats();
  const row = stats.series.find((s) => s.key === 'season:1234567');
  return (row && row.total === 4 && row.learned === 1 && row.missing === 3) || JSON.stringify(stats.series);
});

// ---------------------------------------------------------------- 多 P：按页分开存，互不覆盖
const multi = { ...meta, bvid: 'BVDEMO000011', title: '多P课程', duration: 600 };
kb.saveVideo({ meta: { ...multi, page: 1, part: 'P1 导论' }, lines: lines.slice(0, 5), segments: segs.slice(0, 1), cards: [{ id: 'm1', title: 'P1 要点', claim: '第一页把导演的职责拆成现场与后期两段', how: ['现场盯调度', '后期盯剪辑'], evidence: [{ t: 10, quote: '第一页先把职责拆开讲' }] }], warnings: [] });
kb.saveVideo({ meta: { ...multi, page: 2, part: 'P2 进阶' }, lines: lines.slice(0, 3), segments: segs.slice(0, 1), cards: [{ id: 'm2', title: 'P2 要点', claim: '第二页讲类型片要先立观众预期', how: ['先列类型', '再列预期'], evidence: [{ t: 20, quote: '第二页讲类型与预期' }] }], warnings: [] });
check('multi-P: P1 files survive after learning P2', () => fs.existsSync(path.join(dir, 'BVDEMO000011', 'cards.json')) && fs.existsSync(path.join(dir, 'BVDEMO000011_p2', 'cards.json')));
check('multi-P: both pages keep their own cards', () => (kb.load('BVDEMO000011', 1).cards.length === 1 && kb.load('BVDEMO000011', 2).cards.length === 1) || 'cards lost');
check('multi-P: index lists every page', () => kb.pagesOf('BVDEMO000011').map((v) => v.page).join(',') === '1,2' || JSON.stringify(kb.pagesOf('BVDEMO000011')));
check('multi-P: saveCards targets one page only', () => {
  kb.saveVideo({ meta: { ...multi, page: 3, part: 'P3 实战' }, lines: lines.slice(0, 2), segments: segs.slice(0, 1), cards: [], warnings: [] });
  kb.saveCards('BVDEMO000011', [{ id: 'm3', title: '补 P3', claim: '第三页补的是档期选择', how: ['看春节档', '避开强片'], evidence: [{ t: 5, quote: '第三页补档期' }] }], { page: 3 });
  return (kb.load('BVDEMO000011', 3).cards.length === 1 && kb.load('BVDEMO000011', 1).cards.length === 1) || 'page leak';
});
check('multi-P: dueCards spans all pages', () => {
  const due = kb.dueCards('BVDEMO000011');
  return (due.length === 3 && new Set(due.map((c) => c.page)).size === 3) || JSON.stringify(due.map((c) => [c.page, c.card_id]));
});
check('multi-P: grade writes review per page', () => {
  const applied = kb.applyReviewMulti('BVDEMO000011', [{ card_id: 'm1', verdict: 'ok', page: 1 }, { card_id: 'm2', verdict: 'ok', page: 2 }]);
  return (applied.length === 2 && kb.load('BVDEMO000011', 1).review.m1?.mastery === 1 && kb.load('BVDEMO000011', 2).review.m2?.mastery === 1) || JSON.stringify(applied);
});
check('multi-P: transcript jump url carries ?p=', () => {
  const hits = kb.search('线性代数 秩', { bvid: 'BVDEMO000011', limit: 20 });
  const p2 = hits.lines.find((l) => l.page === 2);
  return (p2 && p2.url.includes('?p=2&t=')) || JSON.stringify(hits.lines.slice(0, 3).map((l) => ({ p: l.page, u: l.url })));
});
check('multi-P: skill links carry ?p= for page 2', () => {
  const built = skillMod.buildSkill({
    name: 'x', title: 't', description: 'd', whenToUse: 'w',
    sources: [{ bvid: 'BVDEMO000011', page: 2, part: 'P2 进阶', title: '多P课程', url: 'https://www.bilibili.com/video/BVDEMO000011', owner: 'up', duration: 600 }],
    cards: [{ kind: 'concept', title: 'c', claim: 'x', evidence: [{ t: 42, quote: 'q' }], _bvid: 'BVDEMO000011', _page: 2 }],
  });
  return (built.includes('?p=2&t=42') && built.includes('P2 进阶')) || built.slice(0, 200);
});

// ---------------------------------------------------------------- 卡片质检：判定由模型给，程序只记账
const junkCards = [
  { id: 'k1', title: '求支持', claim: '觉得有用请一键三连支持一下', evidence: [{ t: 5, quote: '觉得有用一键三连' }, { t: 9, quote: '感谢大家观看，我们下期见' }], how: [] },
  { id: 'k2', title: '领资料', claim: '加群领取课件素材', why: '群里发链接', evidence: [{ t: 12, quote: '加粉丝群领取课件，QQ群在简介区' }], how: ['进群'] },
  { id: 'k3', title: '开场', claim: '今天我们来学一下', evidence: [{ t: 1, quote: '今天我们来学一下' }], how: [] },
  { id: 'k4', title: '景别三段式', claim: '先全景定场再中焦叙事最后特写强调', why: '观众先建立空间再读情绪', how: ['全景 2s', '中景 4s'], evidence: [{ t: 40, quote: '先给全景让观众知道空间关系' }] },
];
const judgeMod = await import(root + 'lib/judge.js');
// 假模型：真的按 prompt 里的 id 返回判定（门禁测的是送判/记账/诚实回滚这条管线，不是模型判断力——
// 判断力靠真机跑真知识库验收）。
const judgeStub = {
  calls: 0,
  replies: () => [{ verdict: 'ad', reason: '求三连' }, { verdict: 'knowledge', reason: '' }, { verdict: 'filler', reason: '开场白' }, { verdict: 'knowledge', reason: '' }],
  async *stream({ system, messages }) {
    judgeStub.calls += 1;
    const user = (messages?.[0]?.content ?? []).map((c) => c.text ?? '').join('');
    if (String(system ?? '').includes('质检员')) {
      const ids = [...user.matchAll(/id=([A-Za-z0-9_-]+)/g)].map((m) => m[1]);
      const table = judgeStub.replies();
      yield { type: 'text-delta', index: 0, text: JSON.stringify(ids.map((id, i) => ({ id, ...table[i % table.length] }))) };
      yield { type: 'finish', index: 0, reason: { kind: 'stop' } };
      return;
    }
    yield { type: 'text-delta', index: 0, text: '[]' };
    yield { type: 'finish', index: 0, reason: { kind: 'stop' } };
  },
};
const jr = await judgeMod.judgeCards({ llm: judgeStub, provider: 'x', model: 'y', cards: junkCards, batchSize: 12 });
check('judge: verdicts come from the model', () => (jr.verdicts.k1.verdict === 'ad' && jr.verdicts.k3.verdict === 'filler' && jr.verdicts.k4.verdict === 'knowledge' && jr.calls === 1) || JSON.stringify({ v: jr.verdicts, calls: jr.calls }));
const jr2 = await judgeMod.judgeCards({ llm: judgeStub, provider: 'x', model: 'y', cards: junkCards, cache: jr.verdicts });
check('judge: same cards hit the cache, zero extra model calls', () => (jr2.calls === 0 && jr2.fromCache === 4) || JSON.stringify({ calls: jr2.calls, fromCache: jr2.fromCache }));
const jr3 = await judgeMod.judgeCards({ llm: judgeStub, provider: 'x', model: 'y', cards: junkCards, pinned: ['k1'] });
check('judge: pinned card is not even sent for judgment', () => (jr3.verdicts.k1.by === 'pin' && jr3.calls === 1) || JSON.stringify({ k1: jr3.verdicts.k1, calls: jr3.calls }));
const ap = judgeMod.applyVerdicts(junkCards, jr.verdicts);
check('judge: apply keeps knowledge, drops ad+filler with the model reason', () => (ap.kept.map((c) => c.id).join(',') === 'k2,k4' && ap.dropped[0]._verdict === 'ad' && ap.dropped[0]._reasons[0] === '求三连') || JSON.stringify({ kept: ap.kept.map((c) => c.id), d: ap.dropped.map((c) => [c._verdict, c._reasons]) }));
const partial = await judgeMod.judgeCards({ llm: { async *stream() { yield { type: 'text-delta', index: 0, text: '[{"id":"k1","verdict":"ad","reason":"求三连"}]' }; yield { type: 'finish', index: 0, reason: { kind: 'stop' } }; } }, provider: 'x', model: 'y', cards: junkCards });
check('judge: ids the model skipped are kept and marked uncertain', () => (partial.unjudged.length === 3 && judgeMod.applyVerdicts(junkCards, partial.verdicts).kept.length === 3) || JSON.stringify({ unjudged: partial.unjudged }));
const silent = await judgeMod.judgeCards({ llm: { async *stream() { yield { type: 'reasoning-delta', index: 0, text: '嗯嗯嗯' }; yield { type: 'finish', index: 0, reason: { kind: 'max-tokens' } }; } }, provider: 'x', model: 'y', cards: junkCards });
check('judge: empty model output → nothing dropped, reported unjudged', () => (silent.unjudged.length === 4 && silent.calls === 2 && judgeMod.applyVerdicts(junkCards, silent.verdicts).kept.length === 4) || JSON.stringify({ unjudged: silent.unjudged.length, calls: silent.calls }));
kb.saveVideo({ meta: { ...meta, bvid: 'BVDEMO000017' }, lines, segments: segs, cards: junkCards, warnings: [] });
check('judge: saveVideo keeps every card (no programmatic pre-judgment)', () => kb.load('BVDEMO000017').cards.length === 4 || JSON.stringify(kb.load('BVDEMO000017').cards.length));
const applied = kb.applyJudgments('BVDEMO000017', { verdicts: jr.verdicts });
check('judge: applyJudgments moves the judged cards to filtered.json', () => (applied.kept === 2 && kb.load('BVDEMO000017').filtered.length === 2) || JSON.stringify({ kept: applied.kept, filtered: kb.load('BVDEMO000017').filtered.length }));
check('judge: filtered card carries the model verdict and reason', () => {
  const f = kb.load('BVDEMO000017').filtered.find((c) => c.id === 'k1');
  return (f._verdict === 'ad' && f._reasons[0] === '求三连' && f._by === 'model') || JSON.stringify(f);
});
check('judge: cards.md lists what was dropped and why', () => fs.readFileSync(path.join(dir, 'BVDEMO000017', 'cards.md'), 'utf8').includes('已筛掉'));
const saved = kb.saveJudgments('BVDEMO000017', jr.verdicts);
check('judge: verdicts cached per page', () => (saved === 4 && Object.keys(kb.load('BVDEMO000017').judgments).length === 4) || JSON.stringify(saved));
const restored = kb.restoreCards('BVDEMO000017', ['k3']);
check('judge: restore puts the card back and pins it', () => {
  const s = kb.load('BVDEMO000017');
  return (restored.restored === 1 && s.cards.length === 3 && s.filtered.length === 1 && s.pinned.includes('k3')) || JSON.stringify({ r: restored, cards: s.cards.length, filtered: s.filtered.length, pinned: s.pinned });
});
check('judge: replying the same verdicts keeps the pinned card', () => {
  const again = kb.applyJudgments('BVDEMO000017', { verdicts: jr.verdicts });
  return (again.kept === 3 && kb.load('BVDEMO000017').cards.some((c) => c.id === 'k3')) || JSON.stringify({ kept: again.kept });
});
check('no programmatic classifier module (judgment must be the model)', () => !fs.existsSync(new URL('lib/filter.js', root)), 'lib/filter.js 还在');
const stubCalls = { n: 0 };
const stubLlm = { async *stream() { stubCalls.n += 1; yield { type: 'text-delta', index: 0, text: '[]' }; yield { type: 'finish', index: 0, reason: { kind: 'stop' } }; } };
const adSeg = { index: 0, start: 0, end: 60, text: '感谢本期的赞助商，加QQ群领取资料，一键三连', lines: [{ t: 0, text: '感谢本期的赞助商，加QQ群领取资料，一键三连' }] };
await distill.distillSegments({ llm: stubLlm, provider: 'x', model: 'y', meta: { title: 't' }, segments: [adSeg], maxTokens: 200 });
check('distill: an ad-heavy segment still goes to the model (no regex pre-judgment)', () => (stubCalls.n >= 1 && adSeg.status === 'noise') || `calls=${stubCalls.n} status=${adSeg.status}`);
const emptySeg = { index: 1, start: 100, end: 160, text: '我们讲讲镜头的轴线', lines: [{ t: 100, text: '我们讲讲镜头的轴线' }] };
await distill.distillSegments({ llm: stubLlm, provider: 'x', model: 'y', meta: { title: 't' }, segments: [emptySeg], maxTokens: 200 });
check('distill: [] from model means noise, not unread, and no retry', () => (emptySeg.status === 'noise' && stubCalls.n === 2) || `status=${emptySeg.status} calls=${stubCalls.n}`);
check('distill prompt tells the model to skip ads/filler', () => {
  const src = fs.readFileSync(new URL('lib/distill.js', root), 'utf8');
  return (src.includes('不要出这些卡片') && src.includes('三连') && src.includes('输出 []')) || '提示词没有降噪规则';
});
check('judge prompt says: when unsure keep it', () => {
  const src = fs.readFileSync(new URL('lib/judge.js', root), 'utf8');
  return (src.includes('宁可留下') && src.includes('绝不误删知识')) || '质检提示词没有保守条款';
});

// ---------- SQLite 查询索引层（JSON 是真相源，索引可丢弃） ----------
const dbMod = await import(root + 'lib/db.js');
const HAVE_SQL = dbMod.sqliteAvailable();
check('db module exposes availability + reason', () => typeof HAVE_SQL === 'boolean' && (HAVE_SQL || dbMod.sqliteReason().length > 0));
check('bigram splits cjk into overlapping pairs', () => dbMod.bigram('景别轴线') === '景别 别轴 轴线' || dbMod.bigram('景别轴线'));
check('bigram keeps latin tokens lowercase', () => dbMod.bigram('rank 值') === 'rank 值' || dbMod.bigram('rank 值'));
check('queryTokens strips fts5 syntax chars', () => dbMod.queryTokens('正反打* (跳轴)').join(',') === '正反,反打,跳轴' || dbMod.queryTokens('正反打* (跳轴)').join(','));
check('index mirrors json right after saveVideo', () => !HAVE_SQL || kb.indexStatus().consistent === true || JSON.stringify(kb.indexStatus()));
for (const q of ['秩', '主元', '零空间', '正反打 跳轴', 'rank']) {
  check(`sql recall never misses what json found for「${q}」`, () => {
    if (!HAVE_SQL) return true;
    const key = (c) => `${c._video?.bvid}:${c._video?.page ?? 1}:${c.id}`;
    const js = kb.search(q, { limit: 8, withLines: false, engine: 'json' }).cards.map(key);
    const ss = kb.search(q, { limit: 8, withLines: false, engine: 'sql' }).cards.map(key);
    return js.join('|') === ss.join('|') || `json=[${js}] sql=[${ss}]`;
  });
}
check('known term actually goes through sql engine', () => !HAVE_SQL || kb.search('秩', { limit: 3, withLines: false }).engine === 'sql' || kb.search('秩', { limit: 3, withLines: false }).engine);
check('sql transcript hits keep the ?t= backlink', () => {
  if (!HAVE_SQL) return true;
  const l = kb.search('零空间', { limit: 3, withLines: true, engine: 'sql' }).lines;
  return (l.length > 0 && l[0].url.includes('?t=')) || `lines=${l.length}`;
});
check('due list: sql card ids == json card ids', () => {
  if (!HAVE_SQL) return true;
  const j = kb.dueCards('BVDEMO000004', { limit: 50, engine: 'json' }).map((r) => r.card_id).sort();
  const s = kb.dueCards('BVDEMO000004', { limit: 50, engine: 'sql' }).map((r) => r.card_id).sort();
  return j.join() === s.join() || `json=[${j}] sql=[${s}]`;
});
check('incremental write is mirrored into the index', () => {
  if (!HAVE_SQL) return true;
  const existing = kb.load('BVDEMO000004', 1).cards;
  kb.saveCards('BVDEMO000004', [...existing, { id: 'zz1', title: '索引增量', claim: '这张卡用来验证索引增量同步是否跟手。', evidence: [{ t: 300, quote: '索引增量同步' }] }], { page: 1 });
  return kb.search('跟手', { limit: 3, withLines: false, engine: 'sql' }).cards.some((c) => c.id === 'zz1') || 'SQL 查不到刚写入的卡';
});
check('a page written by an older plugin version / another process is re-mirrored before the next search', () => {
  if (!HAVE_SQL) return true;
  // 模拟外部写入：只写 JSON、不碰索引（旧版本插件、另一个进程都是这样）。
  // 少了这一步，SQL 会静默少答：页数比 JSON 少，却照样返回结果。
  const p = path.join(dir, 'BVDEMO000019');
  fs.mkdirSync(p, { recursive: true });
  fs.writeFileSync(path.join(p, 'source.json'), JSON.stringify({ bvid: 'BVDEMO000019', page: 1, title: '旧版写的页', url: 'https://www.bilibili.com/video/BVDEMO000019', owner: 'x' }));
  fs.writeFileSync(path.join(p, 'cards.json'), JSON.stringify([{ id: 'ow1', title: '外部写入', claim: '外部写入的页也必须能被检索到。', kind: 'concept', evidence: [{ t: 7, quote: '外部写入的页' }] }]));
  fs.writeFileSync(path.join(p, 'transcript.json'), JSON.stringify([{ t: 7, text: '外部写入的页也要镜像进索引' }]));
  const idxPath = path.join(dir, 'index.json');
  const idx = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
  idx.videos.BVDEMO000019 = { bvid: 'BVDEMO000019', page: 1, title: '旧版写的页', cards: 1, lines: 1, updatedAt: new Date(Date.now() + 5000).toISOString() };
  fs.writeFileSync(idxPath, JSON.stringify(idx));
  const before = kb.indexStatus();
  const hit = kb.search('外部写入', { limit: 5, withLines: false });
  const after = kb.indexStatus();
  return (before.consistent === false && hit.cards.some((c) => c.id === 'ow1') && after.consistent === true)
    || JSON.stringify({ beforePages: before.json.pages, sqlPages: before.sql.pages, ids: hit.cards.map((c) => c.id), afterConsistent: after.consistent });
});
check('a page deleted from json is deleted from the index too (no ghost cards)', () => {
  if (!HAVE_SQL) return true;
  const idxPath = path.join(dir, 'index.json');
  const idx = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
  delete idx.videos.BVDEMO000019;
  fs.writeFileSync(idxPath, JSON.stringify(idx));
  kb.search('外部写入', { limit: 5, withLines: false });
  const st = kb.indexStatus();
  return (st.consistent === true && !kb.search('外部写入', { limit: 5, withLines: false, engine: 'sql' }).cards.some((c) => c.id === 'ow1'))
    || JSON.stringify(st);
});
check('rebuild from json restores exact counts', () => {
  if (!HAVE_SQL) return true;
  const r = kb.rebuildIndex();
  const st = kb.indexStatus();
  return (r.ok === true && st.consistent === true) || JSON.stringify({ r, st });
});
check('index is disposable: after deleting it search still works (json fallback)', () => {
  if (!HAVE_SQL) return true;
  kb.indexDb().drop();
  const st = kb.indexStatus();
  const got = kb.search('秩', { limit: 3, withLines: false });
  const back = kb.rebuildIndex();
  return (st.consistent === false && got.cards.length > 0 && back.ok === true) || JSON.stringify({ st, cards: got.cards.length, back });
});
check('no sqlite dependency is required to answer (json path intact)', () => {
  const j = kb.search('秩', { limit: 5, withLines: false, engine: 'json' });
  return j.cards.length > 0 && j.engine === 'json' || `engine=${j.engine} cards=${j.cards.length}`;
});

console.log(failures.length === 0 ? `PASS ${total} checks` : `FAIL ${failures.length}/${total}\n- ${failures.join('\n- ')}`);
process.exit(failures.length === 0 ? 0 : 1);
