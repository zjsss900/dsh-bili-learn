// SQLite 查询索引层：只是 JSON 的派生缓存，可随时删掉重建。
// 真相源仍然是 cards.json / transcript.json——索引坏了不丢任何知识。
// 为什么需要：全库扫 JSON 的成本是线性的（实测 342 页 287ms，100× 就是 29 秒）。
// 中文检索用 bigram 灌 FTS5：实测 trigram 对「景别」「轴线」这类两字词完全不命中。
import fs from 'node:fs';
import path from 'node:path';
import { clip } from './text.js';

let DatabaseSync = null;
let sqliteError = '';
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch (error) {
  sqliteError = error?.message ?? String(error);
}

export const sqliteAvailable = () => Boolean(DatabaseSync);
export const sqliteReason = () => sqliteError;

/** CJK bigram 展开：「景别轴线」→「景别 别轴 轴线」；英文数字按词保留并小写。 */
export function bigram(text) {
  const out = [];
  for (const run of String(text ?? '').match(/[一-鿿]+|[A-Za-z0-9]+/g) ?? []) {
    if (/[一-鿿]/.test(run[0])) {
      if (run.length === 1) out.push(run);
      for (let i = 0; i + 1 < run.length; i += 1) out.push(run.slice(i, i + 2));
    } else {
      out.push(run.toLowerCase());
    }
  }
  return out.join(' ');
}

/** 查询串 → bigram 词元（去掉 FTS5 语法字符），全部 AND：少词元比漏词元好。 */
export function queryTokens(query) {
  const words = String(query ?? '').replace(/["*(){}:^|-]+/g, ' ').trim();
  if (!words) return [];
  const seen = new Set();
  for (const tok of bigram(words).split(' ').filter(Boolean)) seen.add(tok);
  return [...seen];
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS page(
  bvid TEXT NOT NULL, page INTEGER NOT NULL, part TEXT, title TEXT, url TEXT, owner TEXT,
  cards INTEGER DEFAULT 0, dropped INTEGER DEFAULT 0, lines INTEGER DEFAULT 0, series TEXT, updated TEXT,
  PRIMARY KEY(bvid, page)
);
CREATE TABLE IF NOT EXISTS card(
  bvid TEXT NOT NULL, page INTEGER NOT NULL, id TEXT NOT NULL, json TEXT NOT NULL,
  title TEXT, claim TEXT, kind TEXT, verdict TEXT, pinned INTEGER DEFAULT 0,
  PRIMARY KEY(bvid, page, id)
);
CREATE VIRTUAL TABLE IF NOT EXISTS card_fts USING fts5(tw, cw, ww, hw, bvid UNINDEXED, page UNINDEXED, cid UNINDEXED, tokenize='unicode61');
CREATE TABLE IF NOT EXISTS line(
  bvid TEXT NOT NULL, page INTEGER NOT NULL, t INTEGER NOT NULL, seq INTEGER NOT NULL, text TEXT NOT NULL,
  PRIMARY KEY(bvid, page, t, seq)
);
CREATE VIRTUAL TABLE IF NOT EXISTS line_fts USING fts5(tw, bvid UNINDEXED, page UNINDEXED, t UNINDEXED, seq UNINDEXED, tokenize='unicode61');
CREATE TABLE IF NOT EXISTS review(
  bvid TEXT NOT NULL, page INTEGER NOT NULL, cid TEXT NOT NULL, mastery INTEGER DEFAULT 0, due TEXT,
  PRIMARY KEY(bvid, page, cid)
);
CREATE INDEX IF NOT EXISTS card_bvid_page ON card(bvid, page);
CREATE INDEX IF NOT EXISTS review_due ON review(due);
CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
`;

/** 系列列只存 key（season:xxx / series:xxx），别把整个 series 对象塞进 SQL。
 *  node:sqlite 绑定严格：对象/数组直接报 "cannot be bound to SQLite parameter"，
 *  实测因为 BVDEMO000031 的 series 是对象，整页卡片静默漏索引（现已收口 + 门禁盯着）。
 */
function seriesKeyOf(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return value.key ?? null;
  return null;
}

/** 文本列收口：undefined/null→NULL，对象/数组→JSON 串，布尔→0/1，其余→字符串。 */
function bindText(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 1 : 0;
  return String(value);
}

function bindNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export class IndexDb {
  constructor(root, { allowExtension = false } = {}) {
    this.file = path.join(root, 'bili.sqlite');
    this.db = null;
    this.ok = false;
    this.reason = DatabaseSync ? '' : `node:sqlite 不可用：${sqliteError}`;
    this.allowExtension = allowExtension;
  }

  open() {
    if (this.db) return this.db;
    if (!DatabaseSync) return null;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      // 只有配了 vecExtPath 才开扩展加载：默认关，别给索引层多一个能力面
      this.db = new DatabaseSync(this.file, { allowExtension: Boolean(this.allowExtension) });
      this.db.exec('PRAGMA journal_mode=WAL');
      this.db.exec('PRAGMA busy_timeout=5000');
      this.db.exec(SCHEMA);
      this.ok = true;
      this.reason = '';
      return this.db;
    } catch (error) {
      this.reason = `打不开索引：${error?.message ?? error}`;
      this.db = null;
      this.ok = false;
      return null;
    }
  }

  close() {
    try {
      this.db?.close();
    } catch {
      // 已经关了就忽略
    }
    this.db = null;
    this.ok = false;
  }

  /** 删掉索引文件（重建用）。JSON 不受影响。 */
  drop() {
    this.close();
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.rmSync(this.file + suffix, { force: true });
      } catch {
        // Windows 上偶尔被占用，忽略，下次重建会覆盖
      }
    }
  }

  /** 一页全量镜像：JSON 是真相源，这里先删后插，避免增量漏同步。 */
  syncPage({ bvid, page = 1, meta = {}, cards = [], lines = [], review = {}, judgments = {}, counts = {}, updated = '' }) {
    const db = this.open();
    if (!db) return false;
    const p = Number(page) || 1;
    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM card WHERE bvid=? AND page=?').run(bvid, p);
      db.prepare('DELETE FROM card_fts WHERE bvid=? AND page=?').run(bvid, p);
      db.prepare('DELETE FROM line WHERE bvid=? AND page=?').run(bvid, p);
      db.prepare('DELETE FROM line_fts WHERE bvid=? AND page=?').run(bvid, p);
      db.prepare('DELETE FROM review WHERE bvid=? AND page=?').run(bvid, p);
      db.prepare(
        `INSERT INTO page(bvid,page,part,title,url,owner,cards,dropped,lines,series,updated)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(bvid,page) DO UPDATE SET part=excluded.part,title=excluded.title,url=excluded.url,owner=excluded.owner,
           cards=excluded.cards,dropped=excluded.dropped,lines=excluded.lines,series=excluded.series,updated=excluded.updated`,
      ).run(bvid, p, bindText(meta.part), bindText(meta.title), bindText(meta.url), bindText(meta.owner), bindNum(counts.cards ?? cards.length), bindNum(counts.dropped), bindNum(counts.lines ?? lines.length), seriesKeyOf(meta.series), updated || new Date().toISOString());
      const insCard = db.prepare('INSERT INTO card(bvid,page,id,json,title,claim,kind,verdict,pinned) VALUES(?,?,?,?,?,?,?,?,?)');
      const insFts = db.prepare('INSERT INTO card_fts(tw,cw,ww,hw,bvid,page,cid) VALUES(?,?,?,?,?,?,?)');
      const seenCardIds = new Set();
      for (const c of cards) {
        // 同一页里 id 撞车会撞主键、抛异常、整页写不进去（实测 3 页因此少了 34 张卡）。
        // 这里跳过重复项保住整页；改名并保留两张是 kb.js uniqueCardIds 的职责。
        const cid = String(c.id);
        if (seenCardIds.has(cid)) { this.dupeCards = (this.dupeCards ?? 0) + 1; continue; }
        seenCardIds.add(cid);
        insCard.run(bvid, p, cid, JSON.stringify(c), bindText(c.title), bindText(c.claim), bindText(c.kind), bindText(c._verdict), c._pinned ? 1 : 0);
        // card_fts 用 (bvid,page,cid) 回查，不依赖 rowid 对齐
        insFts.run(bigram(`${c.title ?? ''} ${(c.tags ?? []).join(' ')}`), bigram(c.claim), bigram(c.why), bigram((c.how ?? []).join(' ')), bvid, p, String(c.id));
      }
      const insLine = db.prepare('INSERT OR IGNORE INTO line(bvid,page,t,seq,text) VALUES(?,?,?,?,?)');
      const insLineFts = db.prepare('INSERT INTO line_fts(tw,bvid,page,t,seq) VALUES(?,?,?,?,?)');
      let seq = 0;
      for (const l of lines) {
        seq += 1;
        insLine.run(bvid, p, bindNum(l.t), seq, bindText(l.text) ?? '');
        insLineFts.run(bigram(l.text), bvid, p, bindNum(l.t), seq);
      }
      const insReview = db.prepare('INSERT OR REPLACE INTO review(bvid,page,cid,mastery,due) VALUES(?,?,?,?,?)');
      for (const [cid, state] of Object.entries(review ?? {})) {
        insReview.run(bvid, p, String(cid), bindNum(state?.mastery ?? 0), state?.due ? String(state.due) : null);
      }
      db.exec('COMMIT');
      void judgments;
      return true;
    } catch (error) {
      db.exec('ROLLBACK');
      this.reason = `写索引失败：${error?.message ?? error}`;
      return false;
    }
  }

  /** FTS 词元串 → MATCH 表达式（全部 AND，词元加引号防语法字符）。 */
  static matchExpr(tokens) {
    return tokens.map((t) => `"${t}"`).join(' AND ');
  }

  /**
   * 候选召回（不是最终排序）：只要求「卡片里出现了任一个查询词元」，这正是 scoreCard 打分 >0 的
   * 必要条件，所以候选集是 JSON 全扫结果的超集 —— 最终排序仍由 text.js 那套打分决定，只有一套口径。
   * depth 只是保险丝（默认极大，宁可多算也不漏）。
   */
  cardCandidates(query, { tokens, depth = 20000, bvid, bvids } = {}) {
    const db = this.open();
    if (!db) return null;
    const toks = (tokens ?? queryTokens(query)).map((t) => String(t).replace(/["*(){}:^|]+/g, '').trim()).filter((t) => t.length >= 1);
    if (toks.length === 0) return [];
    const where = ['card_fts MATCH ?'];
    const params = [toks.map((t) => `"${t}"`).join(' OR ')];
    if (bvid) {
      where.push('card_fts.bvid=?');
      params.push(bvid);
    }
    if (Array.isArray(bvids)) {
      if (bvids.length === 0) return [];
      where.push(`card_fts.bvid IN (${bvids.map(() => '?').join(',')})`);
      params.push(...bvids);
    }
    const out = new Map();
    for (const r of db
      .prepare(
        `SELECT card_fts.bvid AS bvid, card_fts.page AS page, card_fts.cid AS cid, c.json AS json, p.title AS title, p.url AS url
         FROM card_fts JOIN card c ON c.bvid=card_fts.bvid AND c.page=card_fts.page AND c.id=card_fts.cid
         JOIN page p ON p.bvid=card_fts.bvid AND p.page=card_fts.page
         WHERE ${where.join(' AND ')} LIMIT ?`,
      )
      .all(...params, depth)) {
      out.set(`${r.bvid}|${r.page}|${r.cid}`, { bvid: r.bvid, page: r.page, card: JSON.parse(r.json), title: r.title, url: r.url });
    }
    // 极少数词元带符号（c++、3.5），FTS 里索引不到 → 补一遍 LIKE，保证候选集仍是超集
    const odd = toks.filter((t) => /[^a-z0-9]/i.test(t) && /[a-z0-9]/i.test(t) && t.length >= 2);
    for (const t of odd) {
      for (const r of db
        .prepare(
          `SELECT c.bvid, c.page, c.id, c.json, p.title, p.url FROM card c JOIN page p ON p.bvid=c.bvid AND p.page=c.page
           WHERE (c.title LIKE ? OR c.claim LIKE ? OR c.json LIKE ?)${bvid ? ' AND c.bvid=?' : ''} LIMIT ?`,
        )
        .all(`%${t}%`, `%${t}%`, `%${t}%`, ...(bvid ? [bvid] : []), depth)) {
        const k = `${r.bvid}|${r.page}|${r.id}`;
        if (!out.has(k)) out.set(k, { bvid: r.bvid, page: r.page, card: JSON.parse(r.json), title: r.title, url: r.url });
      }
    }
    return [...out.values()];
  }

  /** 讲稿行候选：同样只要求「出现了任一词元」，打分与排序交给上层同一套口径。 */
  lineCandidates(query, { tokens, depth = 20000, bvid } = {}) {
    const db = this.open();
    if (!db) return null;
    const toks = (tokens ?? queryTokens(query)).map((t) => String(t).replace(/["*(){}:^|]+/g, '').trim()).filter((t) => t.length >= 1);
    if (toks.length === 0) return [];
    const where = ['line_fts MATCH ?'];
    const params = [toks.map((t) => `"${t}"`).join(' OR ')];
    if (bvid) {
      where.push('line_fts.bvid=?');
      params.push(bvid);
    }
    return db
      .prepare(
        `SELECT l.bvid, l.page, l.t, l.text, p.url
         FROM line_fts JOIN line l ON l.bvid=line_fts.bvid AND l.page=line_fts.page AND l.t=line_fts.t AND l.seq=line_fts.seq
         JOIN page p ON p.bvid=l.bvid AND p.page=l.page
         WHERE ${where.join(' AND ')} LIMIT ?`,
      )
      .all(...params, depth)
      .map((r) => ({ bvid: r.bvid, page: r.page, t: r.t, text: r.text, url: r.url }));
  }

  /** 待复习：跨页统计与列表（JSON 路线在 100× 规模要 20 秒以上）。 */
  dueCards({ bvid, page, limit = 20, includeUnseen = true, now = new Date().toISOString() } = {}) {
    const db = this.open();
    if (!db) return null;
    const conds = [];
    const params = [now];
    if (bvid) {
      conds.push('c.bvid=?');
      params.push(bvid);
    }
    if (page) {
      conds.push('c.page=?');
      params.push(Number(page));
    }
    const scope = conds.length ? `AND ${conds.join(' AND ')} ` : '';
    const when = includeUnseen
      ? '(r.cid IS NULL OR r.due IS NULL OR r.due<=?)'
      : '(r.cid IS NOT NULL AND r.due IS NOT NULL AND r.due<=?)';
    const rows = db
      .prepare(
        `SELECT c.bvid, c.page, c.id, c.json, p.title, p.url, COALESCE(r.mastery,0) AS mastery, r.due AS due, (r.cid IS NOT NULL) AS seen
         FROM card c JOIN page p ON p.bvid=c.bvid AND p.page=c.page
         LEFT JOIN review r ON r.bvid=c.bvid AND r.page=c.page AND r.cid=c.id
         WHERE ${when} ${scope}
         ORDER BY COALESCE(r.due,'0000-01-01') ASC, mastery ASC
         LIMIT ?`,
      )
      .all(...params, Number(limit) || 20);
    return rows.map((r) => {
      const card = JSON.parse(r.json);
      // 与 JSON 路线的 due 结构对齐（多带 bvid/due 无害）
      return {
        card_id: r.id,
        page: r.page,
        title: card.title,
        kind: card.kind,
        mastery: r.mastery,
        seen: Boolean(r.seen),
        claim: clip(card.claim, 240),
        bvid: r.bvid,
        due: r.due,
        _engine: 'sql',
      };
    });
  }

  counts() {
    const db = this.open();
    if (!db) return null;
    return {
      pages: db.prepare('SELECT COUNT(*) AS n FROM page').get().n,
      cards: db.prepare('SELECT COUNT(*) AS n FROM card').get().n,
      dropped: db.prepare('SELECT COALESCE(SUM(dropped),0) AS n FROM page').get().n,
      lines: db.prepare('SELECT COUNT(*) AS n FROM line').get().n,
      file: this.file,
      bytes: fs.existsSync(this.file) ? fs.statSync(this.file).size : 0,
    };
  }

  /** 索引指纹存这：index.json 的 size:mtime 变了，说明有外部写入（旧版插件/别的进程/手工改）。 */
  metaGet(k) {
    const db = this.open();
    if (!db) return '';
    return db.prepare('SELECT v FROM meta WHERE k=?').get(k)?.v ?? '';
  }

  metaSet(k, v) {
    const db = this.open();
    if (!db) return false;
    db.prepare('INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(String(k), String(v));
    return true;
  }

  /** 每页记的 updated，用来判断哪一页的镜像过期了。 */
  pageStamps() {
    const db = this.open();
    if (!db) return new Map();
    const rows = db.prepare('SELECT bvid,page,updated FROM page').all();
    return new Map(rows.map((r) => [`${r.bvid}|${r.page}`, r.updated ?? '']));
  }

  deletePage({ bvid, page = 1 } = {}) {
    const db = this.open();
    if (!db) return false;
    const p = Number(page) || 1;
    for (const sql of [
      'DELETE FROM card WHERE bvid=? AND page=?',
      'DELETE FROM card_fts WHERE bvid=? AND page=?',
      'DELETE FROM line WHERE bvid=? AND page=?',
      'DELETE FROM line_fts WHERE bvid=? AND page=?',
      'DELETE FROM review WHERE bvid=? AND page=?',
      'DELETE FROM page WHERE bvid=? AND page=?',
    ]) db.prepare(sql).run(bvid, p);
    return true;
  }
}

function jumpOf(url, t, page) {
  const p = Number(page) || 1;
  const base = String(url ?? '');
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${p > 1 ? `${sep}p=${p}&t=` : `${sep}t=`}${Math.floor(Number(t) || 0)}`;
}

/** 从 JSON 全量重建索引（JSON 是真相源，索引只是缓存）。 */
export function rebuildIndex(kb, { onProgress } = {}) {
  const db = kb.indexDb();
  if (!db || !db.open()) return { ok: false, reason: db?.reason ?? '索引不可用' };
  db.drop();
  db.open();
  let pages = 0;
  let cards = 0;
  let lines = 0;
  const skipped = [];
  for (const entry of kb.listVideos()) {
    const store = kb.load(entry.bvid, entry.page ?? 1);
    if (!store?.meta) {
      skipped.push({ bvid: entry.bvid, page: entry.page ?? 1, reason: 'index 里有这条，但页目录读不出 source.json' });
      continue;
    }
    const ok = db.syncPage({
      bvid: entry.bvid,
      page: entry.page ?? 1,
      meta: { ...store.meta, series: entry.series ?? null },
      cards: store.cards,
      lines: store.lines,
      review: store.review ?? {},
      counts: { cards: store.cards.length, dropped: (store.filtered ?? []).length, lines: (store.lines ?? []).length },
    });
    if (!ok) skipped.push({ bvid: entry.bvid, page: entry.page ?? 1, reason: db.reason ?? '写入失败' });
    pages += 1;
    cards += store.cards.length;
    lines += (store.lines ?? []).length;
    onProgress?.({ pages, cards, lines });
  }
  return { ok: skipped.length === 0, pages, cards, lines, skipped, ...db.counts() };
}
