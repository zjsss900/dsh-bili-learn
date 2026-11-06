// 「同一 UP 主的同一系列教程」：合集（season）与系列（series）接口，外加无合集时的标题前缀聚类兜底。
//
// 实测（2026-11）：
//   - `view` 返回的 `ugc_season.sections[].archives` 是 undefined —— B 站不再在 view 里带稿件列表，
//     所以合集内容必须走 `seasons_archives_list`（实测 code=0、page.total=22、字段齐）。
//   - `seasons_series_list` 能列出一个 UP 主的「合集」与「系列」两类。
//   - 合集里稿件的顺序就是页面上展示的顺序（教程通常按发布顺序），所以保留接口顺序，不自行按 pubdate 重排。
import { BiliClient } from './bili.js';

export function seasonKey(kind, id) {
  return `${kind}:${id}`;
}

/** 合集名常带「合集·」前缀，去掉它更好读，但保留原文在 raw_title。 */
function cleanTitle(text) {
  const raw = String(text ?? '').trim();
  return { title: raw.replace(/^(合集·|合集丨|系列·)/, '') || raw, raw_title: raw };
}

function mapEpisode(archive, index) {
  return {
    index,
    bvid: archive.bvid,
    aid: archive.aid ?? 0,
    title: String(archive.title ?? ''),
    duration: Number(archive.duration) || 0,
    pubdate: Number(archive.pubdate) || 0,
    pic: archive.pic ?? '',
    url: `https://www.bilibili.com/video/${archive.bvid}`,
  };
}

/** 给一个稿件，找出它所属的合集（season）。没有合集返回 null。 */
export async function seasonOfVideo(bili, bvid, { signal } = {}) {
  const data = await bili.fetchJson(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, { signal });
  const season = data?.ugc_season;
  if (!season?.id) return null;
  const { title, raw_title } = cleanTitle(season.title);
  return {
    key: seasonKey('season', season.id),
    kind: 'season',
    season_id: season.id,
    title,
    raw_title,
    mid: Number(season.mid ?? data?.owner?.mid ?? 0),
    owner: data?.owner?.name ?? '',
    cover: season.cover ?? '',
  };
}

/** 合集里的全部稿件（分页拉全，保留合集自身顺序）。 */
export async function seasonArchives(bili, { mid, season_id, limit = 300, signal } = {}) {
  const episodes = [];
  const total0 = { total: 0 };
  for (let page = 1; episodes.length < limit; page += 1) {
    const data = await bili.fetchJson(
      `https://api.bilibili.com/x/polymer/web-space/seasons_archives_list?mid=${mid}&season_id=${season_id}&page_num=${page}&page_size=30`,
      { signal },
    );
    const list = data?.archives ?? [];
    for (const item of list) episodes.push(mapEpisode(item, episodes.length + 1));
    total0.total = Number(data?.page?.total ?? episodes.length);
    if (list.length === 0 || episodes.length >= total0.total) break;
  }
  return { episodes: episodes.slice(0, limit), total: total0.total };
}

/** 「系列」（series，非合集）里的稿件。 */
export async function seriesArchives(bili, { mid, series_id, limit = 300, signal } = {}) {
  const episodes = [];
  let total = 0;
  for (let page = 1; episodes.length < limit; page += 1) {
    const data = await bili.fetchJson(
      `https://api.bilibili.com/x/series/archives?mid=${mid}&series_id=${series_id}&only_normal=true&sort=asc&pn=${page}&ps=30`,
      { signal },
    );
    const list = data?.archives ?? [];
    for (const item of list) episodes.push(mapEpisode(item, episodes.length + 1));
    total = Number(data?.page?.total ?? data?.meta?.total ?? episodes.length);
    if (list.length === 0 || episodes.length >= total) break;
  }
  return { episodes: episodes.slice(0, limit), total };
}

/** 一个 UP 主的全部合集与系列。 */
export async function listCollections(bili, mid, { signal } = {}) {
  const out = [];
  for (let page = 1; page <= 20; page += 1) {
    const data = await bili.fetchJson(
      `https://api.bilibili.com/x/polymer/web-space/seasons_series_list?mid=${mid}&page_num=${page}&page_size=20`,
      { signal },
    );
    const lists = data?.items_lists ?? {};
    for (const item of lists.seasons_list ?? []) {
      const meta = item.meta ?? {};
      const { title, raw_title } = cleanTitle(meta.name);
      out.push({ key: seasonKey('season', meta.season_id), kind: 'season', season_id: meta.season_id, title, raw_title, mid: Number(mid), total: Number(meta.total) || 0 });
    }
    for (const item of lists.series_list ?? []) {
      const meta = item.meta ?? {};
      const { title, raw_title } = cleanTitle(meta.name);
      out.push({ key: seasonKey('series', meta.series_id), kind: 'series', series_id: meta.series_id, title, raw_title, mid: Number(mid), total: Number(meta.total) || 0 });
    }
    const declared = Number(data?.page?.total) || out.length;
    if (out.length >= declared || ((lists.seasons_list?.length ?? 0) + (lists.series_list?.length ?? 0)) === 0) break;
  }
  return out;
}

/** 取合集/系列的稿件列表（按 kind 分流）。 */
export async function collectionEpisodes(bili, collection, { limit = 300, signal } = {}) {
  if (collection.kind === 'series') {
    return seriesArchives(bili, { mid: collection.mid, series_id: collection.series_id, limit, signal });
  }
  return seasonArchives(bili, { mid: collection.mid, season_id: collection.season_id, limit, signal });
}

// ---------------------------------------------------------------- 兜底：标题前缀聚类

/** 归一化标题：去掉括号标签、标点、集数编号，便于按前缀聚组。 */
export function normalizeTitle(title) {
  return String(title ?? '')
    .replace(/【[^】]*】/g, '')
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[《][^》]*[》]/g, '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[|｜!！?？,，.。:：;；·、\-_/\\'"“”"‘’+*#&$%@^~=<>[\]{}]/g, '')
    .replace(/第[0-9一二三四五六七八九十百零两]+[集期讲篇部Pp]/g, '')
    .toLowerCase()
    // 只去掉「独立」的数字（集数、版本号），保留 H3 / 2.1 这类字母数字混排里的数字。
    .replace(/(?<![a-z])[0-9]+(?:\.[0-9]+)?(?![a-z])/g, '');
}

/**
 * 没有合集时的兜底：把同一 UP 主的稿件按标题前缀聚成候选系列。
 * @param {{bvid:string,title:string,duration?:number}[]} videos
 * @param {{min?:number,prefixLen?:number}} options
 */
export function clusterByPrefix(videos, { min = 3, prefixLen = 10 } = {}) {
  const groups = new Map();
  for (const video of videos ?? []) {
    const norm = normalizeTitle(video.title);
    if (norm.length < 4) continue;
    // 短标题（去掉集数后只剩几个字）就用全名做 key，否则取前缀。
    const key = norm.length <= prefixLen ? norm : norm.slice(0, prefixLen);
    const group = groups.get(key) ?? { prefix: key, videos: [] };
    group.videos.push(video);
    groups.set(key, group);
  }
  return [...groups.values()]
    .filter((g) => g.videos.length >= min)
    .sort((a, b) => b.videos.length - a.videos.length)
    .map((g) => ({
      prefix: g.prefix,
      count: g.videos.length,
      sample: g.videos[0]?.title ?? '',
      bvids: g.videos.map((v) => v.bvid),
    }));
}

export { BiliClient };
