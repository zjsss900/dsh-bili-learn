// 扫码登录：不需要密码、不需要浏览器。二维码 PNG 由本地 python qrcode 渲染（可选），
// 渲染不了就退回把登录 URL 交给用户，绝不把登录令牌发给第三方图像服务。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, Referer: 'https://www.bilibili.com/', Origin: 'https://www.bilibili.com' };

/** 申请一次扫码登录，返回登录 URL 与 qrcode_key。 */
export async function startQrLogin({ signal } = {}) {
  const response = await fetch('https://passport.bilibili.com/x/passport-login/web/qrcode/generate', { headers: HEADERS, signal });
  const json = await response.json();
  if (json.code !== 0) throw new Error(`申请二维码失败：code=${json.code} ${json.message ?? ''}`);
  if (!json.data?.qrcode_key) throw new Error('申请二维码失败：响应里没有 qrcode_key');
  return { url: json.data.url, key: json.data.qrcode_key };
}

/**
 * 轮询一次。
 * @returns {{state: 'unscanned'|'scanned'|'confirmed'|'expired'|'denied', cookie?: string, fields?: string[], message?: string}}
 */
export async function pollQrLogin(key, { signal } = {}) {
  const response = await fetch(`https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(key)}`, { headers: HEADERS, signal });
  const data = (await response.json())?.data ?? {};
  if (data.code === 0) {
    const pairs = response.headers.getSetCookie().map((c) => c.split(';')[0]).filter((p) => p.includes('='));
    return { state: 'confirmed', cookie: pairs.join('; '), fields: pairs.map((p) => p.split('=')[0]) };
  }
  if (data.code === 86101) return { state: 'unscanned' };
  if (data.code === 86090) return { state: 'scanned' };
  if (data.code === 86038) return { state: 'expired', message: data.message };
  return { state: 'denied', message: `${data.code} ${data.message ?? ''}`.trim() };
}

/** 把 Cookie 写入文件（0600 尽力而为），返回路径。 */
export function writeCookieFile(file, cookie) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, cookie, { encoding: 'utf8', mode: 0o600 });
  return file;
}

/** 用本地 python + qrcode 渲染二维码 PNG；不可用时抛错，由调用方退回 URL。 */
export function renderQrPng(url, pngPath, { python = 'python', signal } = {}) {
  fs.mkdirSync(path.dirname(pngPath), { recursive: true });
  return new Promise((resolve, reject) => {
    const child = spawn(python, ['-c', 'import qrcode,sys; qrcode.make(sys.argv[1]).save(sys.argv[2])', url, pngPath], { windowsHide: true, signal });
    let err = '';
    child.stderr?.on('data', (chunk) => (err = (err + chunk).slice(-400)));
    child.on('error', () => reject(new Error(`无法执行 ${python}：装 python + qrcode 才能出二维码图，否则用返回的 url 自己打开`)));
    child.on('close', (code) => (code === 0 ? resolve(pngPath) : reject(new Error(`${python} 渲染二维码失败：${err || '缺 qrcode 包（pip install qrcode）'}`))));
  });
}

/** 用当前 Cookie 查登录身份，用于 status 与登录后的自检。 */
export async function whoami(cookie, { signal } = {}) {
  const response = await fetch('https://api.bilibili.com/x/web-interface/nav', {
    headers: { ...HEADERS, ...(cookie ? { Cookie: cookie } : {}) },
    signal,
  });
  const json = await response.json();
  return { isLogin: Boolean(json.data?.isLogin), mid: json.data?.mid ?? 0, uname: json.data?.uname ?? '', code: json.code };
}
