// 仓库卫生门禁：这个代码库里只允许有代码 + 一份明确标注为合成的样例。
// 学到的知识卡、生成的技能、查询索引、向量库——一律不许进仓库。在 CI 里跑，防止再犯。
// 不在 git 仓库里（比如插件开发工作区）就跳过，不误伤。
import { execSync } from 'node:child_process';
import fs from 'node:fs';

let files;
try {
  files = execSync('git ls-files -z', { encoding: 'utf8' }).split('\0').filter(Boolean);
} catch {
  console.log('SKIP repo-hygiene：当前目录不是 git 仓库（开发工作区正常）');
  process.exit(0);
}

const exempt = (p) => p.startsWith('examples/bili-kb/') || p.startsWith('tests/fixtures/');
// 每条规则自带豁免判定，别把豁免条件混在规则源字符串里绕
const rules = [
  [/^skills\//, '学到的技能（属于学习者，不入库）', () => false],
  [/bili-kb[/\\]/, '真实学习知识库（examples/ 下的合成样例除外）', exempt],
  [/\.sqlite$/, '查询索引：派生缓存，含卡片镜像，属于本机数据', () => false],
  [/\.jsonl$/, '向量 / 待嵌中间产物', () => false],
  [/vec0\.(dll|so|dylib)$/, 'sqlite-vec 扩展二进制', () => false],
  [/vecpkg|sqlite-vec/, '扩展解包目录', () => false],
  [/cards\.(json|md)$/, '知识卡文件（examples/ 下的合成样例除外）', exempt],
  [/(card_vec|vec-out|vec-pending)/, '向量表或向量中间文件', () => false],
];
const fails = [];
for (const f of files) {
  for (const [re, why, skip] of rules) {
    if (re.test(f) && !skip(f)) fails.push(`${f} ← ${why}`);
  }
}
// 体积哨兵（粗）：知识库/向量转储一定是大文件；代码库单文件不该超过 128 KB
for (const f of files) {
  try {
    const n = fs.statSync(f).size;
    if (n > 128 * 1024) fails.push(`${f} 有 ${(n / 1024).toFixed(0)} KB，超出代码库单文件上限 128 KB（像是数据转储）`);
  } catch { /* 没跟踪的文件不算 */ }
}
// 内容哨兵：JSON 里同时出现 "claim" 与 "evidence" 这两个键 = 知识卡数据文件（合成样例之外禁止）
for (const f of files.filter((p) => p.endsWith('.json') && !exempt(p))) {
  try {
    const t = fs.readFileSync(f, 'utf8');
    if (/"claim"\s*:/.test(t) && /"evidence"\s*:/.test(t)) fails.push(`${f} 里是知识卡数据（"claim" + "evidence" 键）`);
  } catch { /* 读不到就算了 */ }
}

// BV 号哨兵：仓库不该记录「谁学过哪些视频」。只允许最初版合成样例、BVDEMO 占位符、文档里的 x 占位符。
const ALLOWED_BV = new Set(['BV1tRxt68EZa']);
const fakeBv = (id) => /^BVDEMO\d{6}$/.test(id) || /x{6}/i.test(id);
const seenBv = new Set();
for (const f of files.filter((p) => /\.(js|mjs|py|md|json|yml|txt)$/.test(p))) {
  try {
    const t = fs.readFileSync(f, 'utf8');
    for (const m of t.matchAll(/\bBV[0-9A-Za-z]{10}\b/g)) {
      if (ALLOWED_BV.has(m[0]) || fakeBv(m[0]) || seenBv.has(`${f}|${m[0]}`)) continue;
      seenBv.add(`${f}|${m[0]}`);
      fails.push(`${f} 里有真实 BV 号 ${m[0]}——学过哪些视频属于使用者，换成 BVDEMO000020`);
    }
  } catch { /* 读不到就算了 */ }
}

console.log(`repo-hygiene：扫了 ${files.length} 个被跟踪文件`);
if (fails.length) {
  console.log(`FAIL repo-hygiene（${fails.length} 条）：`);
  for (const f of fails) console.log(`- ${f}`);
  process.exit(1);
}
console.log('PASS repo-hygiene：没有向量库、没有索引、没有真实学习数据');
