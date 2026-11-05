// 字幕兜底通道：yt-dlp（可复用浏览器登录态）+ 常见字幕格式解析。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** 机器上是否有 yt-dlp。 */
export function findYtDlp(configured) {
  const candidates = configured ? [configured] : ['yt-dlp', 'yt-dlp.exe'];
  return candidates[0] ?? null;
}

/**
 * 用 yt-dlp 把字幕抓到 workDir，返回 [{file, format}]。
 * @param {{ url: string, workDir: string, browser?: string, bin?: string, timeoutMs?: number, signal?: AbortSignal }} options
 */
export async function fetchSubtitlesWithYtDlp(options) {
  const { url, workDir, browser, bin = 'yt-dlp', timeoutMs = 180000, signal } = options;
  fs.mkdirSync(workDir, { recursive: true });
  const args = [
    '--skip-download',
    '--write-subs',
    '--write-auto-subs',
    '--sub-langs', 'all',
    '--no-warnings',
    '--restrict-filenames',
    '-o', path.join(workDir, '%(id)s.%(ext)s').replace(/\\/g, '/'),
  ];
  if (browser) args.push('--cookies-from-browser', browser);
  args.push(url);

  const output = await run(bin, args, { timeoutMs, signal });
  const files = fs
    .readdirSync(workDir)
    .filter((name) => /\.(srt|vtt|json3|ass|ttml2?|xml)$/i.test(name))
    .map((name) => ({ file: path.join(workDir, name), format: path.extname(name).slice(1).toLowerCase() }));
  if (files.length === 0) {
    const err = new Error('yt-dlp 没有拿到字幕文件');
    err.detail = output.slice(-800);
    throw err;
  }
  return files;
}

function run(bin, args, { timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true, signal });
    let out = '';
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* 已退出 */
      }
      reject(new Error(`${bin} 超时 ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => (out = (out + chunk).slice(-20000)));
    child.stderr?.on('data', (chunk) => (out = (out + chunk).slice(-20000)));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`无法执行 ${bin}：${error.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else {
        let hint = '';
        if (/Could not copy Chrome cookie database|PermissionError/i.test(out)) {
          hint = '｜浏览器正在运行，Cookie 数据库被锁：完全退出该浏览器后重试，或改用插件 config 里的 cookie。';
        } else if (/could not be decrypted|Decryption|App-Bound/i.test(out)) {
          hint = '｜浏览器 Cookie 解密失败（Chrome 新版 App-Bound 加密）：改用插件 config 里的 cookie。';
        }
        reject(new Error(`${bin} 退出码 ${code}：${out.slice(-500)}${hint}`));
      }
    });
  });
}

/** 按扩展名解析字幕文件 → [{t, d, text}]。 */
export function parseSubtitleFile(file, format) {
  const text = fs.readFileSync(file, 'utf8');
  const fmt = String(format || path.extname(file).slice(1)).toLowerCase();
  if (fmt === 'json3') return parseJson3(text);
  if (fmt === 'srt' || fmt === 'vtt') return parseCues(text);
  if (fmt === 'ass' || fmt === 'ssa') return parseAss(text);
  if (fmt === 'xml') return parseDanmakuXml(text);
  if (fmt === 'ttml' || fmt === 'ttml2') return parseTtml(text);
  return parseCues(text);
}

function parseJson3(text) {
  const data = JSON.parse(text);
  return (data?.events ?? [])
    .map((event) => ({
      t: (Number(event.tStartMs) || 0) / 1000,
      d: (Number(event.durMs) || 0) / 1000,
      text: (event.segs ?? []).map((seg) => seg.utf8 ?? '').join('').replace(/\s+/g, ' ').trim(),
    }))
    .filter((line) => line.text);
}

function timeToSeconds(value) {
  const match = /(?:(\d{1,2}):)?(\d{1,2}):(\d{1,2})([.,](\d{1,3}))?/.exec(String(value).trim());
  if (!match) return 0;
  const hours = match[1] ? Number(match[1]) : 0;
  return hours * 3600 + Number(match[2]) * 60 + Number(match[3]) + (match[5] ? Number(`0.${match[5]}`) : 0);
}

function parseCues(text) {
  const lines = text.replace(/\r/g, '').split('\n');
  const out = [];
  let current = null;
  for (const line of lines) {
    const cue = /^(\d{1,2}:)?\d{1,2}:\d{1,2}[.,]\d{1,3}\s*-->\s*(\d{1,2}:)?\d{1,2}:\d{1,2}[.,]\d{1,3}/.exec(line);
    if (cue) {
      const [left] = line.split('-->');
      current = { t: timeToSeconds(left.trim()), d: 0, text: '' };
      continue;
    }
    if (!line.trim()) {
      if (current) {
        const body = current.text.replace(/\s+/g, ' ').trim();
        if (body) out.push({ t: current.t, d: 0, text: body });
        current = null;
      }
      continue;
    }
    if (current) current.text += ' ' + line;
  }
  if (current?.text.trim()) out.push({ t: current.t, d: 0, text: current.text.replace(/\s+/g, ' ').trim() });
  return out;
}

function parseAss(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('Dialogue:')) continue;
    const parts = line.slice('Dialogue:'.length).split(',');
    if (parts.length < 10) continue;
    const start = timeToSeconds(parts[1]);
    const end = timeToSeconds(parts[2]);
    const body = parts.slice(9).join(',').replace(/\{[^}]*\}/g, '').replace(/\\N/g, ' ').replace(/\s+/g, ' ').trim();
    if (body) out.push({ t: start, d: Math.max(0, end - start), text: body });
  }
  return out;
}

function parseTtml(text) {
  const out = [];
  const pattern = /<p[^>]*begin="([^"]+)"[^>]*end="([^"]+)"[^>]*>([\s\S]*?)<\/p>/g;
  let match;
  while ((match = pattern.exec(text))) {
    const body = match[3].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (body) out.push({ t: timeToSeconds(match[1]), d: timeToSeconds(match[2]) - timeToSeconds(match[1]), text: body });
  }
  return out;
}

/** 弹幕 xml：不是讲稿，只在完全没有字幕时作为极弱信号。 */
function parseDanmakuXml(text) {
  const out = [];
  const pattern = /<d p="([\d.]+),[^"]*">([^<]*)<\/d>/g;
  let match;
  while ((match = pattern.exec(text))) {
    const body = match[2].replace(/\s+/g, ' ').trim();
    if (body) out.push({ t: Number(match[1]) || 0, d: 0, text: body });
  }
  return out;
}
