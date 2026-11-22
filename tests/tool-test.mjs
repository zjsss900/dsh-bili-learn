// 用假 ctx 直接驱动插件注册的工具，验证参数校验之外的真实行为。
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const entry = await import(new URL('../dsh-bili-learn/index.js', import.meta.url).href);
const tools = {};
const sections = [];
const skills = [];
// 假判定模型：真的读卡片行、按内容回判定（门禁验的是送判/缓存/落账/回滚管线；
// 判定质量靠真机跑真实知识库验收，见 .tools/judge-live.mjs）。
const judgeLlm = {
  calls: 0,
  async *stream({ system, messages }) {
    judgeLlm.calls += 1;
    const user = (messages?.[0]?.content ?? []).map((c) => c.text ?? '').join('');
    const ids = [...user.matchAll(/id=([A-Za-z0-9_-]+)/g)].map((m) => m[1]);
    const out = ids.map((id) => {
      const line = user.split(`id=${id}`)[1]?.split('\n')[0] ?? '';
      return { id, verdict: /一键三连|三连/.test(line) ? 'ad' : 'knowledge', reason: /一键三连|三连/.test(line) ? '求三连' : '' };
    });
    yield { type: 'text-delta', index: 0, text: JSON.stringify(out) };
    yield { type: 'finish', index: 0, reason: { kind: 'stop' } };
  },
};

const ctx = {
  tools: { register: (definition) => { tools[definition.name] = definition; return () => delete tools[definition.name]; } },
  get: (name) => {
    if (name === 'skills') return { register: (skill) => { skills.push(skill); return () => {}; } };
    if (name === 'systemPrompt') return { section: (s) => { sections.push(s); return () => {}; }, getSectionOrder: () => 1 };
    if (name === 'llm') return judgeLlm;
    if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'stub', model: 'judge-stub' }) };
    return undefined;
  },
};

const kbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-kb-tool-'));
const cleanup = entry.apply(ctx, { kbDir, cookie: '', distill: false, skillsDir: path.join(kbDir, 'skills') });
const failures = [];
const check = (name, condition, detail = '') => { if (condition !== true) failures.push(`${name}: ${condition}${detail ? ` | ${detail}` : ''}`); };

check('registered 12 tools', Object.keys(tools).length === 12, Object.keys(tools).join(','));
check('all tools have output.render', Object.values(tools).every((t) => typeof t.output?.render === 'function'));
check('all tools have object output schema', Object.values(tools).every((t) => t.output?.schema?.type === 'object'));
check('skill registered', skills.length === 1 && skills[0].name === 'bili-study');
check('prompt section registered', sections.length === 1 && sections[0].name === 'bili-learn:index');
check('bili_series has 5 actions', JSON.stringify(tools.bili_series?.parameters?.properties?.action?.enum) === '["find","list","next","learn","cluster"]', JSON.stringify(tools.bili_series?.parameters?.properties?.action?.enum));
check('bili_skill can take series instead of bvids', !tools.bili_skill?.parameters?.required?.includes('bvids') && Boolean(tools.bili_skill?.parameters?.properties?.series), JSON.stringify(tools.bili_skill?.parameters?.required));
check('bili_recall has series filter', Boolean(tools.bili_recall?.parameters?.properties?.series));
check('bili_learn can batch pages', Boolean(tools.bili_learn?.parameters?.properties?.pages && tools.bili_learn?.parameters?.properties?.all_pages));
check('bili_note / bili_practice take page', Boolean(tools.bili_note?.parameters?.properties?.page && tools.bili_practice?.parameters?.properties?.page && tools.bili_practice?.parameters?.properties?.results?.items?.properties?.page));
check('bili_filter has 4 actions and kinds', JSON.stringify(tools.bili_filter?.parameters?.properties?.action?.enum) === '["scan","apply","restore","stats"]' && Boolean(tools.bili_filter?.parameters?.properties?.kinds), JSON.stringify(tools.bili_filter?.parameters?.properties?.action?.enum));

const lossless = (value) => {
  const walk = (v, p) => {
    if (v === undefined) return `${p} is undefined`;
    if (typeof v === 'number' && !Number.isFinite(v)) return `${p} is non-finite`;
    if (Array.isArray(v)) return v.map((x, i) => walk(x, `${p}[${i}]`)).find(Boolean) ?? true;
    if (v && typeof v === 'object') return Object.entries(v).map(([k, x]) => walk(x, `${p}.${k}`)).find(Boolean) ?? true;
    if (typeof v === 'function') return `${p} is a function`;
    return true;
  };
  return walk(value, '$');
};

const run = async (name, args) => {
  try {
    const value = await tools[name].execute(args, { signal: AbortSignal.timeout(60000) });
    const ok = lossless(value);
    check(`${name} lossless`, ok, ok === true ? '' : String(ok));
    const rendered = tools[name].output.render(args, value);
    check(`${name} renders text`, Array.isArray(rendered) && rendered[0]?.type === 'text' && rendered[0].text.length > 0);
    return value;
  } catch (error) {
    check(`${name} executes`, `threw ${error.message}`);
    return undefined;
  }
};

const status = await run('bili_status', {});
check('status empty', status?.videos === 0, JSON.stringify(status?.config));
check('status says no cookie', status?.config?.cookie === '未配置', status?.config?.cookie);
fs.writeFileSync(path.join(kbDir, 'cookie.txt'), 'SESSDATA=fake; bili_jct=fake', 'utf8');
const statusCookie = await run('bili_status', {});
check('status reads cookie file without restart', statusCookie?.config?.cookie === '已配置（含 SESSDATA）', statusCookie?.config?.cookie);
fs.rmSync(path.join(kbDir, 'cookie.txt'));

const fixture = fs.readFileSync(new URL('./fixtures/linear-algebra-rank.txt', import.meta.url), 'utf8');
const learned = await run('bili_learn', { url: 'BV1tRxt68EZa', transcript_text: fixture, distill: false });
check('learn wrote 1 segment', learned?.coverage?.segments === 1, JSON.stringify(learned?.coverage));
check('learn marks pending (distill off)', learned?.coverage?.unread === 0 && learned?.cards === 0);

const relearn = await run('bili_learn', { url: 'BV1tRxt68EZa' });
check('relearn keeps existing transcript', relearn?.transcript?.lines === 21, JSON.stringify(relearn?.transcript));
check('relearn warns about kept transcript', (relearn?.warnings ?? []).some((w) => w.includes('保留')));
const forced = await run('bili_learn', { url: 'BV1tRxt68EZa', force: true, transcript_text: fixture, distill: false });
check('force relearns', forced?.skipped !== true && forced?.coverage?.lines === 21, JSON.stringify(forced?.coverage));

// 元数据接口失败时的诚实行为（BVDEMO000006 是不存在的稿件号；真实稿件号是作者的学习记录，不入库）。
// 没给讲稿 → 如实返回失败，不崩、不动知识库；给了讲稿 → 用占位元数据继续，别浪费用户手上的材料。
const dead = await run('bili_learn', { url: 'BVDEMO000006' });
check('learn fails honestly when metadata is unreachable', dead?.ok === false && /元数据|code=-\d+/.test(`${dead?.error ?? ''} ${(dead?.warnings ?? []).join(' ')}`), JSON.stringify(dead));
check('honest failure leaves the knowledge base untouched', !fs.existsSync(path.join(kbDir, 'BVDEMO000006')), kbDir);

const offline = await run('bili_learn', { url: 'BVDEMO000008', transcript_text: '[00:01] 占位讲稿第一句\n[00:09] 占位讲稿第二句，一键三连 出现在这里', distill: false });
check('a provided transcript survives a dead metadata API', (offline?.coverage?.lines ?? 0) >= 1 && (offline?.cards ?? 0) === 0 && (offline?.warnings ?? []).some((w) => w.includes('占位元数据')), JSON.stringify({ cov: offline?.coverage, cards: offline?.cards, w: offline?.warnings }));

await run('bili_note', { bvid: 'BV1tRxt68EZa', cards: [{ id: 'k1', title: '秩', claim: '秩=主元个数', evidence: [{ t: 14, quote: '矩阵的秩，就是它化简以后主元的个数' }] }] });
const replaced = await run('bili_note', { bvid: 'BV1tRxt68EZa', replace: true, cards: [{ id: 'k2', title: '替换', claim: 'replace 会删掉旧卡', evidence: [{ t: 14, quote: '矩阵的秩' }] }] });
check('bili_note replace drops old cards', replaced?.cards === 1, JSON.stringify({ cards: replaced?.cards }));
await run('bili_note', { bvid: 'BV1tRxt68EZa', replace: true, cards: [{ id: 'k1', title: '秩', claim: '秩=主元个数', evidence: [{ t: 14, quote: '矩阵的秩，就是它化简以后主元的个数' }] }] });
const recall = await run('bili_recall', { query: '秩 主元' });
check('recall finds card', recall?.cards?.length >= 1, JSON.stringify(recall?.cards?.[0]?.title));
check('recall gives jump link', String(recall?.cards?.[0]?.evidence?.[0]?.jump ?? '').includes('?t=14'));
const recallMiss = await run('bili_recall', { query: '完全不存在的关键词量子纠缠' });
check('recall miss has note', typeof recallMiss?.note === 'string' && recallMiss.note.length > 0);

const frames = await run('bili_frame', { url: 'BV1tRxt68EZa', times: [1] });
check('bili_frame grabs a frame', frames?.ok === true && (frames?.frames?.[0]?.file ?? '') !== '' && fs.existsSync(frames.frames[0].file), JSON.stringify(frames?.frames));

const skill = await run('bili_skill', { bvids: ['BV1tRxt68EZa', 'BVDEMO000007'], name: 'Test Skill!!', title: '测试技能', description: '门禁用', whenToUse: '门禁用' });check('bili_skill writes SKILL.md', typeof skill?.file === 'string' && fs.existsSync(skill.file), skill?.file);
const skillText = fs.existsSync(skill?.file ?? '') ? fs.readFileSync(skill.file, 'utf8') : '';
check('skill has frontmatter', skillText.startsWith('---') && skillText.includes('name: test-skill'), skillText.slice(0, 60));
check('skill links evidence with ?t=', skillText.includes('?t='), '');
check('bili_skill reports skipped videos', (skill?.skipped ?? []).includes('BVDEMO000007'), JSON.stringify(skill?.skipped));
let skillClash = '';
try {
  await tools.bili_skill.execute({ bvids: ['BV1tRxt68EZa'], name: 'test-skill' }, { signal: AbortSignal.timeout(10000) });
} catch (error) {
  skillClash = error.message;
}
check('bili_skill refuses overwrite without force', skillClash.includes('已存在'), skillClash);

// 卡片质检：判定由模型给。这里用假判定模型验管线（送判→缓存→落账→回滚→钉住）。
const adNote = await run('bili_note', { bvid: 'BV1tRxt68EZa', cards: [{ id: 'ad1', title: '求支持', claim: '觉得有用请一键三连', evidence: [{ t: 3, quote: '觉得有用一键三连' }, { t: 9, quote: '感谢观看，我们下期见' }] }] });
check('bili_note stores cards as-is (judging is a separate model pass)', adNote?.cards === 2, JSON.stringify({ cards: adNote?.cards }));
const fScan = await run('bili_filter', { action: 'scan', bvid: 'BV1tRxt68EZa' });
check('bili_filter scan asks the model and previews without touching cards', fScan?.toRemove === 1 && fScan?.samples?.[0]?.reason === '求三连' && (fScan?.modelCalls ?? 0) >= 1, JSON.stringify({ toRemove: fScan?.toRemove, s: fScan?.samples?.[0], calls: fScan?.modelCalls }));
const fScan2 = await run('bili_filter', { action: 'scan', bvid: 'BV1tRxt68EZa' });
check('bili_filter reuses cached verdicts (no extra model calls)', (fScan2?.modelCalls ?? 99) === 0 && (fScan2?.fromCache ?? 0) >= 2, JSON.stringify({ calls: fScan2?.modelCalls, fromCache: fScan2?.fromCache }));
const fApply = await run('bili_filter', { action: 'apply', bvid: 'BV1tRxt68EZa' });
check('bili_filter apply drops only what the model called ad', fApply?.removed === 1, JSON.stringify({ removed: fApply?.removed }));
const fStats = await run('bili_filter', { action: 'stats' });
check('bili_filter stats counts the model-dropped card', (fStats?.dropped ?? 0) === 1 && Object.keys(fStats?.byVerdict ?? {}).includes('ad'), JSON.stringify(fStats?.byVerdict));
const fRestore = await run('bili_filter', { action: 'restore', bvid: 'BV1tRxt68EZa', card_ids: ['ad1'] });
check('bili_filter restore puts the card back', fRestore?.results?.[0]?.restored === 1, JSON.stringify(fRestore?.results));
const fScan3 = await run('bili_filter', { action: 'scan', bvid: 'BV1tRxt68EZa' });
check('restored card is pinned, not offered again', fScan3?.toRemove === 0, JSON.stringify({ toRemove: fScan3?.toRemove }));

const due = await run('bili_practice', { action: 'due' });check('practice due lists k1', due?.due?.some((c) => c.card_id === 'k1'));
const graded = await run('bili_practice', { action: 'grade', bvid: 'BV1tRxt68EZa', results: [{ card_id: 'k1', verdict: 'ok' }] });
check('practice grade mastery 1', graded?.applied?.[0]?.mastery === 1, JSON.stringify(graded?.applied));
const afterGrade = await run('bili_practice', { action: 'due' });
check('k1 no longer due', !afterGrade?.due?.some((c) => c.card_id === 'k1'));

const status2 = await run('bili_status', {});
check('status counts 2 cards (ad restored) and 2 videos', status2?.cards === 2 && status2?.videos === 2, JSON.stringify({ c: status2?.cards, v: status2?.videos }));

const sectionText = sections[0].text({});
check('prompt section mentions kb', sectionText.includes('bili_recall') && sectionText.includes('BV1tRxt68EZa'), sectionText.slice(0, 120));
check('prompt section mentions series learning', sectionText.includes('bili_series'), sectionText.slice(-160));
check('skill body mentions bili_series', String(skills[0]?.content ?? '').includes('bili_series'), String(skills[0]?.content ?? '').slice(0, 80));

// SQLite 索引层：建、体检、双跑比对（SQL 不能比 JSON 少查到东西）
check('bili_index takes action and queries', Boolean(tools.bili_index?.parameters?.properties?.action && tools.bili_index?.parameters?.properties?.queries));
const ixBuild = await run('bili_index', { action: 'rebuild' });
check('bili_index rebuild indexes every page', ixBuild?.ok === true && ixBuild?.pages >= 2 && (ixBuild?.skipped ?? []).length === 0, JSON.stringify({ ok: ixBuild?.ok, pages: ixBuild?.pages, cards: ixBuild?.cards, skipped: ixBuild?.skipped }));
const ixStatus = await run('bili_index', { action: 'status' });
check('bili_index status: index matches json', ixStatus?.consistent === true, JSON.stringify({ json: ixStatus?.json, sql: ixStatus?.sql, dangling: ixStatus?.dangling }));
const ixVerify = await run('bili_index', { action: 'verify', queries: ['秩', '主元', '一键三连'] });
check('bili_index verify: sql misses nothing json found', ixVerify?.ok === true && ixVerify?.missingInSql === 0 && ixVerify?.queries === 3, JSON.stringify({ ok: ixVerify?.ok, missing: ixVerify?.missingInSql, n: ixVerify?.queries, per: ixVerify?.perQuery }));
check('bili_index verify: recall actually runs on sql engine', ixVerify?.engineNow === 'sql', String(ixVerify?.engineNow));
const sqlRecall = await run('bili_recall', { query: '秩 主元', engine: 'sql' });
check('bili_recall engine=sql returns cards with backlinks', (sqlRecall?.cards ?? []).length >= 1 && sqlRecall.cards[0].evidence?.[0]?.t !== undefined, JSON.stringify(sqlRecall?.cards?.[0] ?? null));
check('bili_recall engine=json still answers (fallback path)', (await run('bili_recall', { query: '秩 主元', engine: 'json' }))?.cards?.length >= 1);

// 错误路径要给出可读错误，而不是崩栈
for (const [name, args, expect] of [['bili_note', { bvid: 'BVDEMO000007', cards: [] }, '知识库里没有'], ['bili_practice', { action: 'grade', results: [] }, '需要 bvid'], ['bili_frame', { url: 'BVDEMO000007', times: [1] }, '-400']]) {
  let message = '';
  try {
    await tools[name].execute(args, { signal: AbortSignal.timeout(10000) });
  } catch (error) {
    message = error.message;
  }
  check(`${name} error path`, message.includes(expect), message);
}

const toolCount = Object.keys(tools).length;
cleanup?.();
console.log(failures.length === 0 ? `PASS tools: ${toolCount} tools, all outputs lossless` : `FAIL ${failures.length}\n- ${failures.join('\n- ')}`);
process.exit(failures.length === 0 ? 0 : 1);
