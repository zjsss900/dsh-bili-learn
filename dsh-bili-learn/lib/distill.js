// 知识提取：把分段讲稿喂给宿主已配置的模型，逐段产出结构化卡片。
// 关键约束：本地模型（思考型）长输出会翻车，所以每段只要求短 JSON，
// 并且失败时如实标记「未读懂」，绝不假装成功。
import { formatTime } from './text.js';

const SYSTEM = [
  '/no_think',
  '你是知识提取器。输入是一段带时间戳的视频讲稿。',
  '只输出 JSON 数组，不要解释、不要 Markdown 代码块、不要思考过程。',
  '每个元素形如：',
  '{"title":"简短标题","kind":"concept|procedure|fact|caution|example","claim":"一句话结论","why":"为什么成立/为什么重要","how":["可执行步骤"],"evidence":[{"t":秒数,"quote":"讲稿原文片段"}],"tags":["关键词"],"confidence":"high|medium|low"}',
  '规则：只提取视频里真实讲到的内容；evidence.t 必须来自输入的时间戳；讲稿没讲清楚的就不要编造，confidence 写 low。',
  'claim 不超过 40 字，how 每条不超过 30 字。',
  '不要出这些卡片：广告/赞助/恰饭、求关注点赞投币三连、加群扫码领资料、卖课报名优惠、抽奖、片头自我介绍、片尾致谢、「今天我们来学…」「接下来看」这类过渡话、以及「很强大/非常好用/效果震撼」这种没有具体信息的空话。',
  '整段只有上面这类内容时，直接输出 []（空数组），不要勉强凑卡片。',
].join('\n');

/** 从模型输出里抠出 JSON 数组。 */
export function extractJsonArray(text) {
  const cleaned = String(text ?? '').replace(/```(?:json)?/gi, '');
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start === -1 || end <= start) return undefined;
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function normalizeCards(raw, { limit, segment }) {
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const title = String(item.title ?? '').trim();
    const claim = String(item.claim ?? '').trim();
    if (!title || !claim) continue;
    const evidence = Array.isArray(item.evidence)
      ? item.evidence
          .map((e) => ({ t: Number(e?.t) || 0, quote: String(e?.quote ?? '').slice(0, 300) }))
          .filter((e) => e.quote)
          .slice(0, 6)
      : [];
    out.push({
      // id 用分段起点而不是序号：同一视频重新学习时 id 稳定（覆盖而非堆积），
      // 而把一段切成多块补跑时也不会互相覆盖丢卡片。
      id: `s${Math.round(segment.idAt ?? segment.start)}-${out.length + 1}`,
      kind: ['concept', 'procedure', 'fact', 'caution', 'example'].includes(item.kind) ? item.kind : 'concept',
      title: title.slice(0, 120),
      claim: claim.slice(0, 1200),
      why: String(item.why ?? '').slice(0, 800),
      how: (Array.isArray(item.how) ? item.how : []).map((h) => String(h).slice(0, 400)).slice(0, 10),
      evidence: evidence.length > 0 ? evidence : [{ t: segment.start, quote: String(segment.lines?.[0]?.text ?? '').slice(0, 200) }],
      tags: (Array.isArray(item.tags) ? item.tags : []).map((t) => String(t).slice(0, 40)).slice(0, 8),
      confidence: ['high', 'medium', 'low'].includes(item.confidence) ? item.confidence : 'medium',
      source: 'model',
    });
    if (out.length >= limit) break;
  }
  return out;
}

export async function callModel({ llm, provider, model, userText, maxTokens, system = SYSTEM, signal }) {
  let text = '';
  let reasoningChars = 0;
  let finish;
  for await (const chunk of llm.stream({
    provider,
    model,
    system,
    messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
    maxTokens,
    signal,
  })) {
    if (chunk.type === 'text-delta') text += chunk.text;
    else if (chunk.type === 'reasoning-delta') reasoningChars += chunk.text.length;
    else if (chunk.type === 'finish') finish = chunk.reason;
  }
  if (finish?.kind === 'error') throw new Error(`模型调用失败：${finish.failure?.message ?? '未知错误'}`);
  if (finish?.kind === 'aborted') throw new Error('模型调用被取消');
  return { text, reasoningChars, truncated: finish?.kind === 'max-tokens' };
}

/**
 * 逐段提取卡片。
 * @returns {{ cards: any[], segmentReports: {index,status,cards,note}[] }}
 */
export async function distillSegments({ llm, provider, model, meta, segments, maxCardsPerSegment = 5, maxTokens = 1400, signal, onProgress }) {
  const cards = [];
  const reports = [];
  /**
   * 一段的两轮尝试（第一轮常规，第二轮收紧）。抽出来是为了能对「切半的子段」复用——
   * 实测本地模型在整段讲稿太长时会把 JSON 输出写到被 maxTokens 截断，切两半就不翻车。
   */
  const runAttempts = async (seg, { cap, tokens }) => {
    const head = (maxCards) => `视频：${meta.title}\n本段时间：${formatTime(seg.start)} – ${formatTime(seg.end)}\n要求：最多 ${maxCards} 张卡片。\n\n讲稿：\n${seg.text}\n`;
    let produced = [];
    let explicitEmpty = false;
    let note = '';
    let reasoningChars = 0;
    let contentAttempts = 0;
    let transportRetries = 0;
    // 内容失败与传输失败分开计数：网络抖动不该浪费一次「收紧提示」的重试机会。
    while (produced.length === 0 && !explicitEmpty && contentAttempts < 2 && transportRetries < 3) {
      const tight = contentAttempts > 0;
      try {
        const outcome = await callModel({
          llm,
          provider,
          model,
          userText: tight
            ? `${head(2)}\n上一次输出不可用（思考 ${reasoningChars} 字，可能正文被 maxTokens 截断）。这次禁止思考，直接以 [ 开头输出：最多 2 张卡片，每张 evidence 只留 1 条，quote 不超过 20 字。`
            : head(cap),
          maxTokens: tight ? tokens * 2 : tokens,
          signal,
        });
        contentAttempts += 1;
        reasoningChars = outcome.reasoningChars;
        const parsed = extractJsonArray(outcome.text);
        if (Array.isArray(parsed) && parsed.length === 0) {
          // 空数组是模型明确说这段没有知识点（只有广告/口水/纯展示），不是失败，别重试。
          explicitEmpty = true;
          note = '模型判定本段无知识点（广告/口水/纯展示）';
        } else if (parsed) produced = normalizeCards(parsed, { limit: tight ? 3 : cap, segment: seg });
        else if (!outcome.text.trim()) note = `正文为空（思考占 ${reasoningChars} 字${outcome.truncated ? '，且被 maxTokens 截断' : ''}）`;
        else note = outcome.truncated ? `输出被 maxTokens 截断，未能解析（正文 ${outcome.text.length} 字）` : '输出不是可解析的 JSON 数组';
      } catch (error) {
        transportRetries += 1;
        note = `${error?.message ?? String(error)}（传输失败 ${transportRetries}/3）`;
        if (signal?.aborted) break;
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
    return { produced, explicitEmpty, note };
  };
  const breakNear = (text, at) => {
    const nl = text.lastIndexOf('\n', at);
    return nl > text.length * 0.25 ? nl : Math.floor(at);
  };

  for (const segment of segments) {
    let { produced, explicitEmpty, note } = await runAttempts(segment, { cap: maxCardsPerSegment, tokens: maxTokens });
    let rescued = false;
    if (produced.length === 0 && !explicitEmpty && !signal?.aborted && segment.text.length > 900) {
      // 第三道兜底：整段太长 → 切两半分别提，各要 ≤3 张。两半都要跑（各自有自己的知识点，不能只跑前半）
      const cut = breakNear(segment.text, Math.floor(segment.text.length / 2));
      // 后半段用「时间段中点」做 id 前缀：两半都从 segment.start 起算会撞 id（实测 3 页撞出 18 张重复，
      // 卡片主键冲突 → 整页写不进索引）。idAt 只影响 id，不影响证据时间校验。
      const mid = segment.start + (Number(segment.end ?? segment.start) - Number(segment.start)) / 2;
      const a = await runAttempts({ ...segment, text: segment.text.slice(0, cut) }, { cap: 3, tokens: maxTokens * 2 });
      const b = signal?.aborted ? { produced: [], note: '' } : await runAttempts({ ...segment, idAt: mid, text: segment.text.slice(cut) }, { cap: 3, tokens: maxTokens * 2 });
      produced = [...a.produced, ...b.produced];
      if (produced.length > 0) {
        rescued = true;
        note = `整段输出被截断，已切两半补救（前半 ${a.produced.length} 张 / 后半 ${b.produced.length} 张）`;
      } else note = a.note || b.note || note;
    }
    if (produced.length === 0) {
      segment.status = explicitEmpty ? 'noise' : 'unread';
      segment.note = note || '模型没有产出卡片';
    } else {
      segment.status = 'distilled';
      segment.note = rescued ? note : '';
      cards.push(...produced);
    }
    reports.push({ index: segment.index, status: segment.status, cards: produced.length, note: segment.note });
    onProgress?.({ index: segment.index, status: segment.status, cards: produced.length, note: segment.note });
  }
  return { cards, segmentReports: reports };
}
