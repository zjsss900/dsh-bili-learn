// 文本工具：时间格式、分段、中英混合分词、检索打分、关键词统计。

/** 秒 → mm:ss（超过一小时用 h:mm:ss）。 */
export function formatTime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** 把 [{t,d,text}] 合并成带时间锚点的段：[{start, end, lines, text}]。 */
export function segmentTranscript(lines, { maxMinutes = 8, maxChars = 4200, minMinutes = 2 } = {}) {
  const maxMs = maxMinutes * 60;
  const segments = [];
  let current = null;
  const flush = () => {
    if (!current || current.lines.length === 0) {
      current = null;
      return;
    }
    segments.push({
      index: segments.length,
      start: current.start,
      end: current.end,
      lines: current.lines,
      text: current.lines.map((l) => `[${formatTime(l.t)}] ${l.text}`).join('\n'),
      chars: current.chars,
    });
    current = null;
  };
  for (const line of lines) {
    const t = Number(line.t) || 0;
    if (!current) current = { start: t, end: t, lines: [], chars: 0 };
    const gap = t - current.end;
    const tooLong = t - current.start >= maxMs || current.chars + line.text.length > maxChars;
    if (tooLong && (current.end - current.start >= minMinutes * 60 || gap > 5)) flush();
    if (!current) current = { start: t, end: t, lines: [], chars: 0 };
    current.lines.push(line);
    current.end = Math.max(current.end, t + (Number(line.d) || 0));
    current.chars += line.text.length + 1;
  }
  flush();
  return segments;
}

const STOP = new Set(
  ('的 了 我们 一个 什么 这个 那个 就是 这样 那样 以及 可以 进行 一下 那么 这些 那些 自己 大家 今天 时候 如果 因为 所以 但是 然后 这里 那里 不是 有点 非常 一样 东西 一下 the a an and or of to in for on with is are be this that we you it as at by from will would can could should'.split(' ')),
);

const CJK = /[\u3400-\u9fff\u3040-\u30ff]/;

/** 中英混合分词：英文按词，中文按 2-gram（够用且不需要词典）。 */
export function tokenize(text) {
  const lower = String(text ?? '').toLowerCase();
  const tokens = [];
  const latin = lower.match(/[a-z][a-z0-9_+#.-]{1,}/g) ?? [];
  for (const word of latin) if (!STOP.has(word) && word.length > 1) tokens.push(word);
  const runs = lower.match(/[\u3400-\u9fff\u3040-\u30ff]+/g) ?? [];
  for (const run of runs) {
    if (run.length === 1) {
      tokens.push(run);
      continue;
    }
    for (let i = 0; i + 1 < run.length; i++) tokens.push(run.slice(i, i + 2));
    if (run.length >= 3 && run.length <= 6) tokens.push(run);
  }
  return tokens;
}

/** 关键词统计（用于大纲与检索提示）。 */
export function topTerms(lines, limit = 12) {
  const counts = new Map();
  for (const line of lines) {
    for (const token of tokenize(line.text)) {
      if (token.length < 2) continue;
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([token, n]) => n >= 3 || token.length >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([token, n]) => ({ term: token, count: n }));
}

/** 检索打分：命中字段越核心，权重越高。 */
export function scoreCard(card, queryTokens) {
  const fields = [
    { text: `${card.title} ${card.tags?.join(' ') ?? ''}`, weight: 3 },
    { text: card.claim ?? '', weight: 2 },
    { text: `${card.why ?? ''} ${(card.how ?? []).join(' ')}`, weight: 1 },
  ];
  let score = 0;
  for (const { text, weight } of fields) {
    const bag = new Set(tokenize(text));
    for (const token of queryTokens) if (bag.has(token)) score += weight;
  }
  return score;
}

/** 在讲稿里做关键词检索，返回带时间戳的证据行。 */
export function searchLines(lines, queryTokens, limit = 8) {
  const hits = [];
  for (const line of lines) {
    const bag = new Set(tokenize(line.text));
    let score = 0;
    for (const token of queryTokens) if (bag.has(token)) score += 1;
    if (score > 0) hits.push({ t: line.t, text: line.text, score });
  }
  return hits.sort((a, b) => b.score - a.score || a.t - b.t).slice(0, limit);
}

export function hasCjk(text) {
  return CJK.test(String(text ?? ''));
}

/** 把用户提供的文稿解析成 [{t,d,text}]：支持 JSON、`[mm:ss] 文本`、`mm:ss 文本`、纯文本。 */
export function parseTranscriptText(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return [];
  if (text.startsWith('[') || text.startsWith('{')) {
    try {
      const data = JSON.parse(text);
      const body = Array.isArray(data) ? data : data?.body;
      if (Array.isArray(body)) {
        return body
          .map((line) => ({
            t: Number(line.t ?? line.from ?? line.start ?? 0) || 0,
            d: Number(line.d ?? (Number(line.to ?? 0) - Number(line.from ?? 0))) || 0,
            text: String(line.text ?? line.content ?? '').trim(),
          }))
          .filter((line) => line.text);
      }
    } catch {
      /* 继续按纯文本解析 */
    }
  }
  const out = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = /^\[?(\d{1,2}:)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?\]?\s+(.+)$/.exec(trimmed);
    if (match) {
      const hours = match[1] ? Number(match[1]) : 0;
      out.push({ t: hours * 3600 + Number(match[2]) * 60 + Number(match[3]), d: 0, text: match[5].trim() });
    } else {
      out.push({ t: out.length === 0 ? 0 : out[out.length - 1].t, d: 0, text: trimmed.replace(/^#+\s*/, '') });
    }
  }
  return out.filter((line) => line.text);
}

/** 截断长文本，保留开头。 */
export function clip(text, max = 400) {
  const value = String(text ?? '');
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}
