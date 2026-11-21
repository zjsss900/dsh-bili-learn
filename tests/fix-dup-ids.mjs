// 修历史数据：一页内 id 撞车的卡片改名（两张都保留、内容不动），并同步 review/judgments 的键。
import fs from 'node:fs';
import { KnowledgeBase } from '../dsh-bili-learn/lib/kb.js';

const kb = new KnowledgeBase(process.env.BILI_KB ?? '<你的 bili-kb 目录>');
let pagesFixed = 0;
let renamed = 0;
for (const e of kb.listVideos()) {
  const dir = kb.videoDir(e.bvid, e.page ?? 1);
  const cardsPath = `${dir}\\cards.json`;
  if (!fs.existsSync(cardsPath)) continue;
  const cards = JSON.parse(fs.readFileSync(cardsPath, 'utf8'));
  if (!Array.isArray(cards) || cards.length === 0) continue;
  const seen = new Set();
  const fixes = [];
  const out = cards.map((c) => {
    let id = String(c.id ?? '');
    if (seen.has(id)) {
      let n = 2;
      while (seen.has(`${id}-${n}`)) n += 1;
      fixes.push([id, `${id}-${n}`]);
      id = `${id}-${n}`;
    }
    seen.add(id);
    return { ...c, id };
  });
  if (fixes.length === 0) continue;
  fs.writeFileSync(cardsPath, JSON.stringify(out, null, 2), 'utf8');
  for (const f of ['review.json', 'judgments.json']) {
    const fp = `${dir}\\${f}`;
    if (!fs.existsSync(fp)) continue;
    const j = JSON.parse(fs.readFileSync(fp, 'utf8'));
    for (const [oldId, newId] of fixes) if (j[oldId] !== undefined && j[newId] === undefined) j[newId] = j[oldId];
    fs.writeFileSync(fp, JSON.stringify(j, null, 2), 'utf8');
  }
  pagesFixed += 1;
  renamed += fixes.length;
  console.log(`${e.bvid} P${e.page ?? 1}：改名 ${fixes.length} 张｜${fixes.map((f) => f.join('→')).join(' ')}`);
}
console.log(JSON.stringify({ pagesFixed, renamed }));
if (renamed > 0) {
  const r = kb.rebuildIndex();
  console.log(`重建索引：ok=${r.ok} 页 ${r.pages}｜卡 ${r.cards}｜讲稿行 ${r.lines}｜skipped ${JSON.stringify(r.skipped ?? [])}`);
  console.log(`体检：${JSON.stringify(kb.indexStatus())}`);
}
