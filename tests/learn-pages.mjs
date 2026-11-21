// 批量按分 P 学一门多 P 大课：直接驱动插件真实工具（新代码：提取截断兜底 + 质检 + 索引镜像都生效），
// llm 用本地服务，单进程串行。每页只打印一行，结尾打汇总。
const entry = await import('../dsh-bili-learn/index.js');

const BASE = process.env.LOCAL_URL ?? 'http://127.0.0.1:10035/v1/chat/completions';
const MODEL = process.env.LOCAL_MODEL ?? 'qwen3.8-flash-next-iq3_s';
const KB = process.env.BILI_KB ?? '<你的 bili-kb 目录>';
const URL0 = process.argv[2] ?? 'https://www.bilibili.com/video/BVDEMO000018';
const PAGES = (process.argv[3] ?? '2-30').split(',').map((s) => {
  const m = s.match(/^(\d+)-(\d+)$/);
  return m ? Array.from({ length: Number(m[2]) - Number(m[1]) + 1 }, (_, i) => Number(m[1]) + i) : [Number(s)];
}).flat();

const llm = {
  calls: 0,
  async *stream({ system, messages, maxTokens }) {
    llm.calls += 1;
    const res = await fetch(BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer local' },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'system', content: system }, ...(messages ?? []).map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }))],
        max_tokens: maxTokens ?? 1400,
        temperature: 0,
      }),
    });
    if (!res.ok) throw new Error(`本地服务 ${res.status}: ${(await res.text()).slice(0, 160)}`);
    const data = await res.json();
    const msg = data?.choices?.[0]?.message ?? {};
    const reasoning = msg.reasoning_content ?? '';
    const content = msg.content ?? '';
    if (reasoning) yield { type: 'reasoning-delta', index: 0, text: reasoning };
    if (content) yield { type: 'text-delta', index: 0, text: content };
    yield { type: 'finish', index: 0, reason: { kind: content ? 'stop' : 'error', raw: data?.choices?.[0]?.finish_reason ?? 'no-content' } };
  },
};

const tools = {};
const ctx = {
  tools: { register: (d) => { tools[d.name] = d; return () => delete tools[d.name]; } },
  get: (name) => {
    if (name === 'llm') return llm;
    if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'local', model: MODEL }) };
    if (name === 'skills') return { register: () => () => {} };
    if (name === 'systemPrompt') return { section: () => () => {}, getSectionOrder: () => 1 };
    return undefined;
  },
};
entry.apply(ctx, { kbDir: KB, cookieFile: `${KB}\\cookie.txt`, distill: true, segmentMinutes: 8, maxLearnMinutes: 0 });

const grand = { pages: 0, cards: 0, distilled: 0, unread: 0, judgedOut: 0, errors: [] };
for (const p of PAGES) {
  const t0 = Date.now();
  try {
    const r = await tools.bili_learn.execute({ url: URL0, page: p }, {});
    const out = r?.text ? JSON.parse(r.text) : r;
    const cov = out?.coverage ?? {};
    const judged = out?.judged ?? {};
    const dropped = (judged?.removed ?? []).length;
    grand.pages += 1;
    grand.cards += out?.cards ?? 0;
    grand.distilled += cov.distilled ?? 0;
    grand.unread += cov.unread ?? 0;
    grand.judgedOut += dropped;
    console.log(`P${p}｜卡 ${out?.cards}｜段 ${cov.distilled}/${cov.segments}（unread ${cov.unread}）｜判掉 ${dropped}｜字幕 ${(cov.lines ?? 0)} 行｜${((Date.now() - t0) / 1000).toFixed(0)}s`);
  } catch (error) {
    grand.errors.push(`P${p}: ${error?.message ?? String(error)}`);
    console.log(`P${p} 失败：${error?.message ?? String(error)}`);
  }
}
console.log('\n=== 汇总 ===');
console.log(JSON.stringify({ ...grand, llmCalls: llm.calls }));
