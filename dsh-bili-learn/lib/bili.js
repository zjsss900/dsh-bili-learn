// B 站公开接口客户端：WBI 签名、元数据、字幕、标签、搜索。
// 只依赖 Node 内置能力与全局 fetch，不引入任何第三方包。
import { createHash } from 'node:crypto';


const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// WBI 混淆表（B 站 web 端固定值）。
const MIXIN_TABLE = [
  46, 47, 1, 2, 6, 35, 23, 37, 34, 27, 28, 15, 7, 9, 26, 15, 3, 29, 1, 19, 38, 6, 33, 36, 41, 37, 38, 11, 13, 14, 21, 30,
  15, 22, 33, 32, 47, 45, 40, 13, 1, 2, 6, 15, 24, 29, 28, 47, 39, 26, 13, 10, 43, 29, 47, 40, 44, 32, 47, 34, 43, 15, 45,
];

/** 从 b 站图片 URL 中取出 32 位 key。 */
function keyFromImageUrl(url) {
  const match = /\/([a-f0-9]{32})[^/]*\./.exec(String(url || ''));
  return match ? match[1] : '';
}

/** 识别用户给的链接或 BV/AV 号。返回 { bvid } 或 { aid }。 */
export function parseVideoRef(input) {
  const text = String(input || '').trim();
  if (!text) throw new Error('需要 B 站视频链接或 BV/AV 号');
  const bv = /\b(BV[0-9A-Za-z]{10})\b/.exec(text);
  if (bv) return { bvid: bv[1] };
  const av = /\bav(\d+)\b/i.exec(text);
  if (av) return { aid: Number(av[1]) };
  const num = /^(\d{6,})$/.exec(text);
  if (num) return { aid: Number(num[1]) };
  throw new Error(`无法识别视频标识：${text.slice(0, 80)}（支持 BV 号、av 号或视频页链接）`);
}

/** 从链接里取出分 P 序号（?p=3）。 */
export function parsePageIndex(input) {
  const match = /[?&]p=(\d+)/.exec(String(input || ''));
  return match ? Number(match[1]) : undefined;
}

function md5Hex(text) {
  return createHash('md5').update(text, 'utf8').digest('hex');
}

export class BiliClient {
  /**
   * @param {{ cookie?: string, timeoutMs?: number }} options
   */
  constructor(options = {}) {
    this.cookie = normalizeCookie(options.cookie);
    this.timeoutMs = options.timeoutMs ?? 20000;
    this._wbiKey = undefined;
    this._wbiAt = 0;
  }

  get loggedIn() {
    return this.cookie.length > 0;
  }

  /**
   * 没有用户 Cookie 时引导一个匿名 buvid3/buvid4。
   * 实测：匿名搜索接口不带 buvid3 会返回 -101 或空结果。
   */
  async cookieHeader() {
    if (this.cookie) return this.cookie;
    if (this._anon) return this._anon;
    if (this._bootstrapping) return '';
    this._bootstrapping = true;
    try {
      const response = await fetch('https://api.bilibili.com/x/frontend/finger/spi', {
        headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const data = (await response.json())?.data;
      if (data?.b_3) this._anon = `buvid3=${data.b_3}${data.b_4 ? `; buvid4=${data.b_4}` : ''}`;
    } catch {
      /* 引导失败就继续裸请求，让上层看到真实错误 */
    } finally {
      this._bootstrapping = false;
    }
    return this._anon ?? '';
  }

  async fetchJson(url, { referer = 'https://www.bilibili.com/', signal, allowCodes = [] } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`请求超时 ${this.timeoutMs}ms`)), this.timeoutMs);
    const cookie = await this.cookieHeader();
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': UA,
          Referer: referer,
          Accept: 'application/json, text/plain, */*',
          ...(cookie ? { Cookie: cookie } : {}),
        },
        signal: signal ?? controller.signal,
      });
      const text = await response.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(`接口未返回 JSON（HTTP ${response.status}）：${text.slice(0, 160)}`);
      }
      if (json.code !== 0 && !allowCodes.includes(json.code)) {
        const err = new Error(`接口 code=${json.code} ${json.message ?? ''}`.trim());
        err.code = json.code;
        throw err;
      }
      return json.data;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 取 WBI 签名 key（5 分钟内复用）。
   * 注意：`nav` 对未登录请求返回 code=-101，但 wbi_img 照样下发——这是 B 站的实际行为，
   * 所以这里不能用「code 非 0 就抛错」的通用路径。
   */
  async wbiKey({ signal } = {}) {
    if (this._wbiKey && Date.now() - this._wbiAt < 300000) return this._wbiKey;
    const nav = await this.fetchJson('https://api.bilibili.com/x/web-interface/nav', { signal, allowCodes: [-101] });
    const img = keyFromImageUrl(nav?.wbi_img?.img_url);
    const sub = keyFromImageUrl(nav?.wbi_img?.sub_url);
    if (!img || !sub) throw new Error('无法取得 WBI 签名 key');
    const raw = img + sub;
    let mixed = '';
    for (const index of MIXIN_TABLE) mixed += raw[index];
    this._wbiKey = mixed.slice(0, 32);
    this._wbiAt = Date.now();
    return this._wbiKey;
  }

  /** 生成带 wts + w_rid 的查询串。 */
  async signedQuery(params, { signal } = {}) {
    const key = await this.wbiKey({ signal });
    const clean = {};
    for (const [name, value] of Object.entries(params)) {
      clean[name] = String(value).replace(/[!'()*]/g, '');
    }
    const query = Object.keys(clean)
      .sort()
      .map((name) => `${name}=${encodeURIComponent(clean[name])}`)
      .join('&');
    return `${query}&w_rid=${md5Hex(query + key)}`;
  }

  /** 视频元数据（标题、简介、分 P、时长、UP 主）。 */
  async view(ref, { signal } = {}) {
    const param = ref.bvid ? `bvid=${ref.bvid}` : `aid=${ref.aid}`;
    const data = await this.fetchJson(`https://api.bilibili.com/x/web-interface/view?${param}`, { signal });
    return {
      bvid: data.bvid,
      aid: data.aid,
      cid: data.cid,
      title: data.title ?? '',
      description: (data.desc ?? '').trim(),
      duration: data.duration ?? 0,
      owner: data.owner?.name ?? '',
      mid: data.mid ?? 0,
      pic: data.pic ?? '',
      pubdate: data.pubdate ?? 0,
      pages: (data.pages ?? []).map((p, i) => ({
        index: p.page ?? i + 1,
        cid: p.cid,
        part: p.part ?? '',
        duration: p.duration ?? 0,
      })),
      stat: {
        view: data.stat?.view ?? 0,
        like: data.stat?.like ?? 0,
        favorite: data.stat?.favorite ?? 0,
      },
      url: `https://www.bilibili.com/video/${data.bvid}`,
    };
  }

  /** 分 P 列表。 */
  async pages(bvid, { signal } = {}) {
    const data = await this.fetchJson(`https://api.bilibili.com/x/player/pagelist?bvid=${bvid}`, { signal });
    return (data ?? []).map((p, i) => ({ index: p.page ?? i + 1, cid: p.cid, part: p.part ?? '', duration: p.duration ?? 0 }));
  }

  /** 字幕轨列表。未登录时 B 站通常返回空数组——这是事实，不是 bug。 */
  async subtitleTracks(bvid, cid, { signal } = {}) {
    const query = await this.signedQuery({ bvid, cid, wts: Math.floor(Date.now() / 1000) }, { signal });
    const data = await this.fetchJson(`https://api.bilibili.com/x/player/wbi/v2?${query}`, { signal });
    const tracks = data?.subtitle?.subtitles ?? [];
    return tracks.map((t) => ({
      lan: t.lan ?? '',
      lan_doc: t.lan_doc ?? '',
      ai_type: t.ai_type ?? 0,
      url: String(t.subtitle_url ?? '').replace(/^\/\//, 'https://'),
    }));
  }

  /** 下载一条字幕轨，统一成 [{t, d, text}]。 */
  async fetchSubtitle(url, { signal } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('字幕下载超时')), this.timeoutMs);
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/', ...(this.cookie ? { Cookie: this.cookie } : {}) },
        signal: signal ?? controller.signal,
      });
      const text = await response.text();
      const body = JSON.parse(text)?.body;
      if (!Array.isArray(body)) throw new Error('字幕 JSON 没有 body 数组');
      return body
        .map((line) => ({ t: Number(line.from) || 0, d: Math.max(0, (Number(line.to) || 0) - (Number(line.from) || 0)), text: String(line.content ?? '').trim() }))
        .filter((line) => line.text.length > 0);
    } finally {
      clearTimeout(timer);
    }
  }

  /** 稿件标签。 */
  async tags(bvid, { signal } = {}) {
    try {
      const data = await this.fetchJson(`https://api.bilibili.com/x/tag/archive/tags?bvid=${bvid}`, { signal });
      return (data ?? []).map((t) => t.tag_name).filter(Boolean);
    } catch {
      return [];
    }
  }

  /** 视频搜索。实测：匿名时普通端点可用，wbi 端点会返回空结果，所以两个都试。 */
  async search(keyword, { limit = 10, signal } = {}) {
    const size = Math.min(30, Math.max(1, Number(limit) || 10));
    const map = (list) =>
      (list ?? []).map((r) => ({
        bvid: r.bvid,
        title: String(r.title ?? '').replace(/<[^>]+>/g, ''),
        author: r.author ?? '',
        duration: r.duration ?? '',
        play: r.play ?? 0,
        url: `https://www.bilibili.com/video/${r.bvid}`,
      }));
    let lastError;
    try {
      const data = await this.fetchJson(
        `https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=${encodeURIComponent(keyword)}&page=1&page_size=${size}`,
        { signal },
      );
      if (data?.result?.length) return map(data.result);
    } catch (error) {
      lastError = error;
    }
    try {
      const query = await this.signedQuery(
        { search_type: 'video', keyword, page: 1, page_size: size, wts: Math.floor(Date.now() / 1000) },
        { signal },
      );
      const data = await this.fetchJson(`https://api.bilibili.com/x/web-interface/wbi/search/type?${query}`, { signal });
      if (data?.result?.length) return map(data.result);
    } catch (error) {
      lastError = error;
    }
    if (lastError) throw lastError;
    return [];
  }
}

/** 允许用户只粘贴 SESSDATA，或粘贴整条 Cookie 串。 */
export function normalizeCookie(input) {
  const text = String(input ?? '').trim();
  if (!text) return '';
  if (!text.includes('=')) return `SESSDATA=${text}`;
  return text;
}
