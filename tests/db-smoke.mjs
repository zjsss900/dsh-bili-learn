// 索引层冒烟（正式门禁，CI 会跑）：临时目录，不碰任何真实知识库。
// 断言：建索引/体检一致/两条路结果相同/讲稿行回跳/增量镜像/重建/删掉索引后自动回退 JSON。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KnowledgeBase } from '../dsh-bili-learn/lib/kb.js';
import { bigram, queryTokens, sqliteAvailable } from '../dsh-bili-learn/lib/db.js';

const failures = [];
let total = 0;
const check = (name, ok) => {
  total += 1;
  if (ok !== true) failures.push(`${name}: ${ok === false ? 'false' : ok}`);
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-db-smoke-'));
const kb = new KnowledgeBase(dir);
kb.saveVideo({
  meta: { bvid: 'BVSMOKE01', page: 1, url: 'https://www.bilibili.com/video/BVSMOKE01', title: '冒烟课', owner: 'tester', duration: 100, transcriptSource: 'ai', series: { key: 'season:1234567', index: 1, total: 3, title: '某系列' } },
  lines: [{ t: 12, text: '轴线一侧设五个机位，正反打才不会跳轴' }],
  segments: [],
  cards: [
    { id: 'c1', title: '正反打基础机位', claim: '两人对话可先定轴线，在一侧设五个机位。', how: ['定轴线', '放五个机位'], kind: 'procedure', evidence: [{ t: 12, quote: '轴线一侧设五个机位' }] },
    { id: 'c2', title: '跳轴的合法时机', claim: '人物走位或切空镜时可以合理越轴。', how: [], kind: 'caution', evidence: [{ t: 40, quote: '切空镜可以越轴' }] },
    { id: 'c3', title: '景别由叙事决定', claim: '决定景别的核心是这句话要强调什么。', how: ['先问强调什么'], kind: 'concept', evidence: [{ t: 61, quote: '景别取决于强调' }] },
  ],
  warnings: [],
});

check('bigram 拆两字词组', bigram('景别轴线') === '景别 别轴 轴线' || bigram('景别轴线'));
check('queryTokens 去掉 FTS 语法字符', queryTokens('正反打* (跳轴)').join(',') === '正反,反打,跳轴' || queryTokens('正反打* (跳轴)').join(','));

if (!sqliteAvailable()) {
  console.log(`SKIP db-smoke：这个运行时的 node:sqlite 不可用（${(await import('../dsh-bili-learn/lib/db.js')).sqliteReason()}），JSON 路线由 selftest 覆盖`);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  process.exit(0);
}

const db = kb.indexDb();
check('索引能打开', db.open() ? true : db.reason || '打不开');
check('saveVideo 后体检一致', kb.indexStatus().consistent === true || JSON.stringify(kb.indexStatus()));
check('series 对象不会漏索引（对象参数坑）', kb.search('正反打', { limit: 3, withLines: false, engine: 'sql' }).cards.some((c) => c.id === 'c1') || 'series 对象页没进索引');

for (const q of ['正反打', '跳轴', '景别', '轴线 机位', '强调']) {
  const key = (c) => c.id;
  const j = kb.search(q, { limit: 5, withLines: false, engine: 'json' }).cards.map(key);
  const s = kb.search(q, { limit: 5, withLines: false, engine: 'sql' }).cards.map(key);
  check(`两条路结果一致「${q}」`, j.join('|') === s.join('|') || `json=[${j}] sql=[${s}]`);
}
check('检索默认走 sql', kb.search('景别', { limit: 3, withLines: false }).engine === 'sql' || kb.search('景别', { limit: 3, withLines: false }).engine);
const l = kb.search('正反打', { limit: 3, withLines: true, engine: 'sql' }).lines;
check('讲稿行走索引且带回跳', l.length > 0 && l[0].url.includes('?t=12') || JSON.stringify(l[0] ?? null));

kb.applyReview('BVSMOKE01', [{ card_id: 'c1', verdict: 'ok' }]);
const dueSql = kb.dueCards('BVSMOKE01', { limit: 5, includeUnseen: false, engine: 'sql' }).map((r) => r.card_id);
const dueJson = kb.dueCards('BVSMOKE01', { limit: 5, includeUnseen: false, engine: 'json' }).map((r) => r.card_id);
check('待复习列表两条路一致', dueJson.join('|') === dueSql.join('|') || `json=[${dueJson}] sql=[${dueSql}]`);

kb.saveCards('BVSMOKE01', [...kb.load('BVSMOKE01', 1).cards, { id: 'c4', title: '增量', claim: '这张卡验证索引增量同步是否跟手。', evidence: [{ t: 80, quote: '增量同步' }] }], { page: 1 });
check('增量写入立刻进索引', kb.search('跟手', { limit: 3, withLines: false, engine: 'sql' }).cards.some((c) => c.id === 'c4') || 'SQL 查不到刚写入的卡');
check('重建后体检仍一致', (() => { const r = kb.rebuildIndex(); return (r.ok === true && kb.indexStatus().consistent === true) || JSON.stringify({ r, st: kb.indexStatus() }); })());

kb.indexDb().drop();
const st = kb.indexStatus();
const got = kb.search('正反打', { limit: 3, withLines: false, engine: 'json' });
check('删掉索引后 JSON 路线仍答得出', st.consistent === false && got.cards.length > 0 || JSON.stringify({ st, n: got.cards.length }));
check('ensureIndex 能自动补建', kb.search('跳轴', { limit: 3, withLines: false }).engine === 'sql' || '自动补建没生效');

db.close();
fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 });
console.log(failures.length === 0 ? `PASS db-smoke ${total} checks` : `FAIL db-smoke ${failures.length}/${total}\n- ${failures.join('\n- ')}`);
process.exit(failures.length === 0 ? 0 : 1);
