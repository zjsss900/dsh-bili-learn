// 知识库落盘：一个视频一个目录，卡片/讲稿/大纲/复习状态都是可读的普通文件。
import fs from 'node:fs';
import path from 'node:path';
import { formatTime, scoreCard, searchLines, tokenize, topTerms, clip } from './text.js';
import { applyVerdicts } from './judge.js';
import { IndexDb, rebuildIndex } from './db.js';

const INDEX_VERSION = 1;
// 复习间隔（天），下标即熟练度。
const INTERVAL_DAYS = [0, 1, 3, 7, 16, 35, 60];

export function defaultKbRoot() {
  const home = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh');
  return path.join(home, 'bili-kb');
}

/** 索引与目录的键：P1 就是 bvid，P2+ 是 `<bvid>_p2`。 */
export function pageKey(bvid, page = 1) {
  const p = Number(page) || 1;
  return p > 1 ? `${bvid}_p${p}` : bvid;
}

/** 回跳链接：多 P 要带 ?p=，否则跳到 P1 的秒数对不上。 */
export function jumpUrl(url, t, page = 1) {
  const p = Number(page) || 1;
  const base = String(url ?? '');
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${p > 1 ? `${sep}p=${p}&t=` : `${sep}t=`}${Math.floor(Number(t) || 0)}`;
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function readJsonSafe(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export class KnowledgeBase {
  constructor(root, { engine = 'auto' } = {}) {
    this.root = root;
    // 'auto' = 有 SQLite 索引就走索引；'json' = 按配置彻底关掉索引层
    this.engineDefault = engine;
  }

  ensure() {
    fs.mkdirSync(this.root, { recursive: true });
    const index = path.join(this.root, 'index.json');
    if (!fs.existsSync(index)) writeJsonAtomic(index, { version: INDEX_VERSION, videos: {}, series: {} });
    return index;
  }

  /**
   * 多 P 视频按页分目录：P1 沿用 <bvid>（已有数据不动），P2+ 用 <bvid>_p2。
   * 不这样就会互相覆盖——学 P2 把 P1 的 cards/transcript 整份冲掉（实测踩过）。
   */
  videoDir(bvid, page = 1) {
    return path.join(this.root, pageKey(bvid, page));
  }

  /** 一个 bvid 在知识库里的所有页（按页码升序）。 */
  pagesOf(bvid) {
    return Object.values(this.readIndex().videos ?? {})
      .filter((v) => v.bvid === bvid)
      .sort((a, b) => (a.page ?? 1) - (b.page ?? 1));
  }

  readIndex() {
    return readJsonSafe(path.join(this.root, 'index.json'), { version: INDEX_VERSION, videos: {}, series: {} });
  }

  /**
   * SQLite 查询索引：只是 JSON 的派生缓存，随时可删可重建。
   * node:sqlite 不可用（老运行时/被禁用）时返回 null，所有查询自动走 JSON 路线。
   */
  indexDb() {
    if (this._db === undefined) this._db = new IndexDb(this.root);
    return this._db;
  }

  /**
   * 用之前先保证索引可用且不陈旧：
   * 1) 索引空了（老库升级、索引被删）→ 小库直接补建，大库交给 bili_index action=rebuild；
   * 2) 已有索引但 index.json 指纹变了（旧版本插件写的、别的进程写的、手工改的）→ 只重镜像过期页。
   * 少了第 2 步会静默少答：SQL 只按已镜像的页返回，页面数比 JSON 少却照样出结果。
   */
  ensureIndex() {
    if (this.engineDefault === 'json') return false;
    const db = this.indexDb();
    if (!db?.open()) return false;
    if ((db.counts()?.pages ?? 0) === 0) {
      const entries = this.listVideos();
      if (entries.length === 0) return false;
      if (entries.length > 400) return false;
      return this.rebuildIndex().ok === true;
    }
    return this.syncStalePages().ok === true;
  }

  /** index.json 的指纹（size:mtime），比对开销是微秒级。 */
  jsonStamp() {
    try {
      const s = fs.statSync(path.join(this.root, 'index.json'));
      return `${s.size}:${Math.round(s.mtimeMs)}`;
    } catch {
      return 'none';
    }
  }

  /** 只重镜像过期的页；JSON 里删掉的页也从索引里删掉。指纹没变就直接返回，不扫全库。 */
  syncStalePages() {
    const db = this.indexDb();
    if (!db?.open()) return { ok: false, reason: db?.reason ?? '索引不可用' };
    const stamp = this.jsonStamp();
    if (stamp !== 'none' && db.metaGet('stamp') === stamp) return { ok: true, synced: 0, fresh: true };
    const entries = this.listVideos();
    const have = db.pageStamps();
    const skipped = [];
    let synced = 0;
    for (const entry of entries) {
      const page = entry.page ?? 1;
      const key = `${entry.bvid}|${page}`;
      const want = entry.updatedAt ?? '';
      const got = have.get(key);
      have.delete(key);
      if (got === want && want !== '') continue;
      const r = this.syncPage(entry.bvid, page);
      if (r.ok) synced += 1;
      else skipped.push(`${key}:${r.reason}`);
    }
    let removed = 0;
    for (const key of have.keys()) {
      const at = key.lastIndexOf('|');
      db.deletePage({ bvid: key.slice(0, at), page: Number(key.slice(at + 1)) || 1 });
      removed += 1;
    }
    const ok = skipped.length === 0;
    if (ok && stamp !== 'none') db.metaSet('stamp', stamp);
    return { ok, synced, removed, skipped, reason: ok ? '' : skipped.join('；') };
  }

  /** 写完 JSON 后把这一页镜像进索引。索引失败绝不回滚知识，只在返回里说清楚。 */
  syncPage(bvid, page = 1) {
    const db = this.indexDb();
    if (!db || !db.open()) return { ok: false, reason: db?.reason ?? '索引不可用' };
    const store = this.load(bvid, page);
    if (!store?.meta) return { ok: false, reason: '这一页没有落盘数据' };
    const entry = this.readIndex().videos?.[pageKey(bvid, page)] ?? {};
    const ok = db.syncPage({
      bvid,
      page,
      meta: { ...store.meta, series: entry.series ?? null },
      cards: store.cards,
      lines: store.lines,
      review: store.review ?? {},
      counts: { cards: store.cards.length, dropped: (store.filtered ?? []).length, lines: (store.lines ?? []).length },
      updated: entry.updatedAt ?? '',
    });
    if (ok) db.metaSet('stamp', this.jsonStamp());
    return { ok, reason: ok ? '' : db.reason };
  }

  /** 全量重建索引（JSON 是真相源，索引只是缓存）。重建完把指纹补上，免得下次检索再补镜像一遍。 */
  rebuildIndex(options) {
    const r = rebuildIndex(this, options);
    if (r?.ok) {
      const db = this.indexDb();
      if (db?.open()) db.metaSet('stamp', this.jsonStamp());
    }
    return r;
  }

  /** 索引与 JSON 是否一致（数量比对，给 verify 用）。 */
  indexStatus() {
    const db = this.indexDb();
    const entries = this.listVideos();
    let jsonPages = 0;
    let jsonCards = 0;
    let jsonLines = 0;
    const dangling = [];
    for (const entry of entries) {
      const store = this.load(entry.bvid, entry.page ?? 1);
      if (!store?.meta) {
        dangling.push(`${entry.bvid} P${entry.page ?? 1}`);
        continue;
      }
      jsonPages += 1;
      jsonCards += store.cards.length;
      jsonLines += store.lines.length;
    }
    const sql = db?.open() ? db.counts() : null;
    return {
      engine: sql ? 'sql' : 'json',
      reason: sql ? '' : db?.reason ?? '',
      json: { pages: jsonPages, cards: jsonCards, lines: jsonLines, indexEntries: entries.length },
      sql,
      // index.json 里有、页目录读不出来的条目（不是索引坏了，是历史脏条目）
      dangling,
      consistent: sql ? sql.pages === jsonPages && sql.cards === jsonCards : false,
    };
  }

  listVideos() {
    return Object.values(this.readIndex().videos ?? {}).sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  }

  upsertIndex(meta, counts) {
    const index = this.readIndex();
    index.version = INDEX_VERSION;
    index.videos = index.videos ?? {};
    const key = pageKey(meta.bvid, meta.page);
    index.videos[key] = { ...(index.videos[key] ?? {}), ...meta, page: Number(meta.page) || 1, ...counts, updatedAt: new Date().toISOString() };
    writeJsonAtomic(path.join(this.root, 'index.json'), index);
    // 卡片级写入都会经过这里 → 顺手把这一页镜像进 SQLite 索引（失败不影响知识落盘）。
    this.syncPage(meta.bvid, meta.page ?? 1);
    return key;
  }

  // ------------------------------------------------------------ 系列（合集 / 系列）

  /** 落盘一个系列的稿件清单。已学状态不写在这里，按 index.videos 现算，避免两处真相。 */
  saveSeries(series, episodes) {
    this.ensure();
    const index = this.readIndex();
    index.series = index.series ?? {};
    const key = series.key;
    const prev = index.series[key] ?? {};
    index.series[key] = {
      ...prev,
      key,
      kind: series.kind ?? prev.kind ?? 'season',
      season_id: series.season_id ?? prev.season_id ?? 0,
      series_id: series.series_id ?? prev.series_id ?? 0,
      title: series.title ?? prev.title ?? '',
      raw_title: series.raw_title ?? prev.raw_title ?? '',
      mid: series.mid ?? prev.mid ?? 0,
      owner: series.owner ?? prev.owner ?? '',
      cover: series.cover ?? prev.cover ?? '',
      total: series.total ?? episodes?.length ?? prev.total ?? 0,
      episodes: episodes ?? prev.episodes ?? [],
      updatedAt: new Date().toISOString(),
    };
    writeJsonAtomic(path.join(this.root, 'index.json'), index);
    return index.series[key];
  }

  readSeries() {
    return this.readIndex().series ?? {};
  }

  getSeries(key) {
    return this.readSeries()[key];
  }

  /** 系列学习进度：已学的、未学的、下一集。 */
  seriesProgress(key) {
    const series = this.getSeries(key);
    if (!series) return undefined;
    const index = this.readIndex();
    const episodes = series.episodes ?? [];
    const learned = [];
    const missing = [];
    for (const ep of episodes) {
      // 多 P 稿件：任意一页学过就算这一集学过。
      const entry = Object.values(index.videos ?? {}).find((v) => v.bvid === ep.bvid);
      if (entry) learned.push({ bvid: ep.bvid, index: ep.index, title: ep.title, cards: entry.cards ?? 0, segments: entry.segments ?? 0, coverage: entry.coverage });
      else missing.push(ep);
    }
    return { series, total: episodes.length, learned, missing, next: missing[0] ?? null };
  }

  /** 给稿件打系列标记（按系列学习时写入，方便按系列检索与出技能）。 */
  tagVideoSeries(bvid, ref, { page = 1 } = {}) {
    const index = this.readIndex();
    const video = index.videos?.[pageKey(bvid, page)];
    if (!video) return false;
    video.series = ref;
    writeJsonAtomic(path.join(this.root, 'index.json'), index);
    return true;
  }

  load(bvid, page = 1) {
    const dir = this.videoDir(bvid, page);
    if (!fs.existsSync(dir)) return undefined;
    return {
      meta: readJsonSafe(path.join(dir, 'source.json'), undefined),
      lines: readJsonSafe(path.join(dir, 'transcript.json'), []),
      segments: readJsonSafe(path.join(dir, 'segments.json'), []),
      cards: readJsonSafe(path.join(dir, 'cards.json'), []),
      review: readJsonSafe(path.join(dir, 'review.json'), {}),
      filtered: readJsonSafe(path.join(dir, 'filtered.json'), []),
      pinned: readJsonSafe(path.join(dir, 'pinned.json'), []),
      judgments: readJsonSafe(path.join(dir, 'judgments.json'), {}),
    };
  }

  /** 用户明确要留下的卡片 id（restore 过），规则永远不再剔它们。 */
  pinnedIds(bvid, page = 1) {
    return readJsonSafe(path.join(this.videoDir(bvid, page), 'pinned.json'), []);
  }

  /** 写入一个视频的全部产物。 */
  saveVideo({ meta, lines, segments, cards, warnings }) {
    this.ensure();
    const dir = this.videoDir(meta.bvid, meta.page);
    fs.mkdirSync(dir, { recursive: true });
    writeJsonAtomic(path.join(dir, 'source.json'), meta);
    writeJsonAtomic(path.join(dir, 'transcript.json'), lines);
    writeJsonAtomic(
      path.join(dir, 'segments.json'),
      segments.map((s) => ({ index: s.index, start: s.start, end: s.end, chars: s.chars, terms: s.terms ?? [], status: s.status ?? 'pending', note: s.note ?? '' })),
    );
    // 判定不在这里做（不写规则去猜广告）：卡片原样落盘，质检由 bili_filter 送模型判完再记账。
    writeJsonAtomic(path.join(dir, 'cards.json'), cards);
    const droppedSoFar = readJsonSafe(path.join(dir, 'filtered.json'), []);

    fs.writeFileSync(
      path.join(dir, 'transcript.md'),
      [`# ${meta.title}`, '', `- 视频：${meta.url}`, `- 时长：${formatTime(meta.duration)}｜UP：${meta.owner}`, `- 字幕来源：${meta.transcriptSource}（${meta.transcriptNote ?? '未知'}）`, '', '## 讲稿（带时间锚点）', '', ...lines.map((l) => `- **[${formatTime(l.t)}]** ${l.text}`), ''].join('\n'),
      'utf8',
    );

    fs.writeFileSync(
      path.join(dir, 'outline.md'),
      [
        `# 分段大纲：${meta.title}`,
        '',
        ...segments.flatMap((s) => [
          `## 段 ${s.index + 1}｜${formatTime(s.start)} – ${formatTime(s.end)}`,
          `- 状态：${s.status ?? 'pending'}${s.note ? `（${s.note}）` : ''}`,
          `- 关键词：${(s.terms ?? []).map((t) => t.term).join('、') || '—'}`,
          `- 首句：${clip(s.lines?.[0]?.text ?? '', 120)}`,
          '',
        ]),
      ].join('\n'),
      'utf8',
    );

    fs.writeFileSync(path.join(dir, 'cards.md'), renderCards(meta, cards, droppedSoFar), 'utf8');
    fs.writeFileSync(path.join(dir, 'study.md'), renderStudy(meta, cards, this.load(meta.bvid, meta.page)?.review ?? {}), 'utf8');

    this.upsertIndex(
      {
        bvid: meta.bvid,
        page: meta.page ?? 1,
        part: meta.part ?? '',
        title: meta.title,
        owner: meta.owner,
        url: meta.url,
        duration: meta.duration,
        transcriptSource: meta.transcriptSource,
        coverage: meta.coverage,
        warnings: warnings ?? [],
      },
      { cards: cards.length, segments: segments.length, lines: lines.length, dropped: droppedSoFar.length },
    );
    if (meta.series?.key) {
      this.tagVideoSeries(meta.bvid, { key: meta.series.key, index: meta.series.index ?? 0, total: meta.series.total ?? 0, title: meta.series.title ?? '' }, { page: meta.page ?? 1 });
    }
    return dir;
  }

  /** 由模型或用户直接写卡片（覆盖同 id 的卡片）。多 P 必须指定 page，否则默认 P1。 */
  saveCards(bvid, cards, { page = 1, source = 'model', replace = false } = {}) {
    const existing = this.load(bvid, page);
    if (!existing?.meta) throw new Error(`知识库里没有 ${bvid}，先运行 bili_learn`);
    // replace=true 时以本次提交为准，删掉该视频其余卡片（用来清掉自动提取的废卡）。
    const byId = new Map(replace ? [] : existing.cards.map((c) => [c.id, c]));
    for (const card of cards) {
      const id = String(card.id ?? `c${byId.size + 1}`).slice(0, 24);
      byId.set(id, {
        id,
        kind: card.kind ?? 'concept',
        title: String(card.title ?? '').slice(0, 120),
        claim: String(card.claim ?? '').slice(0, 1200),
        why: String(card.why ?? '').slice(0, 800),
        how: (card.how ?? []).map((h) => String(h).slice(0, 400)).slice(0, 12),
        evidence: (card.evidence ?? []).map((e) => ({ t: Number(e.t) || 0, quote: String(e.quote ?? '').slice(0, 300) })).slice(0, 8),
        tags: (card.tags ?? []).map((t) => String(t).slice(0, 40)).slice(0, 10),
        confidence: card.confidence ?? 'medium',
        source,
        updatedAt: new Date().toISOString(),
      });
    }
    const merged = [...byId.values()];
    const dir = this.videoDir(bvid, page);
    writeJsonAtomic(path.join(dir, 'cards.json'), merged);
    fs.writeFileSync(path.join(dir, 'cards.md'), renderCards(existing.meta, merged, existing.filtered ?? []), 'utf8');
    fs.writeFileSync(path.join(dir, 'study.md'), renderStudy(existing.meta, merged, existing.review), 'utf8');
    this.upsertIndex({ bvid, page }, { cards: merged.length, dropped: (existing.filtered ?? []).length });
    return merged.length;
  }

  /**
   * 把模型判定落账：ad/filler 移到 filtered.json（带模型的 verdict 与 reason），其余留在 cards.json。
   * 判定本身来自 lib/judge.js（模型），这里只记账 + 重写视图。
   */
  applyJudgments(bvid, { page = 1, verdicts = {}, drop = ['ad', 'filler'] } = {}) {
    const store = this.load(bvid, page);
    if (!store?.meta) throw new Error(`知识库里没有 ${bvid}`);
    const pass = applyVerdicts(store.cards, verdicts, { drop, pinned: store.pinned ?? [] });
    const droppedById = new Map([...(store.filtered ?? []), ...pass.dropped].map((c) => [c.id, c]));
    const dir = this.videoDir(bvid, page);
    writeJsonAtomic(path.join(dir, 'cards.json'), pass.kept);
    writeJsonAtomic(path.join(dir, 'filtered.json'), [...droppedById.values()]);
    fs.writeFileSync(path.join(dir, 'cards.md'), renderCards(store.meta, pass.kept, [...droppedById.values()]), 'utf8');
    fs.writeFileSync(path.join(dir, 'study.md'), renderStudy(store.meta, pass.kept, store.review), 'utf8');
    this.upsertIndex({ bvid, page }, { cards: pass.kept.length, dropped: droppedById.size });
    return { kept: pass.kept.length, removed: pass.dropped, uncertain: pass.uncertain, stats: pass.stats, stored: droppedById.size };
  }

  /** 缓存模型判定（省下一次同样的调用），按卡片指纹失效。 */
  saveJudgments(bvid, judgments, { page = 1 } = {}) {
    const dir = this.videoDir(bvid, page);
    const merged = { ...readJsonSafe(path.join(dir, 'judgments.json'), {}), ...(judgments ?? {}) };
    writeJsonAtomic(path.join(dir, 'judgments.json'), merged);
    return Object.keys(merged).length;
  }

  /** 把被筛掉的卡片放回 cards.json（用户说「这张不是广告」时用）。 */
  restoreCards(bvid, ids, { page = 1 } = {}) {
    const store = this.load(bvid, page);
    if (!store?.meta) throw new Error(`知识库里没有 ${bvid}`);
    const wanted = new Set(ids ?? []);
    const back = (store.filtered ?? []).filter((c) => wanted.has(c.id)).map(({ _verdict, _reasons, ...card }) => card);
    if (back.length === 0) return { restored: 0, available: (store.filtered ?? []).map((c) => ({ id: c.id, title: c.title, verdict: c._verdict, reasons: c._reasons })) };
    const byId = new Map([...store.cards, ...back].map((c) => [c.id, c]));
    const dir = this.videoDir(bvid, page);
    writeJsonAtomic(path.join(dir, 'cards.json'), [...byId.values()]);
    writeJsonAtomic(path.join(dir, 'filtered.json'), (store.filtered ?? []).filter((c) => !wanted.has(c.id)));
    // 放回即钉住：以后重学/重筛都不再剔这张（用户的判断优先于规则）。
    const pins = [...new Set([...(store.pinned ?? []), ...back.map((c) => c.id)])];
    writeJsonAtomic(path.join(dir, 'pinned.json'), pins);
    fs.writeFileSync(path.join(dir, 'cards.md'), renderCards(store.meta, [...byId.values()], (store.filtered ?? []).filter((c) => !wanted.has(c.id))), 'utf8');
    fs.writeFileSync(path.join(dir, 'study.md'), renderStudy(store.meta, [...byId.values()], store.review), 'utf8');
    this.upsertIndex({ bvid, page }, { cards: byId.size, dropped: (store.filtered ?? []).length - back.length });
    return { restored: back.length, ids: back.map((c) => c.id), pinned: pins };
  }

  /** 记录复习结果，更新熟练度与下次到期时间。 */
  applyReview(bvid, results, { page = 1 } = {}) {
    const store = this.load(bvid, page);
    if (!store?.meta) throw new Error(`知识库里没有 ${bvid}`);
    const review = { ...store.review };
    const now = Date.now();
    const applied = [];
    for (const item of results) {
      const state = review[item.card_id] ?? { mastery: 0, streak: 0, reviews: 0 };
      const ok = item.verdict === 'ok';
      state.mastery = Math.max(0, Math.min(INTERVAL_DAYS.length - 1, state.mastery + (ok ? 1 : -2)));
      state.streak = ok ? state.streak + 1 : 0;
      state.reviews = (state.reviews ?? 0) + 1;
      state.lastReview = new Date(now).toISOString();
      state.due = new Date(now + INTERVAL_DAYS[state.mastery] * 86400000).toISOString();
      review[item.card_id] = state;
      applied.push({ card_id: item.card_id, mastery: state.mastery, due: state.due });
    }
    writeJsonAtomic(path.join(this.videoDir(bvid, page), 'review.json'), review);
    this.syncPage(bvid, page);
    return applied;
  }

  /** 多 P：results 里可带 page（不带就用 page 参数），按页分别写各自的 review.json。 */
  applyReviewMulti(bvid, results, { page = 1 } = {}) {
    const groups = new Map();
    for (const item of results ?? []) {
      const p = Number(item.page ?? page) || 1;
      if (!groups.has(p)) groups.set(p, []);
      groups.get(p).push(item);
    }
    const applied = [];
    for (const [p, items] of groups) {
      for (const row of this.applyReview(bvid, items, { page: p })) applied.push({ ...row, page: p });
    }
    return applied;
  }

  /** 待复习卡片。不给 page 就把这个 bvid 的所有页一起算。 */
  dueCards(bvid, { page, limit = 20, includeUnseen = true, engine = this.engineDefault } = {}) {
    if (engine !== 'json') {
      this.ensureIndex();
      const db = this.indexDb();
      if (db?.open()) {
        const rows = db.dueCards({ bvid, page, limit, includeUnseen });
        if (rows && rows.length > 0) return rows;
      }
    }
    const wanted = this.pagesOf(bvid).filter((v) => page === undefined || (v.page ?? 1) === Number(page));
    const now = Date.now();
    const out = [];
    for (const entry of wanted) {
      const store = this.load(bvid, entry.page ?? 1);
      if (!store?.meta) continue;
      for (const card of store.cards) {
        const state = store.review[card.id];
        const due = state?.due ? Date.parse(state.due) : 0;
        const seen = Boolean(state);
        if (!seen && !includeUnseen) continue;
        if (seen && due > now) continue;
        out.push({ card_id: card.id, page: entry.page ?? 1, title: card.title, kind: card.kind, mastery: state?.mastery ?? 0, seen, claim: clip(card.claim, 240) });
      }
    }
    return out.slice(0, limit);
  }

  /**
   * 检索。两条路共用同一套打分与排序（text.js 的 scoreCard / searchLines 口径），
   * SQLite 只负责「含任一词元」的候选召回——那正是打分 >0 的必要条件，所以候选集是
   * JSON 全扫结果的超集，最终结果必须逐条一致（实测拿真库 60 个查询双跑盯着）。
   */
  search(query, { bvid, series, limit = 8, withLines = true, engine = this.engineDefault } = {}) {
    const tokens = tokenize(query);
    if (tokens.length === 0) return { cards: [], lines: [], engine: 'none' };
    const cmpCards = (a, b) => b._score - a._score
      || String(a._video?.bvid ?? '').localeCompare(String(b._video?.bvid ?? ''))
      || (a._video?.page ?? 1) - (b._video?.page ?? 1)
      || String(a.id ?? '').localeCompare(String(b.id ?? ''));
    const cmpLines = (a, b) => b.score - a.score
      || a.t - b.t
      || String(a.bvid).localeCompare(String(b.bvid))
      || (a.page ?? 1) - (b.page ?? 1);
    if (engine !== 'json') {
      this.ensureIndex();
      const db = this.indexDb();
      const bvids = series ? (this.seriesProgress(series)?.learned ?? []).map((v) => v.bvid) : undefined;
      if (db?.open() && (!series || bvids.length > 0)) {
        const cand = db.cardCandidates(query, { tokens, bvid, bvids }) ?? [];
        const lineCand = withLines ? (db.lineCandidates(query, { tokens, bvid }) ?? []) : [];
        if (cand.length > 0 || lineCand.length > 0) {
          const cardHits = [];
          for (const c of cand) {
            const score = scoreCard(c.card, tokens);
            if (score > 0) cardHits.push({ ...c.card, _video: { bvid: c.bvid, page: c.page, title: c.title, url: c.url }, _score: score });
          }
          // 与 JSON 路线同样的「每页先取前 3 行」规则，否则全局 top-8 口径会偏
          const perPage = new Map();
          for (const l of lineCand) {
            const bag = new Set(tokenize(l.text));
            let score = 0;
            for (const token of tokens) if (bag.has(token)) score += 1;
            if (score <= 0) continue;
            const key = `${l.bvid}|${l.page}`;
            const list = perPage.get(key) ?? [];
            list.push({ bvid: l.bvid, page: l.page, t: l.t, text: l.text, score, url: l.url });
            perPage.set(key, list);
          }
          const lineHits = [];
          for (const list of perPage.values()) {
            list.sort((a, b) => b.score - a.score || a.t - b.t);
            for (const hit of list.slice(0, 3)) {
              lineHits.push({ bvid: hit.bvid, page: hit.page, t: hit.t, text: hit.text, score: hit.score, url: jumpUrl(hit.url ?? '', hit.t, hit.page) });
            }
          }
          cardHits.sort(cmpCards);
          lineHits.sort(cmpLines);
          return { cards: cardHits.slice(0, limit), lines: lineHits.slice(0, limit), engine: 'sql', candidates: cand.length };
        }
      }
    }
    const all = Object.values(this.readIndex().videos ?? {});
    let entries;
    if (bvid) entries = all.filter((v) => v.bvid === bvid);
    else if (series) {
      const ids = new Set((this.seriesProgress(series)?.learned ?? []).map((v) => v.bvid));
      entries = all.filter((v) => ids.has(v.bvid));
    } else entries = this.listVideos();
    const cardHits = [];
    const lineHits = [];
    for (const entry of entries) {
      const page = entry.page ?? 1;
      const store = this.load(entry.bvid, page);
      if (!store?.meta) continue;
      for (const card of store.cards) {
        const score = scoreCard(card, tokens);
        if (score > 0) cardHits.push({ ...card, _video: { bvid: entry.bvid, page, title: store.meta.title, url: store.meta.url }, _score: score });
      }
      if (withLines) {
        for (const hit of searchLines(store.lines, tokens, 3)) {
          lineHits.push({ bvid: entry.bvid, page, t: hit.t, text: hit.text, score: hit.score, url: jumpUrl(store.meta.url, hit.t, page) });
        }
      }
    }
    cardHits.sort(cmpCards);
    lineHits.sort(cmpLines);
    return { cards: cardHits.slice(0, limit), lines: lineHits.slice(0, limit), engine: 'json' };
  }

  stats() {
    const videos = this.listVideos();
    let cards = 0;
    let mastered = 0;
    let due = 0;
    const now = Date.now();
    for (const video of videos) {
      const store = this.load(video.bvid, video.page ?? 1);
      cards += store?.cards.length ?? 0;
      for (const card of store?.cards ?? []) {
        const state = store.review[card.id];
        if (state && state.mastery >= 4) mastered += 1;
        if (!state || (state.due && Date.parse(state.due) <= now)) due += 1;
      }
    }
    const series = Object.keys(this.readSeries())
      .map((key) => {
        const progress = this.seriesProgress(key);
        const s = progress?.series ?? {};
        return {
          key,
          title: s.title ?? '',
          kind: s.kind ?? 'season',
          owner: s.owner ?? '',
          total: progress?.total ?? 0,
          learned: progress?.learned.length ?? 0,
          missing: progress?.missing.length ?? 0,
          next: progress?.next?.title ?? '',
        };
      })
      .sort((a, b) => b.total - a.total);
    return {
      root: this.root,
      videos: videos.length,
      distinctVideos: new Set(videos.map((v) => v.bvid)).size,
      cards,
      mastered,
      due,
      series,
      list: videos.map((v) => ({ bvid: v.bvid, page: v.page ?? 1, part: v.part ?? '', title: v.title, cards: v.cards ?? 0, series: v.series?.key ?? '', source: v.transcriptSource, warnings: (v.warnings ?? []).length })),
    };
  }
}

function evidenceLinks(meta, card) {
  return (card.evidence ?? [])
    .map((e) => `  - [${formatTime(e.t)}] ${clip(e.quote, 160)} → ${jumpUrl(meta.url, e.t, meta.page ?? 1)}`)
    .join('\n');
}

function renderCards(meta, cards, dropped = []) {
  const head = `# 知识卡片：${meta.title}\n\n- 视频：${meta.url}\n- UP：${meta.owner}｜时长：${formatTime(meta.duration)}\n- 卡片数：${cards.length}${dropped.length ? `｜已筛掉 ${dropped.length} 张（广告/引流/口水话，理由见文末，可回滚）` : ''}\n`;
  const body = cards
    .map((card) => {
      const parts = [`\n## ${card.title}`, `- 类型：${card.kind}｜置信度：${card.confidence}｜来源：${card.source}`];
      if (card.tags?.length) parts.push(`- 标签：${card.tags.join('、')}`);
      parts.push(`- 结论：${card.claim}`);
      if (card.why) parts.push(`- 为什么：${card.why}`);
      if (card.how?.length) parts.push(`- 怎么做：\n${card.how.map((h, i) => `  ${i + 1}. ${h}`).join('\n')}`);
      if (card.evidence?.length) parts.push(`- 证据（可回跳原视频）：\n${evidenceLinks(meta, card)}`);
      return parts.join('\n');
    })
    .join('\n');
  const tail = dropped.length
    ? `\n\n## 已筛掉（不进复习与检索）\n\n${dropped
        .map((c) => `- [${c.id}] ${c.title}｜${c._verdict ?? '噪声'}：${(c._reasons ?? []).join('、')}\n  - 结论：${clip(c.claim, 120)}\n  - 当时的证据：${clip((c.evidence ?? [])[0]?.quote ?? '', 120)}`)
        .join('\n')}\n\n> 这张判错了？用 \`bili_filter action=restore\` 放回（卡片存在 filtered.json，没有真删）。\n`
    : '';
  return `${head}${body}${tail}\n`;
}

function renderStudy(meta, cards, review) {
  const now = Date.now();
  const due = cards.filter((c) => {
    const state = review[c.id];
    return !state || (state.due && Date.parse(state.due) <= now);
  });
  const mastered = cards.filter((c) => (review[c.id]?.mastery ?? 0) >= 4);
  return [
    `# 学习契约：${meta.title}`,
    '',
    '学会的判定标准：能在不看讲稿的情况下复述每张卡片的「结论」，并说出「为什么」和「怎么做」。',
    '',
    `- 卡片：${cards.length}｜已掌握（熟练度≥4）：${mastered.length}｜待复习：${due.length}`,
    '',
    '## 自测提问（按卡片生成，回答后再 bili_practice grade 记录）',
    '',
    ...cards.map((card) => `- [${card.id}] ${card.title} → 请解释：${clip(card.claim, 80)}（依据：${card.evidence?.[0] ? `${formatTime(card.evidence[0].t)} 处讲解` : '未标注时间'}）`),
    '',
    '## 应用任务',
    '',
    '把本视频的知识用在真实任务上：让 AI 调用 `bili_recall` 检索这些卡片，再据此写代码/写方案/解题，并指出依据来自哪个时间点。',
    '',
  ].join('\n');
}

export { topTerms };
