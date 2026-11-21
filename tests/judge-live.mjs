// 真机验收：用本机 qwen 判定真实知识库里的卡片（scan 语义：只写判定缓存，不动 cards.json）。
// 单进程、串行、一次跑完；直连本地服务 10035。空正文按失败处理（不重试大 maxTokens）。
import { KnowledgeBase } from '../dsh-bili-learn/lib/kb.js';
import { judgeCards } from '../dsh-bili-learn/lib/judge.js';

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
        max_tokens: maxTokens ?? 1600,
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
const targets = (process.argv[2] ?? 'BVDEMO000012,BVDEMO000013,BVDEMO000014,BVDEMO000015,BVDEMO000016').split(',');

const grand = { pages: 0, cards: 0, calls: 0, fromCache: 0, ad: 0, filler: 0, uncertain: 0, unjudged: 0 };
const found = [];
for (const bvid of targets) {
  for (const entry of kb.pagesOf(bvid)) {
    const store = kb.load(bvid, entry.page ?? 1);
    if (!store?.cards?.length) continue;
    const t0 = Date.now();
    const res = await judgeCards({
      llm,
      provider: 'local',
      model: MODEL,
      cards: store.cards,
      batchSize: 12,
      maxTokens: 1600,
      cache: store.judgments ?? {},
      pinned: store.pinned ?? [],
    });
    kb.saveJudgments(bvid, res.verdicts, { page: entry.page ?? 1 });
    grand.pages += 1;
    grand.cards += store.cards.length;
    grand.calls += res.calls;
    grand.fromCache += res.fromCache;
    grand.unjudged += res.unjudged.length;
    const dropped = [];
    for (const [id, v] of Object.entries(res.verdicts)) {
      if (v.verdict === 'ad') grand.ad += 1;
      if (v.verdict === 'filler') grand.filler += 1;
      if (v.uncertain) grand.uncertain += 1;
      if (v.verdict === 'ad' || v.verdict === 'filler') {
        const card = store.cards.find((c) => c.id === id);
        dropped.push({ id, verdict: v.verdict, reason: v.reason, title: card?.title, claim: (card?.claim ?? '').slice(0, 90), quote: (card?.evidence?.[0]?.quote ?? '').slice(0, 90) });
        found.push({ bvid, page: entry.page ?? 1, ...dropped[dropped.length - 1] });
      }
    }
    console.log(`${bvid} P${entry.page ?? 1}｜卡 ${store.cards.length}｜调用 ${res.calls}（缓存 ${res.fromCache}）｜${((Date.now() - t0) / 1000).toFixed(0)}s`);
    for (const d of dropped) console.log(`  ${d.verdict === 'ad' ? '广告' : '口水'} [${d.id}] ${d.title}｜理由：${d.reason}\n    结论：${d.claim}\n    证据：${d.quote}`);
  }
}
console.log('\n=== 汇总 ===');
console.log(JSON.stringify(grand));
console.log(JSON.stringify(found, null, 1));
