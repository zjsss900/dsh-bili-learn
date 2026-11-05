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
      id: `s${Math.round(segment.start)}-${out.length + 1}`,
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

async function callModel({ llm, provider, model, userText, maxTokens, signal }) {
  let text = '';
  let reasoningChars = 0;
  let finish;
  for await (const chunk of llm.stream({
    provider,
    model,
    system: SYSTEM,
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
  for (const segment of segments) {
    const header = `视频：${meta.title}\n本段时间：${formatTime(segment.start)} – ${formatTime(segment.end)}\n要求：最多 ${maxCardsPerSegment} 张卡片。\n\n讲稿：\n${segment.text}\n`;
    let contentAttempts = 0;
    let transportRetries = 0;
    let produced = [];
    let note = '';
    let reasoningChars = 0;
    // 内容失败与传输失败分开计数：网络抖动不该浪费一次「收紧提示」的重试机会。
    while (produced.length === 0 && contentAttempts < 2 && transportRetries < 3) {
      const tight = contentAttempts > 0;
      try {
        const outcome = await callModel({
          llm,
          provider,
          model,
          userText: tight
            ? `${header}\n\n上一次输出不可用（思考 ${reasoningChars} 字）。这次禁止思考，直接以 [ 开头输出最多 3 张卡片。`
            : header,
          maxTokens: tight ? maxTokens * 2 : maxTokens,
          signal,
        });
        contentAttempts += 1;
        reasoningChars = outcome.reasoningChars;
        const parsed = extractJsonArray(outcome.text);
        if (parsed) produced = normalizeCards(parsed, { limit: tight ? 3 : maxCardsPerSegment, segment });
        else if (!outcome.text.trim()) note = `正文为空（思考占 ${reasoningChars} 字${outcome.truncated ? '，且被 maxTokens 截断' : ''}）`;
        else note = outcome.truncated ? `输出被 maxTokens 截断，未能解析（正文 ${outcome.text.length} 字）` : '输出不是可解析的 JSON 数组';
      } catch (error) {
        transportRetries += 1;
        note = `${error?.message ?? String(error)}（传输失败 ${transportRetries}/3）`;
        if (signal?.aborted) break;
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
    if (produced.length === 0) {
      segment.status = 'unread';
      segment.note = note || '模型没有产出卡片';
    } else {
      segment.status = 'distilled';
      segment.note = '';
      cards.push(...produced);
    }
    reports.push({ index: segment.index, status: segment.status, cards: produced.length, note: segment.note });
    onProgress?.({ index: segment.index, status: segment.status, cards: produced.length, note: segment.note });
  }
  return { cards, segmentReports: reports };
}
