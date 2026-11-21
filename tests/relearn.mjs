// 离线补提取：只重跑 segments.json 里 status=unread 的段（用最新 distill 代码，含截断切半兜底）。
// 单进程、串行、直连本地服务；补出来的卡按 id 去重后追加，并把该段标 distilled。
import { KnowledgeBase } from '../dsh-bili-learn/lib/kb.js';
import { distillSegments } from '../dsh-bili-learn/lib/distill.js';

const BASE = process.env.LOCAL_URL ?? 'http://127.0.0.1:10035/v1/chat/completions';
const MODEL = process.env.LOCAL_MODEL ?? 'qwen3.8-flash-next-iq3_s';

const llm = {
  async *stream({ system, messages, maxTokens }) {
    const res = await fetch(BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer local' },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'system', content: system }, ...messages.map((m) => ({ role: m.role, content: m.content }))],
        max_tokens: maxTokens ?? 1400,
        temperature: 0,
      }),
    });
    if (!res.ok) throw new Error(`本地服务 ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    const msg = data?.choices?.[0]?.message ?? {};
    const reasoning = msg.reasoning_content ?? '';
    const content = msg.content ?? '';
    if (reasoning) yield { type: 'reasoning-delta', index: 0, text: reasoning };
    if (content) yield { type: 'text-delta', index: 0, text: content };
    yield { type: 'finish', index: 0, reason: { kind: content ? 'stop' : 'error', raw: data?.choices?.[0]?.finish_reason ?? 'no-content' } };
  },
};

const kb = new KnowledgeBase(process.env.BILI_KB ?? '<你的 bili-kb 目录>');
const targets = (process.argv[2] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
if (targets.length === 0) {
  console.log('用法：node .tools/relearn.mjs BV1xxx[,BV2yyy]');
  process.exit(1);
}

const grand = { pages: 0, retried: 0, fixed: 0, stillUnread: 0, newCards: 0 };
for (const spec of targets) {
  const [bvid, p] = spec.split(':');
  for (const entry of kb.pagesOf(bvid)) {
    const page = entry.page ?? 1;
    if (p && String(page) !== p) continue;
    const store = kb.load(bvid, page);
    if (!store) continue;
    const segs = store.segments ?? [];
    // 默认只补 unread；RELEARN_FORCE=1 时全段重跑（用来验证兜底路径、或收割半段里剩下的知识点）
    const todo = process.env.RELEARN_FORCE ? segs : segs.filter((s) => s.status === 'unread');
    if (todo.length === 0) {
      console.log(`${bvid} P${page}：没有 unread 段（${segs.length} 段，卡 ${store.cards.length}）`);
      continue;
    }
    // segments.json 不存正文：按时间窗从讲稿重建
    const runnable = todo.map((s) => ({
      ...s,
      text: (store.lines ?? []).filter((l) => l.t >= s.start && l.t < s.end).map((l) => l.text).join('\n'),
    }));
    for (const s of runnable) console.log(`${bvid} P${page} 重跑第 ${s.index} 段 [${Math.round(s.start)}s–${Math.round(s.end)}s，${s.text.length} 字]`);
    grand.pages += 1;
    grand.retried += runnable.length;
    const t0 = Date.now();
    const run = await distillSegments({ llm, provider: 'local', model: MODEL, meta: store.meta, segments: runnable, maxCardsPerSegment: 5, maxTokens: 1400 });
    const have = new Set(store.cards.map((c) => c.id));
    const seenClaim = new Set(store.cards.map((c) => String(c.claim ?? '').slice(0, 40)));
    const added = run.cards.filter((c) => !have.has(c.id) && !seenClaim.has(String(c.claim ?? '').slice(0, 40)));
    for (const r of run.segmentReports ?? []) {
      const target = segs.find((s) => s.index === r.index);
      if (target) {
        target.status = r.status;
        target.note = r.note ?? '';
      }
      if (r.status === 'distilled') grand.fixed += 1;
      else grand.stillUnread += 1;
      console.log(`  段 ${r.index} → ${r.status}${r.note ? `｜${r.note}` : ''}`);
    }
    for (const c of added) console.log(`  + [${c.id}] ${c.title}｜${(c.claim ?? '').slice(0, 60)}`);
    grand.newCards += added.length;
    if (added.length > 0 || run.segmentReports.length > 0) {
      kb.saveVideo({ meta: store.meta, lines: store.lines, segments: segs, cards: [...store.cards, ...added], warnings: store.warnings ?? [] });
    }
    console.log(`${bvid} P${page}：+${added.length} 张（现有 ${store.cards.length + added.length}）｜${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
}
console.log('\n=== 汇总 ===');
console.log(JSON.stringify(grand));
