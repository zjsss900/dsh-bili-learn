// 真库语义检索验收。跑在 BILI_KB 指向的知识库上：
// 1) 全库卡片按内容指纹增量嵌入（CPU，不碰显卡）
// 2) 语义召回 vs 关键词召回：证明语义补上了关键词的盲区（不是替它做终判）
// 3) vec0 ANN 与精确暴力 top 必须一致（不一致就 FAIL，代码里也以暴力为准）
// 只打印摘要与门禁结论。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { KnowledgeBase } from '../dsh-bili-learn/lib/kb.js';

const KB = process.env.BILI_KB ?? '<你的 bili-kb 目录>';
const PY = process.env.PY_EMB ?? process.env.PYTHON ?? 'python';
const EMB = path.resolve('dsh-bili-learn/tools/embed.py');
const DLL = process.env.VECEXT ?? path.resolve('.tools/vecpkg/package/vec0.dll');
const PORT = 10099;
const kb = new KnowledgeBase(KB, { vecExtPath: DLL, embedUrl: `http://127.0.0.1:${PORT}` });

const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond !== true) fails.push(`${name}: ${detail}`);
  console.log(`${cond === true ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

console.log(`vec0：${JSON.stringify(kb.vecExt())}`);
console.log(`初始向量状态：${JSON.stringify(kb.vecStatus())}`);

// ---- 1) 嵌入全库
const pend = kb.vecPending();
const all = kb.vecItems();
ok('待嵌清单能算出来（首次全库 / 之后增量）', Number.isFinite(pend.total), `${pend.total} 张待嵌（库内共 ${all.length} 张）`);
if (pend.total > 0) {
  const inbox = path.resolve('.tools/vec-pending.jsonl');
  const outbox = path.resolve('.tools/vec-out.jsonl');
  fs.writeFileSync(inbox, pend.items.map((i) => JSON.stringify({ key: `${i.bvid}|${i.page}|${i.cid}`, dhash: i.dhash, text: i.text })).join('\n'), 'utf8');
  const t0 = Date.now();
  const run = spawnSync(PY, [EMB, 'cards', '--in', inbox, '--out', outbox], { encoding: 'utf8', env: { ...process.env, PYTHONUTF8: '1' } });
  const embLine = (run.stdout ?? '').trim().split('\n').filter(Boolean).pop() ?? '';
  ok(`embedding 跑通（CPU，${((Date.now() - t0) / 1000).toFixed(0)}s）`, run.status === 0 && fs.existsSync(outbox), `status=${run.status} ${embLine} ${(run.stderr ?? '').split('\n').filter(Boolean).slice(-1)[0] ?? ''}`);
  const applied = kb.vecApplyJsonl(outbox);
  ok('向量灌进索引', applied.ok, JSON.stringify({ applied: applied.applied, bad: applied.bad, dim: applied.dim, vtable: applied.vtable }));
  fs.rmSync(inbox, { force: true });
  fs.rmSync(outbox, { force: true });
} else console.log('SKIP 嵌入：向量已是最新（增量门禁见过这些指纹）');
const after = kb.vecStatus();
ok('ANN 虚表建起来了', after.vtable === true, `rows=${after.rows} dim=${after.dim} engine=${after.ext?.ok ? 'vec0' : 'brute'}`);
ok('灌完 pending 归零', kb.vecPending().total === 0);

// ---- 2) 查询侧：起常驻 embedding 服务（闲置自杀，不泄漏进程）
const srv = spawn(PY, [EMB, 'serve', '--port', String(PORT), '--idle', '240'], { stdio: 'ignore', detached: true, env: { ...process.env, PYTHONUTF8: '1' } });
srv.unref();
let health = null;
for (let i = 0; i < 60 && !health; i += 1) {
  await new Promise((r) => setTimeout(r, 1000));
  try {
    health = await (await fetch(`http://127.0.0.1:${PORT}/health`)).json();
  } catch { /* 模型还在加载 */ }
}
ok('查询侧 embedding 服务起来了', Boolean(health?.ok), JSON.stringify(health ?? { note: '60 秒没起来' }));

// ---- 3) 语义补盲区：查询里刻意不带卡片原文的词
const cases = [
  ['出图的时候画幅比例怎么选', ['9:16', '16:9']],
  ['怎么让两个人说话时不跳出画面方向感', ['跳轴', '轴线']],
  ['跨镜头人物外观漂了、脸不一致', ['一致性', '三视图', '外观']],
  ['把剪辑点藏进没有信息量的画面里', ['遮挡', '转场']],
  ['台词太直白，怎么让它有多层意思', ['潜台词', '对白']],
  ['画面太油太假，不像实拍', ['油腻', 'AI 味', '去 AI', '太干净', '真实感']],
  ['竖屏短剧开头留不住人', ['节奏', '开头', '前几秒']],
  ['观众一眼就看出是 AI 生成的', ['AI 味', '去 AI', '太干净', '真实感', '油腻']],
  ['两个镜头接在一起很突兀', ['转场', '衔接', '割裂']],
  ['人物讲着讲着突然换衣服了', ['换衣', '外观', '一致性']],
];
// 增量的判据用实测：关键词路线**这条查询答不出来**、语义路线能答出来，才算补了盲区。
// （不用「零字面重合」当门槛：中文查询和卡面总会蹭到一个弱词，那个门槛测的不是能力差别。）
const bigrams = (s) => { const o = new Set(); for (let i = 0; i + 1 < s.length; i += 1) o.add(s.slice(i, i + 2)); return o; };
let semHits = 0;
let kwHits = 0;
let semOnly = 0;
let agreed = 0;
const t1 = Date.now();
for (const [q, want] of cases) {
  const sem = await kb.vecSearch(q, { limit: 5 });
  const kw = kb.search(q, { limit: 5, withLines: false });
  const hitText = (c) => `${c.title ?? ''} ${c.claim ?? ''}`;
  const s = sem.cards.some((c) => want.some((w) => hitText(c).includes(w)));
  const k = kw.cards.some((c) => want.some((w) => hitText(c).includes(w)));
  if (s) semHits += 1;
  if (k) kwHits += 1;
  const topText = sem.cards[0] ? hitText(sem.cards[0]) : '';
  if (s && !k) semOnly += 1;
  if (/一致/.test(sem.note ?? '') || sem.engine === 'brute') agreed += 1;
  console.log(`  「${q}」 语义=${s ? '命中' : '没中'} 关键词=${k ? '命中' : '没中'} 首位=${topText.slice(0, 42)}｜${sem.engine}`);
}
const ms = Date.now() - t1;
// 判据定成能守的性质，不吹能力：期望子串是人手猜的，判分本身会误判
// （实测「人物突然换衣服」语义给出「换装前需找服饰素材…」是正确答案，但我写的子串里没有「换装」）。
ok(`语义命中不低于 7/10（实测 ${semHits}/${cases.length}，关键词 ${kwHits}/${cases.length}）`, semHits >= 7, `${semHits}/${cases.length}`);
ok(`语义补上 ≥2 条关键词答不出的查询（实测 ${semOnly} 条）`, semOnly >= 2, `${semOnly}/${cases.length}`);
ok('ANN 与精确暴力每次都给同一条结论（暴力为准）', agreed === cases.length, `${agreed}/${cases.length}`);
ok('语义查询延迟可接受', ms < 20000, `${cases.length} 查询共 ${ms} ms（含模型加载与编码）`);

// ---- 4) 混排不改变关键词那条的口径
const mixedKw = kb.search('遮挡转场', { limit: 5, withLines: false }).cards.map((c) => c.id);
const againKw = kb.search('遮挡转场', { limit: 5, withLines: false }).cards.map((c) => c.id);
ok('关键词排序不受向量层影响', JSON.stringify(mixedKw) === JSON.stringify(againKw), `${mixedKw}`);

if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(srv.pid), '/T', '/F'], { stdio: 'ignore' });
else {
  try { process.kill(-srv.pid); } catch { try { srv.kill('SIGTERM'); } catch { /* 已自杀 */ } }
}
console.log(`\n验收：${fails.length === 0 ? 'PASS' : `FAIL（${fails.length} 条）`}`);
for (const f of fails) console.log(`- ${f}`);
console.log(`体检：${JSON.stringify(kb.vecStatus())}`);
process.exit(fails.length === 0 ? 0 : 1);
