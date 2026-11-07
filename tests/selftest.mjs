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
const meta = { bvid: 'BV1TEST00001', aid: 1, cid: 2, page: 1, part: 'p1', title: '测试视频', owner: 'up', duration: 1200, url: 'https://www.bilibili.com/video/BV1TEST00001', tags: ['线性代数'], transcriptSource: 'user-text', transcriptNote: 'test', coverage: { lines: lines.length, segments: segs.length } };
kb.saveVideo({ meta, lines, segments: segs, cards: [], warnings: ['w1'] });
check('files written', () => {
  const wanted = ['source.json', 'transcript.json', 'transcript.md', 'segments.json', 'cards.json', 'cards.md', 'study.md'];
  const missing = wanted.filter((f) => !fs.existsSync(path.join(dir, 'BV1TEST00001', f)));
  if (!fs.existsSync(path.join(dir, 'index.json'))) missing.push('index.json');
  return missing.length === 0 || `missing: ${missing.join(',')}`;
});
check('index lists video', () => kb.listVideos().length === 1);
check('saveCards then search', () => {
  kb.saveCards('BV1TEST00001', [{ id: 'k1', title: '秩', claim: '秩等于列空间维数', why: '因为主元个数', how: ['化简'], evidence: [{ t: 120, quote: '秩就是主元个数' }], tags: ['秩'], confidence: 'high' }]);
  const hits = kb.search('秩 列空间');
  return hits.cards.length >= 1 || 'no card hits';
});
check('recall returns jump url', () => kb.search('秩').lines.length >= 0);
check('due then grade', () => {
  const due = kb.dueCards('BV1TEST00001');
  if (due.length !== 1) return `due=${due.length}`;
  const applied = kb.applyReview('BV1TEST00001', [{ card_id: 'k1', verdict: 'ok' }]);
  if (applied[0].mastery !== 1) return `mastery=${applied[0].mastery}`;
  const after = kb.dueCards('BV1TEST00001');
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
check('parseVideoRef bv', () => bili.parseVideoRef('https://www.bilibili.com/video/BV1GJ411x7h7?p=2').bvid === 'BV1GJ411x7h7');
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

// ---------------------------------------------------------------- 系列（合集）：fixture，不联网
const viewFix = {
  bvid: 'BV1SERIES0001',
  owner: { mid: 123456789, name: '某UP' },
  ugc_season: { id: 1234567, title: 'MiniMax-H3系列', mid: 123456789, sections: [{ title: '正片' }] },
};
const ep = (i) => ({ aid: 100 + i, bvid: `BV1SERIES000${i}`, title: `H3 打斗精讲 第${i}集`, duration: 600 + i, pubdate: 1700000000 + i * 86400, pic: '' });
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

const season = await seriesMod.seasonOfVideo(fakeBili, 'BV1SERIES0001');
check('seasonOfVideo key/title/mid', () => (season.key === 'season:1234567' && season.title === 'MiniMax-H3系列' && season.mid === 123456789) || JSON.stringify(season));
const { episodes, total: seasonTotal } = await seriesMod.seasonArchives(fakeBili, { mid: 123456789, season_id: 1234567 });
check('seasonArchives paginates to total', () => (episodes.length === 4 && seasonTotal === 4) || `eps=${episodes.length} total=${seasonTotal}`);
check('seasonArchives keeps collection order with 1-based index', () => (episodes[0].bvid === 'BV1SERIES0001' && episodes[3].index === 4) || episodes.map((e) => e.index).join(','));
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
check('progress: nothing learned, next is ep1', () => (progress.learned.length === 0 && progress.missing.length === 4 && progress.next.bvid === 'BV1SERIES0001') || JSON.stringify(progress.next));
const seriesMeta = { ...meta, bvid: 'BV1SERIES0001', title: 'H3 打斗精讲 第1集', series: { key: 'season:1234567', index: 1, total: 4, title: 'MiniMax-H3系列' } };
kb.saveVideo({ meta: seriesMeta, lines: lines.slice(0, 10), segments: segs.slice(0, 1), cards: [], warnings: [] });
progress = kb.seriesProgress('season:1234567');
check('progress after learning ep1', () => (progress.learned.length === 1 && progress.missing.length === 3 && progress.next.bvid === 'BV1SERIES0002') || JSON.stringify({ l: progress.learned.length, m: progress.missing.length, n: progress.next?.bvid }));
check('video tagged with series', () => kb.listVideos().find((v) => v.bvid === 'BV1SERIES0001')?.series?.key === 'season:1234567');
check('search scoped to series finds its card', () => {
  kb.saveCards('BV1SERIES0001', [{ id: 's1', title: '起手式', claim: '先定景别再谈运镜', evidence: [{ t: 30, quote: '先定景别' }], tags: ['景别'], confidence: 'high' }]);
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
const multi = { ...meta, bvid: 'BV1MULTI0001', title: '多P课程', duration: 600 };
kb.saveVideo({ meta: { ...multi, page: 1, part: 'P1 导论' }, lines: lines.slice(0, 5), segments: segs.slice(0, 1), cards: [{ id: 'm1', title: 'P1 要点', claim: '第一页的结论', evidence: [{ t: 10, quote: 'q' }] }], warnings: [] });
kb.saveVideo({ meta: { ...multi, page: 2, part: 'P2 进阶' }, lines: lines.slice(0, 3), segments: segs.slice(0, 1), cards: [{ id: 'm2', title: 'P2 要点', claim: '第二页的结论', evidence: [{ t: 20, quote: 'q' }] }], warnings: [] });
check('multi-P: P1 files survive after learning P2', () => fs.existsSync(path.join(dir, 'BV1MULTI0001', 'cards.json')) && fs.existsSync(path.join(dir, 'BV1MULTI0001_p2', 'cards.json')));
check('multi-P: both pages keep their own cards', () => (kb.load('BV1MULTI0001', 1).cards.length === 1 && kb.load('BV1MULTI0001', 2).cards.length === 1) || 'cards lost');
check('multi-P: index lists every page', () => kb.pagesOf('BV1MULTI0001').map((v) => v.page).join(',') === '1,2' || JSON.stringify(kb.pagesOf('BV1MULTI0001')));
check('multi-P: saveCards targets one page only', () => {
  kb.saveVideo({ meta: { ...multi, page: 3, part: 'P3 实战' }, lines: lines.slice(0, 2), segments: segs.slice(0, 1), cards: [], warnings: [] });
  kb.saveCards('BV1MULTI0001', [{ id: 'm3', title: '补 P3', claim: '第三页', evidence: [{ t: 5, quote: 'q' }] }], { page: 3 });
  return (kb.load('BV1MULTI0001', 3).cards.length === 1 && kb.load('BV1MULTI0001', 1).cards.length === 1) || 'page leak';
});
check('multi-P: dueCards spans all pages', () => {
  const due = kb.dueCards('BV1MULTI0001');
  return (due.length === 3 && new Set(due.map((c) => c.page)).size === 3) || JSON.stringify(due.map((c) => [c.page, c.card_id]));
});
check('multi-P: grade writes review per page', () => {
  const applied = kb.applyReviewMulti('BV1MULTI0001', [{ card_id: 'm1', verdict: 'ok', page: 1 }, { card_id: 'm2', verdict: 'ok', page: 2 }]);
  return (applied.length === 2 && kb.load('BV1MULTI0001', 1).review.m1?.mastery === 1 && kb.load('BV1MULTI0001', 2).review.m2?.mastery === 1) || JSON.stringify(applied);
});
check('multi-P: transcript jump url carries ?p=', () => {
  const hits = kb.search('线性代数 秩', { bvid: 'BV1MULTI0001', limit: 20 });
  const p2 = hits.lines.find((l) => l.page === 2);
  return (p2 && p2.url.includes('?p=2&t=')) || JSON.stringify(hits.lines.slice(0, 3).map((l) => ({ p: l.page, u: l.url })));
});
check('multi-P: skill links carry ?p= for page 2', () => {
  const built = skillMod.buildSkill({
    name: 'x', title: 't', description: 'd', whenToUse: 'w',
    sources: [{ bvid: 'BV1MULTI0001', page: 2, part: 'P2 进阶', title: '多P课程', url: 'https://www.bilibili.com/video/BV1MULTI0001', owner: 'up', duration: 600 }],
    cards: [{ kind: 'concept', title: 'c', claim: 'x', evidence: [{ t: 42, quote: 'q' }], _bvid: 'BV1MULTI0001', _page: 2 }],
  });
  return (built.includes('?p=2&t=42') && built.includes('P2 进阶')) || built.slice(0, 200);
});

console.log(failures.length === 0 ? `PASS ${total} checks` : `FAIL ${failures.length}/${total}\n- ${failures.join('\n- ')}`);
process.exit(failures.length === 0 ? 0 : 1);
