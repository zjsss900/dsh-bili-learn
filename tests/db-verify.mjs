// 真实库验收：SQLite 索引 vs JSON 全扫，同一批查询双跑，比对命中 + 计时。
// 判据：SQL 绝不能比 JSON 少查到任何卡（missingInSql 必须 0）；否则索引不可信。
import fs from 'node:fs';
import { KnowledgeBase } from '../dsh-bili-learn/lib/kb.js';

const kb = new KnowledgeBase(process.env.BILI_KB ?? '<你的 bili-kb 目录>');
const ms = (f) => { const t0 = Date.now(); const r = f(); return { ms: Date.now() - t0, r }; };

const t0 = Date.now();
const rb = kb.rebuildIndex();
console.log(`rebuild：${rb.ok ? 'ok' : 'FAIL'} 页 ${rb.pages}｜卡 ${rb.cards}｜讲稿行 ${rb.lines}｜${((Date.now() - t0) / 1000).toFixed(1)}s｜索引 ${(rb.bytes / 1048576).toFixed(1)} MB`);
if ((rb.skipped ?? []).length) console.log('  skipped:', JSON.stringify(rb.skipped));
const st = kb.indexStatus();
console.log(`体检：engine=${st.engine} consistent=${st.consistent} json=${JSON.stringify(st.json)} sql={pages:${st.sql?.pages},cards:${st.sql?.cards},lines:${st.sql?.lines}} dangling=${JSON.stringify(st.dangling)}`);

const hand = ['景别', '轴线', '正反打', '跳轴', '提示词', '运镜', '焦距', '打光', '首尾帧', '转场', '一致性', '微表情', '分镜', '蒙太奇', '主元', '秩', '构图', '机位', '俯视图', '站位', 'rank', 'LoRA', 'UE', 'prompt', 'seedance', 'kling'];
const sampled = [];
for (const entry of kb.listVideos()) {
  for (const card of kb.load(entry.bvid, entry.page ?? 1)?.cards ?? []) {
    const claim = String(card.claim ?? '');
    if (claim.length >= 10) sampled.push(claim.slice(Math.floor(claim.length / 2), Math.floor(claim.length / 2) + 3));
    if (sampled.length >= 40) break;
  }
  if (sampled.length >= 40) break;
}
const queries = [...new Set([...hand, ...sampled])].slice(0, 60);
const key = (c) => `${c._video?.bvid ?? c.bvid}:${c._video?.page ?? c.page}:${c.id}`;
let jsonMs = 0;
let sqlMs = 0;
let lost = 0;
let jsonHits = 0;
let sqlHits = 0;
let withHits = 0;
let identicalOrder = 0;
const orderDiff = [];
const perQuery = [];
for (const q of queries) {
  const a = ms(() => kb.search(q, { limit: 8, withLines: false, engine: 'json' }));
  const b = ms(() => kb.search(q, { limit: 8, withLines: false, engine: 'sql' }));
  jsonMs += a.ms;
  sqlMs += b.ms;
  const js = a.r.cards.map(key);
  const ss = b.r.cards.map(key);
  jsonHits += js.length;
  sqlHits += ss.length;
  if (js.length) withHits += 1;
  const gone = js.filter((x) => !ss.includes(x));
  lost += gone.length;
  if (js.join('|') === ss.join('|')) identicalOrder += 1;
  else orderDiff.push({ q, json: js.slice(0, 4), sql: ss.slice(0, 4), gone: gone.length });
  const overlap = js.filter((x) => ss.includes(x)).length;
  perQuery.push({ q, json: js.length, sql: ss.length, overlap, jsonMs: a.ms, sqlMs: b.ms });
}
console.log(`\n卡片双跑：${queries.length} 个查询｜JSON ${jsonMs} ms 共 ${jsonHits} 条｜SQL ${sqlMs} ms 共 ${sqlHits} 条｜提速 ${(jsonMs / Math.max(sqlMs, 1)).toFixed(1)}×`);
console.log(`SQL 漏掉的 JSON 命中：${lost} 条；有命中的查询 ${withHits} 个，其中 top8 顺序完全一致 ${identicalOrder} 个`);
for (const d of orderDiff.slice(0, 8)) console.log(`  顺序不同「${d.q}」漏 ${d.gone}｜json=${d.json.join(',')}｜sql=${d.sql.join(',')}`);
const top = perQuery.filter((p) => p.json > 0).slice(0, 10);
for (const p of top) console.log(`  「${p.q}」json ${p.json} 条/${p.jsonMs}ms ↔ sql ${p.sql} 条/${p.sqlMs}ms，交集 ${p.overlap}`);

// 讲稿行：同一口径下比序列（不只比条数）
let lineMismatch = 0;
let lineQueries = 0;
for (const q of ['轴线', '景别', '正反打', '提示词', '首尾帧']) {
  const la = ms(() => kb.search(q, { limit: 8, withLines: true, engine: 'json' }));
  const lb = ms(() => kb.search(q, { limit: 8, withLines: true, engine: 'sql' }));
  lineQueries += 1;
  const ka = la.r.lines.map((l) => `${l.bvid}:${l.page}:${l.t}`).join('|');
  const kb2 = lb.r.lines.map((l) => `${l.bvid}:${l.page}:${l.t}`).join('|');
  if (ka !== kb2) {
    lineMismatch += 1;
    console.log(`  讲稿行不一致「${q}」json=${la.r.lines.length} sql=${lb.r.lines.length}`);
  }
  if (q === '轴线') console.log(`讲稿行示例：JSON ${la.r.lines.length} 条/${la.ms}ms ↔ SQL ${lb.r.lines.length} 条/${lb.ms}ms`);
}

// 待复习：跨页统计两条路
for (const bvid of ['BVQB4y1r73i', 'BVDEMO000013', 'BVDEMO000012']) {
  const a = ms(() => kb.dueCards(bvid, { limit: 50, engine: 'json' }).map((r) => `${r.page}:${r.card_id}`).sort().join(','));
  const b = ms(() => kb.dueCards(bvid, { limit: 50, engine: 'sql' }).map((r) => `${r.page}:${r.card_id}`).sort().join(','));
  console.log(`due ${bvid}：json ${(a.r || '（空）').split(',').length} 条/${a.ms}ms ↔ sql ${(b.r || '（空）').split(',').length} 条/${b.ms}ms｜一致=${a.r === b.r}`);
}
console.log(`\n索引文件：${st.sql?.file}（可删可重建，删了自动回退 JSON）`);
const pass = lost === 0 && identicalOrder === queries.length && st.consistent && lineMismatch === 0;
console.log(pass
  ? `验收：PASS（${queries.length} 个查询卡片 top8 逐条一致；讲稿行 ${lineQueries} 组一致；漏 0 条；体检 consistent=true）`
  : `验收：FAIL（漏 ${lost} 条；卡片顺序一致 ${identicalOrder}/${queries.length}；讲稿行不一致 ${lineMismatch}/${lineQueries}；体检 ${st.consistent}）`);
