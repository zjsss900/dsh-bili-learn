// 用假 ctx 直接驱动插件注册的工具，验证参数校验之外的真实行为。
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const entry = await import(new URL('../dsh-bili-learn/index.js', import.meta.url).href);
const tools = {};
const sections = [];
const skills = [];
const ctx = {
  tools: { register: (definition) => { tools[definition.name] = definition; return () => delete tools[definition.name]; } },
  get: (name) => {
    if (name === 'skills') return { register: (skill) => { skills.push(skill); return () => {}; } };
    if (name === 'systemPrompt') return { section: (s) => { sections.push(s); return () => {}; }, getSectionOrder: () => 1 };
    return undefined;
  },
};

const kbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-kb-tool-'));
const cleanup = entry.apply(ctx, { kbDir, cookie: '', distill: false, skillsDir: path.join(kbDir, 'skills') });
const failures = [];
const check = (name, condition, detail = '') => { if (condition !== true) failures.push(`${name}: ${condition}${detail ? ` | ${detail}` : ''}`); };

check('registered 10 tools', Object.keys(tools).length === 10, Object.keys(tools).join(','));
check('all tools have output.render', Object.values(tools).every((t) => typeof t.output?.render === 'function'));
check('all tools have object output schema', Object.values(tools).every((t) => t.output?.schema?.type === 'object'));
check('skill registered', skills.length === 1 && skills[0].name === 'bili-study');
check('prompt section registered', sections.length === 1 && sections[0].name === 'bili-learn:index');
check('bili_series has 5 actions', JSON.stringify(tools.bili_series?.parameters?.properties?.action?.enum) === '["find","list","next","learn","cluster"]', JSON.stringify(tools.bili_series?.parameters?.properties?.action?.enum));
check('bili_skill can take series instead of bvids', !tools.bili_skill?.parameters?.required?.includes('bvids') && Boolean(tools.bili_skill?.parameters?.properties?.series), JSON.stringify(tools.bili_skill?.parameters?.required));
check('bili_recall has series filter', Boolean(tools.bili_recall?.parameters?.properties?.series));
check('bili_learn can batch pages', Boolean(tools.bili_learn?.parameters?.properties?.pages && tools.bili_learn?.parameters?.properties?.all_pages));
check('bili_note / bili_practice take page', Boolean(tools.bili_note?.parameters?.properties?.page && tools.bili_practice?.parameters?.properties?.page && tools.bili_practice?.parameters?.properties?.results?.items?.properties?.page));

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

const noSub = await run('bili_learn', { url: 'BV18qtp6WEdi' });
check('learn without transcript returns lossless', noSub !== undefined && noSub?.coverage?.lines === 0, JSON.stringify(noSub?.coverage ?? noSub));
check('learn without transcript warns honestly', (noSub?.warnings ?? []).some((w) => w.includes('字幕')), JSON.stringify(noSub?.warnings));

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

const skill = await run('bili_skill', { bvids: ['BV1tRxt68EZa', 'BV0NOPE00000'], name: 'Test Skill!!', title: '测试技能', description: '门禁用', whenToUse: '门禁用' });check('bili_skill writes SKILL.md', typeof skill?.file === 'string' && fs.existsSync(skill.file), skill?.file);
const skillText = fs.existsSync(skill?.file ?? '') ? fs.readFileSync(skill.file, 'utf8') : '';
check('skill has frontmatter', skillText.startsWith('---') && skillText.includes('name: test-skill'), skillText.slice(0, 60));
check('skill links evidence with ?t=', skillText.includes('?t='), '');
check('bili_skill reports skipped videos', (skill?.skipped ?? []).includes('BV0NOPE00000'), JSON.stringify(skill?.skipped));
let skillClash = '';
try {
  await tools.bili_skill.execute({ bvids: ['BV1tRxt68EZa'], name: 'test-skill' }, { signal: AbortSignal.timeout(10000) });
} catch (error) {
  skillClash = error.message;
}
check('bili_skill refuses overwrite without force', skillClash.includes('已存在'), skillClash);

const due = await run('bili_practice', { action: 'due' });check('practice due lists k1', due?.due?.some((c) => c.card_id === 'k1'));
const graded = await run('bili_practice', { action: 'grade', bvid: 'BV1tRxt68EZa', results: [{ card_id: 'k1', verdict: 'ok' }] });
check('practice grade mastery 1', graded?.applied?.[0]?.mastery === 1, JSON.stringify(graded?.applied));
const afterGrade = await run('bili_practice', { action: 'due' });
check('k1 no longer due', !afterGrade?.due?.some((c) => c.card_id === 'k1'));

const status2 = await run('bili_status', {});
check('status counts card and 2 videos', status2?.cards === 1 && status2?.videos === 2, JSON.stringify({ c: status2?.cards, v: status2?.videos }));

const sectionText = sections[0].text({});
check('prompt section mentions kb', sectionText.includes('bili_recall') && sectionText.includes('BV1tRxt68EZa'), sectionText.slice(0, 120));
check('prompt section mentions series learning', sectionText.includes('bili_series'), sectionText.slice(-160));
check('skill body mentions bili_series', String(skills[0]?.content ?? '').includes('bili_series'), String(skills[0]?.content ?? '').slice(0, 80));

// 错误路径要给出可读错误，而不是崩栈
for (const [name, args, expect] of [['bili_note', { bvid: 'BV0NOPE00000', cards: [] }, '知识库里没有'], ['bili_practice', { action: 'grade', results: [] }, '需要 bvid'], ['bili_frame', { url: 'BV0NOPE00000', times: [1] }, '-400']]) {
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
