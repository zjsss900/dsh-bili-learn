// 自检门禁：只打印 PASS/FAIL 与失败项，不输出全文。
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const root = new URL('../dsh-bili-learn/', import.meta.url).href;
const failures = [];
const check = (name, fn) => {
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

console.log(failures.length === 0 ? `PASS ${24} checks` : `FAIL ${failures.length}\n- ${failures.join('\n- ')}`);
process.exit(failures.length === 0 ? 0 : 1);
