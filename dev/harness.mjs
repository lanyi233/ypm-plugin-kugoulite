// dev/harness.mjs —— 在 Node 里模拟 YesPlayMusic 的插件宿主。
//
// 宿主（应用里的 QuickJS）给插件的是全局 fetch / host.*，导出函数由 __ypm.call 调用。
// 这里把同样的东西搭出来，就能在没有图形界面的机器上直接跑插件的导出函数，
// 用来做回归、排错，也可以当「换个账号试试」的实验台。
//
// 用法：
//   const { mod, store } = await loadPlugin();
//   const s = await mod.search({ query: '晴天', kind: 'tracks', offset: 0 });
// 账号存档默认读 dev/storage.json（已被 .gitignore 排除，里面是登录 token）。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PLUGIN_DIR = ROOT;
export const ENTRY = path.join(ROOT, 'index.js');
export const STORE_FILE = path.join(ROOT, 'dev', 'storage.json');

/** 读插件源码。宿主是把入口当 ES 模块加载的，这里用 data: URL 原样加载，行为一致。 */
export function source() {
  return fs.readFileSync(ENTRY, 'utf8');
}

/**
 * 加载插件。
 * @param {object} opt
 * @param {Record<string, any>} [opt.storage] 直接给定存储内容（不读文件）
 * @param {string} [opt.storeFile] 账号存档路径，默认 dev/storage.json
 * @param {Record<string, string>} [opt.settings] 插件设置，默认全部取 plugin.json 里的 default
 * @param {(req: {url: string, init: any}) => any} [opt.fetchHook] 包一层 fetch，可用来伪造断网
 */
export async function loadPlugin(opt = {}) {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugin.json'), 'utf8'));
  const storeFile = opt.storeFile || STORE_FILE;

  let store = opt.storage;
  if (!store) {
    try {
      store = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
    } catch (e) {
      store = {};
    }
  }

  const flush = () => {
    if (opt.storage) return;
    fs.mkdirSync(path.dirname(storeFile), { recursive: true });
    fs.writeFileSync(storeFile, JSON.stringify(store, null, 2));
  };

  const settings = {};
  for (const s of manifest.settings || []) settings[s.key] = String(s.default === undefined ? '' : s.default);
  Object.assign(settings, opt.settings || {});

  const realFetch = globalThis.fetch;
  if (opt.fetchHook) globalThis.fetch = (u, i) => opt.fetchHook({ url: String((u && u.url) || u), init: i }, realFetch);

  globalThis.host = {
    platform: process.platform === 'darwin' ? 'macos' : process.platform,
    arch: process.arch,
    dir: path.join(ROOT, 'dev'),
    dataDir: path.join(ROOT, 'dev'),
    language: () => opt.language || 'zh-CN',
    t: (s) => s,
    setting: (k) => (k in settings ? settings[k] : ''),
    storage: {
      get: (k) => (k in store ? store[k] : null),
      set: (k, v) => { store[k] = v; flush(); },
      remove: (k) => { delete store[k]; flush(); },
    },
    crypto: {
      md5: (s) => crypto.createHash('md5').update(String(s), 'utf8').digest('hex'),
      // 插件目前不用它，但要存在，否则任何调用都会炸。
      aesEcbEncrypt: (key, text) => {
        const c = crypto.createCipheriv('aes-128-ecb', Buffer.from(String(key), 'utf8'), null);
        return Buffer.concat([c.update(Buffer.from(String(text), 'utf8')), c.final()]).toString('hex');
      },
    },
    openURL: () => {},
    signInPrompt: () => {},
    webSignIn: async () => { throw new Error('webSignIn 只在 macOS 上有'); },
    spawn: () => { throw new Error('本插件不使用外部程序'); },
  };

  const mod = await import('data:text/javascript;base64,' + Buffer.from(source(), 'utf8').toString('base64'));

  return {
    mod,
    store,
    settings,
    manifest,
    /** 写回存档（storage 是同一个对象，通常不需要手动调）。 */
    flush,
    /** 恢复真实 fetch。 */
    restore: () => { globalThis.fetch = realFetch; },
  };
}

/** 有没有可用的账号存档（dev/storage.json 里带 token 才算）。 */
export function hasAccount() {
  try {
    const s = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    return Boolean(s && s.token);
  } catch (e) {
    return false;
  }
}
