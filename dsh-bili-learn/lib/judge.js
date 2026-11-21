// 卡片质检：判定完全交给模型做——插件不用正则去猜「这是不是广告」。
// 程序只负责三件事：把卡片成批送判、把结果记账（可回滚）、把用户明确要留的卡片钉住。
// 诚实约束：模型判不了（空正文/漏 id）就留原卡片并记为 unjudged，绝不替它编判定。
import { callModel, extractJsonArray } from './distill.js';
import { clip } from './text.js';

const VERDICTS = new Set(['knowledge', 'ad', 'filler']);

const JUDGE_SYSTEM = [
  '/no_think',
  '你是知识卡片质检员。输入是一批从视频讲稿里提取的知识卡片（含证据原文）。',
  '只输出 JSON 数组，每个元素形如 {"id":"卡片id","verdict":"knowledge|ad|filler","reason":"不超过12字的理由"}。',
  '不要解释、不要 Markdown 代码块、不要输出思考过程。',
  'ad：广告/赞助/恰饭、求关注点赞投币三连、加群扫码领资料、卖课报名优惠券、抽奖、片头自我介绍、片尾致谢等运营内容。',
  'filler：没有任何具体信息的过渡话或空泛评价，例如「今天我们来学…」「这个功能很强大」「效果震撼」「接下来看」。',
  '除 ad 与 filler 以外一律 knowledge。拿不准就写 knowledge——宁可留下，绝不误删知识。',
  '只做判定，不要改写或新增卡片；id 必须与输入完全一致。',
].join('\n');

/** 卡片摘要行：把判定需要的信息都给模型，但控制长度（本地模型上下文也省钱）。 */
function cardLine(card) {
  const ev = (card.evidence ?? []).slice(0, 3).map((e) => `${Math.floor(e.t ?? 0)}s:${clip(e.quote, 90)}`).join(' ／ ');
  const how = (card.how ?? []).slice(0, 3).map((h) => clip(h, 40)).join('；') || '—';
  return `id=${card.id}｜标题=${clip(card.title, 40)}｜结论=${clip(card.claim, 120)}｜怎么做=${how}｜证据原文=${ev || '—'}`;
}

/** 缓存指纹：卡片内容变了就重判（只是记账用的键，不参与判定）。 */
export function digest(card) {
  return `${card.title}|${card.claim}|${card.why ?? ''}|${(card.how ?? []).join('|')}|${(card.evidence ?? []).map((e) => `${e.t}:${clip(e.quote, 60)}`).join('|')}`;
}

export function chunk(list, size = 12) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * 成批送模型判定。
 * @param cache 上一次判定结果（{ id: { verdict, reason, digest } }），命中且指纹相同就跳过
 * @param pinned 用户明确要留的 id，直接跳过判定（不浪费调用）
 * @returns {{ verdicts: object, unjudged: string[], calls: number, fromCache: number }}
 */
export async function judgeCards({ llm, provider, model, cards, batchSize = 12, maxTokens = 1600, cache = {}, pinned = [], signal, onProgress }) {
  const verdicts = {};
  const unjudged = [];
  let calls = 0;
  let fromCache = 0;
  const pin = new Set(pinned);
  const todo = [];
  for (const card of cards ?? []) {
    if (pin.has(card.id)) {
      verdicts[card.id] = { verdict: 'knowledge', reason: '用户钉住', by: 'pin' };
      continue;
    }
    const hit = cache[card.id];
    if (hit && VERDICTS.has(hit.verdict) && hit.digest === digest(card)) {
      verdicts[card.id] = { ...hit, by: 'cache' };
      fromCache += 1;
      continue;
    }
    todo.push(card);
  }

  for (const batch of chunk(todo, Math.max(1, batchSize))) {
    if (signal?.aborted) {
      unjudged.push(...batch.map((c) => c.id));
      continue;
    }
    const list = batch.map(cardLine).join('\n');
    let parsed;
    let lastNote = '';
    for (let attempt = 0; attempt < 2 && !parsed; attempt += 1) {
      try {
        const outcome = await callModel({
          llm,
          provider,
          model,
          system: JUDGE_SYSTEM,
          userText: attempt === 0
            ? `请给下面 ${batch.length} 张卡片判定，输出 ${batch.length} 个元素，id 与输入完全一致：\n${list}`
            : `上一次输出不可用。这次禁止思考，直接以 [ 开头输出 ${batch.length} 个元素：\n${list}`,
          maxTokens: attempt === 0 ? maxTokens : maxTokens * 2,
          signal,
        });
        calls += 1;
        const arr = extractJsonArray(outcome.text);
        if (Array.isArray(arr) && arr.length) parsed = arr;
        else if (!outcome.text.trim()) lastNote = `正文为空（思考占 ${outcome.reasoningChars} 字）`;
        else lastNote = outcome.truncated ? '输出被 maxTokens 截断' : '输出不是可解析的 JSON 数组';
      } catch (error) {
        lastNote = error?.message ?? String(error);
        if (signal?.aborted) break;
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
    if (!parsed) {
      unjudged.push(...batch.map((c) => c.id));
      onProgress?.({ batch: batch.length, status: 'unjudged', note: lastNote, ids: batch.map((c) => c.id) });
      continue;
    }
    const byId = new Map(parsed.map((x) => [String(x?.id ?? ''), x]));
    for (const card of batch) {
      const hit = byId.get(card.id);
      const raw = String(hit?.verdict ?? '').trim();
      if (!VERDICTS.has(raw)) {
        // 模型没给这个 id 或给了个没见过的值：保守留 knowledge，并记进 unjudged。
        verdicts[card.id] = { verdict: 'knowledge', reason: `模型未明确判定（${raw || '无返回'}）`, digest: digest(card), uncertain: true };
        unjudged.push(card.id);
        continue;
      }
      verdicts[card.id] = { verdict: raw, reason: clip(String(hit?.reason ?? ''), 60), digest: digest(card) };
    }
    const tally = batch.map((c) => verdicts[c.id]?.verdict);
    onProgress?.({
      batch: batch.length,
      status: 'judged',
      ad: tally.filter((v) => v === 'ad').length,
      filler: tally.filter((v) => v === 'filler').length,
      note: lastNote,
    });
  }
  return { verdicts, unjudged, calls, fromCache, judged: Object.keys(verdicts).length };
}

/**
 * 按模型判定落账：ad/filler 移到 dropped（带模型的 verdict 与 reason），其余保留。
 * 判不了、或模型自己标了 uncertain 的，一律留下——没有判定就不删。
 */
export function applyVerdicts(cards, verdicts, { drop = ['ad', 'filler'], pinned = [] } = {}) {
  const pin = new Set(pinned);
  const kept = [];
  const dropped = [];
  const uncertain = [];
  for (const card of cards ?? []) {
    const v = verdicts[card.id];
    if (pin.has(card.id)) {
      kept.push({ ...card, _pinned: true });
      continue;
    }
    if (!v || v.uncertain) {
      uncertain.push(card.id);
      kept.push(card);
      continue;
    }
    if (drop.includes(v.verdict)) dropped.push({ ...card, _verdict: v.verdict, _reasons: v.reason ? [v.reason] : [], _by: 'model' });
    else kept.push(card);
  }
  const count = (verdict) => dropped.filter((c) => c._verdict === verdict).length;
  return {
    kept,
    dropped,
    uncertain,
    stats: { total: (cards ?? []).length, kept: kept.length, ad: count('ad'), filler: count('filler'), uncertain: uncertain.length },
  };
}
