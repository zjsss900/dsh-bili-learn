// 语义检索层。和全文索引同一条底线：向量是**可丢弃的派生缓存**，JSON 才是真相源；
// 向量出问题只回退，绝不动知识。排序口径仍然只有一套：关键词那条不动，语义只多出一路候选。
import crypto from 'node:crypto';

export const VEC_TABLE = 'card_vec';
export const VEC_VTABLE = 'vec_card_vec';

/** 送去嵌入的文本：卡片正文，不含证据引文（证据是原文碎片，会把向量拉向原话而非知识点） */
export function embedText(card = {}) {
  return [card.title, card.claim, card.why, (card.how ?? []).join('；'), (card.tags ?? []).join(' ')]
    .filter((x) => x && String(x).trim()).join('\n').slice(0, 900);
}
export function fingerprint(card = {}) {
  return crypto.createHash('sha1').update(embedText(card)).digest('hex').slice(0, 16);
}
export const f32buf = (vec) => Buffer.from(new Float32Array(vec).buffer);
export const bufvec = (buf) => new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
export function cosine(a, b) {
  let dot = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) dot += a[i] * b[i];
  return dot; // 两边都已归一化（bge 输出归一化），点积即余弦
}
const keyOf = (r) => `${r.bvid}|${r.page}|${r.cid}`;

export function ensureVecSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS ${VEC_TABLE}(bvid TEXT, page INTEGER, cid TEXT, model TEXT, dhash TEXT, vec BLOB, dim INTEGER, updated TEXT, PRIMARY KEY(bvid,page,cid,model))`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_vec_model ON ${VEC_TABLE}(model)`);
}
export function vecStats(db) {
  ensureVecSchema(db);
  const models = db.prepare('SELECT model, COUNT(*) rows, MAX(dim) dim FROM card_vec GROUP BY model').all();
  return { rows: models.reduce((s, m) => s + m.rows, 0), models };
}
/** 只嵌「内容变了或没见过」的卡：按内容指纹增量，不整库重跑。
 *  键必须是 bvid|page|cid——卡片 id 只在页内唯一（几十页都有 s0-1），只按 cid 比会串页、永远算待嵌。 */
export function pendingItems(db, items, model) {
  ensureVecSchema(db);
  const have = new Map(
    db.prepare('SELECT bvid,page,cid,dhash FROM card_vec WHERE model = ?').all(model).map((r) => [`${r.bvid}|${r.page}|${r.cid}`, r.dhash]),
  );
  return items.filter((it) => have.get(`${it.bvid}|${it.page ?? 1}|${it.cid}`) !== it.dhash);
}
export function upsertVectors(db, { model, dim, rows }) {
  ensureVecSchema(db);
  const ins = db.prepare(`INSERT OR REPLACE INTO ${VEC_TABLE}(bvid,page,cid,model,dhash,vec,dim,updated) VALUES(?,?,?,?,?,?,?,?)`);
  const stamp = new Date().toISOString();
  let n = 0;
  for (const r of rows) {
    ins.run(r.bvid, Number(r.page ?? 1), String(r.cid), model, String(r.dhash ?? ''), f32buf(r.vec), dim, stamp);
    n += 1;
  }
  return n;
}
export function deletePageVectors(db, { bvid, page = 1 }) {
  ensureVecSchema(db);
  return db.prepare(`DELETE FROM ${VEC_TABLE} WHERE bvid = ? AND page = ?`).run(String(bvid), Number(page)).changes;
}
/** 全扫暴力：对几千到几万条是精确且够快（1786×512 一次约 3 ms），不依赖任何扩展 */
export function bruteSearch(db, { model, qvec, k = 8, dim = 0 }) {
  ensureVecSchema(db);
  const rows = db.prepare('SELECT bvid,page,cid,vec FROM card_vec WHERE model = ?').all(model);
  const scored = rows.map((r) => ({ bvid: r.bvid, page: r.page, cid: r.cid, score: cosine(qvec, bufvec(r.vec)) }));
  scored.sort((a, b) => (b.score - a.score) || keyOf(a).localeCompare(keyOf(b)));
  return scored.slice(0, k);
}
/** sqlite-vec 可选：加载得动就用 ANN，加载不动就退回上面的精确暴力 */
export function tryLoadExt(db, extPath) {
  if (!extPath) return { ok: false, reason: '没配 vecExtPath（vec0.dll 路径），用精确暴力检索' };
  try {
    db.enableLoadExtension(true);
    db.loadExtension(String(extPath).replace(/\\/g, '/'));
    const v = db.prepare('SELECT vec_version() v').get().v;
    return { ok: true, version: v };
  } catch (e) {
    return { ok: false, reason: `加载 vec0 失败：${e?.message ?? e}` };
  }
}
export function rebuildVTable(db, { dim, rows, name = VEC_VTABLE }) {
  try {
    db.exec(`DROP TABLE IF EXISTS ${name}`);
    db.exec(`CREATE VIRTUAL TABLE ${name} USING vec0(bvid TEXT, page INTEGER, cid TEXT, model TEXT metadata, embedding FLOAT[${Number(dim)}] distance_metric=cosine)`);
    const ins = db.prepare(`INSERT INTO ${name}(bvid,page,cid,model,embedding) VALUES(?,?,?,?,?)`);
    let n = 0;
    for (const r of rows) {
      ins.run(String(r.bvid), BigInt(Number(r.page ?? 1)), String(r.cid), String(r.model), f32buf(r.vec));
      n += 1;
    }
    return { ok: true, rows: n };
  } catch (e) {
    return { ok: false, reason: `建 vec0 虚表失败：${e?.message ?? e}` };
  }
}
export function annSearch(db, { qvec, k = 8, model, name = VEC_VTABLE }) {
  try {
    const rows = db.prepare(`SELECT bvid,page,cid,distance FROM ${name} WHERE model = ? AND embedding MATCH ? AND k = ? ORDER BY distance`).all(String(model), f32buf(qvec), Number(k));
    return { ok: true, hits: rows.map((r) => ({ bvid: r.bvid, page: Number(r.page), cid: r.cid, score: 1 - Number(r.distance) })) };
  } catch (e) {
    return { ok: false, reason: `vec0 KNN 查询失败：${e?.message ?? e}` };
  }
}
/** 混排：只用倒数排名融合（RRF），不把两种量纲的分数相加——语义分数和关键词分数不可比 */
export function rrfFusion(lists, k = 8, c = 60) {
  const acc = new Map();
  for (const list of lists) {
    (list ?? []).forEach((it, rank) => {
      const key = keyOf(it);
      acc.set(key, { item: it, score: (acc.get(key)?.score ?? 0) + 1 / (c + rank + 1) });
    });
  }
  return [...acc.values()]
    .map((x) => ({ ...x.item, _fused: x.score }))
    .sort((a, b) => (b._fused - a._fused) || keyOf(a).localeCompare(keyOf(b)))
    .slice(0, k);
}
