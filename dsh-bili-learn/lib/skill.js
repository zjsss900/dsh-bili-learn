// 把已学会的知识卡片组装成 DSH 技能（SKILL.md）。
// 插件只做「可靠拼装 + 落盘」，措辞由会话模型精修——所以这里不调模型，
// 避免本地思考型模型在长输出上翻车，也保证每条都带得回原视频的证据链接。
import fs from 'node:fs';
import path from 'node:path';

const KIND_LABEL = { concept: '概念', procedure: '做法', fact: '事实', caution: '注意', example: '示例' };

export function slugify(text) {
  const slug = String(text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  if (!slug) throw new Error('技能名要能转成目录名（用英文或拼音更稳）');
  return slug;
}

const link = (bvid, t) => `https://www.bilibili.com/video/${bvid}?t=${Math.floor(Number(t) || 0)}`;

/** 生成 SKILL.md 文本。 */
export function buildSkill({ name, title, description, whenToUse, sources, cards, extra = '' }) {
  const lines = [
    '---',
    `name: ${name}`,
    `description: ${String(description ?? title).replace(/\s+/g, ' ').trim()}`,
    `whenToUse: ${String(whenToUse ?? description ?? title).replace(/\s+/g, ' ').trim()}`,
    '---',
    '',
    `# ${title}`,
    '',
    '本技能由 B 站视频学习闭环自动生成，**每条规则后面都给了回跳原视频的链接**；核对或深入时点开。',
    '来源：',
    ...sources.map((s) => `- [${s.title}](${s.url})｜UP ${s.owner}｜时长 ${Math.round((s.duration ?? 0) / 60)} 分钟`),
    '',
  ];
  if (extra.trim()) lines.push(extra.trim(), '');
  const byKind = new Map();
  for (const card of cards) {
    if (!byKind.has(card.kind)) byKind.set(card.kind, []);
    byKind.get(card.kind).push(card);
  }
  for (const kind of ['procedure', 'caution', 'concept', 'fact', 'example']) {
    const group = byKind.get(kind);
    if (!group?.length) continue;
    lines.push(`## ${KIND_LABEL[kind] ?? kind}`, '');
    for (const card of group) {
      lines.push(`### ${card.title}`, '', `- 结论：${card.claim}`);
      if (card.why) lines.push(`- 为什么：${card.why}`);
      for (const step of card.how ?? []) lines.push(`- 怎么做：${step}`);
      const evidence = (card.evidence ?? []).slice(0, 4);
      if (evidence.length) lines.push(`- 依据：${evidence.map((e) => `[${Math.floor(e.t)}s] ${link(card._bvid, e.t)}`).join(' ')}`);
      lines.push('');
    }
  }
  lines.push('---', '', `生成时间：${new Date().toISOString()}｜卡片数 ${cards.length}｜由 dsh-bili-learn 拼装，措辞请人工/模型复核。`, '');
  return lines.join('\n');
}

/** 写入技能目录；已存在时除非 force 否则不覆盖。 */
export function writeSkill({ skillsDir, name, content, force = false }) {
  const dir = path.join(skillsDir, name);
  const file = path.join(dir, 'SKILL.md');
  if (fs.existsSync(file) && !force) throw new Error(`${file} 已存在；确认要覆盖就传 force=true`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
  return { file, dir };
}
