// 取帧：B 站没有公开的快照接口（实测 player/snapshot 404、preview 返回 HTML），
// 所以走 playurl 拿 mp4 直链 + ffmpeg 抽帧。CDN 校验 Referer/UA，缺头就 403。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** 找到可用的 ffmpeg：config 指定 → PATH → python 的 imageio-ffmpeg 自带二进制。 */
export function resolveFfmpeg({ bin = '', python = 'python', signal } = {}) {
  const candidates = bin ? [bin] : [];
  const probe = (exe) => {
    try {
      const r = spawnSync(exe, ['-version'], { windowsHide: true, encoding: 'utf8', signal });
      return r.status === 0 ? exe : '';
    } catch {
      return '';
    }
  };
  for (const c of candidates) {
    const found = probe(c);
    if (found) return found;
  }
  const onPath = probe('ffmpeg');
  if (onPath) return onPath;
  try {
    const r = spawnSync(python, ['-c', 'import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())'], { windowsHide: true, encoding: 'utf8', signal });
    const exe = (r.stdout ?? '').trim();
    if (r.status === 0 && exe && fs.existsSync(exe)) return exe;
  } catch {
    /* 没装 python 包就算了 */
  }
  return '';
}

/** 取 mp4 直链（登录态；qn 越小越快，32=480P 足够读画面文字）。 */
export async function playurlMp4(client, { bvid, cid, qn = 32, signal } = {}) {
  const query = await client.signedQuery({ bvid, cid, qn, fnval: 1, fourk: 0 }, { signal });
  const json = await client.fetchJson(`https://api.bilibili.com/x/player/wbi/playurl?${query}`, { referer: `https://www.bilibili.com/video/${bvid}`, signal });
  const durl = json.durl ?? json.data?.durl ?? [];
  if (!durl[0]?.url) throw new Error(`playurl 没有 mp4 直链（code=${json.code ?? '?'} quality=${json.quality ?? json.data?.quality ?? '?'}）；可能需要登录或该分 P 不可用`);
  return { url: durl[0].url, quality: json.quality ?? json.data?.quality ?? qn, sizeBytes: durl.reduce((n, d) => n + (d.size ?? 0), 0) };
}

/** 抽一帧到 outPath。t 是秒。 */
export function grabFrame({ ffmpeg, url, referer, userAgent, t, outPath, signal } = {}) {
  if (!ffmpeg) throw new Error('找不到 ffmpeg：装一个、或在插件 config 里填 ffmpeg 路径、或 pip install imageio-ffmpeg');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const headers = `Referer: ${referer}\r\nUser-Agent: ${userAgent}\r\n`;
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-headers', headers, '-ss', String(Number(t) || 0), '-i', url, '-frames:v', '1', '-q:v', '3', '-y', outPath], { windowsHide: true, signal });
    let err = '';
    child.stderr?.on('data', (chunk) => (err = (String(chunk) + err).slice(-400)));
    child.on('error', () => reject(new Error(`无法执行 ${ffmpeg}`)));
    child.on('close', (code) => {
      if (code === 0 && fs.existsSync(outPath)) resolve(outPath);
      else reject(new Error(`ffmpeg 退出码 ${code}：${err || '没写出文件'}`));
    });
  });
}
