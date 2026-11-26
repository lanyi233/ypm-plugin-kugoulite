// dev/check.mjs —— 不改任何东西的静态检查：清单合法、入口能编译、导出都在宿主认得的名单里。
//
//   node dev/check.mjs
//
// 这三件事是宿主加载插件时会做的前置检查，本地先过一遍，省得来回重启应用。

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, ENTRY } from './harness.mjs';

let bad = 0;
const ok = (name, extra) => console.log('  ok   ' + name + (extra ? '  ' + extra : ''));
const no = (name, why) => { bad++; console.log('  FAIL ' + name + '  ' + why); };

// ── 1. plugin.json ────────────────────────────────────────────
// 规则照抄宿主 lib/plugin/manifest.dart：id 小写字母数字加 . _ -，≤64，local 保留；
// main 必须是插件目录内的相对路径且以 .js/.mjs 结尾；icon 只能是 png/jpg/webp。
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const safeRelative = (p) => typeof p === 'string' && !p.startsWith('/') && !path.isAbsolute(p)
  && !p.replaceAll('\\', '/').split('/').some((s) => s === '..' || s.includes(':'));

let manifest = null;
try {
  manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugin.json'), 'utf8'));
  ok('plugin.json 是合法 JSON');
} catch (e) {
  no('plugin.json', e.message);
}

if (manifest) {
  if (ID_RE.test(String(manifest.id || '')) && manifest.id !== 'local') ok('id', manifest.id);
  else no('id', JSON.stringify(manifest.id));

  if (String(manifest.name || '').trim()) ok('name', manifest.name);
  else no('name', '不能为空');

  if (/^\d+\.\d+\.\d+/.test(String(manifest.version || ''))) ok('version', manifest.version);
  else no('version', JSON.stringify(manifest.version));

  const main = manifest.main === undefined ? 'index.js' : manifest.main;
  if (safeRelative(main) && /\.(m?js)$/.test(main)) ok('main', main);
  else no('main', JSON.stringify(main));

  if (!manifest.icon) ok('icon', '未设置，用首字母');
  else if (safeRelative(manifest.icon) && /\.(png|jpe?g|webp)$/i.test(manifest.icon)) {
    const f = path.join(ROOT, manifest.icon);
    if (fs.existsSync(f)) ok('icon', manifest.icon + '  ' + fs.statSync(f).size + 'B');
    else no('icon', manifest.icon + ' 文件不存在');
  } else no('icon', JSON.stringify(manifest.icon));

  // 网络白名单：*.kugou.com 只匹配子域名，裸 kugou.com 要单独写。
  const net = (manifest.permissions && manifest.permissions.network) || [];
  if (Array.isArray(net) && net.length) ok('permissions.network', net.join(' '));
  else no('permissions.network', '没写就完全不能联网');

  for (const s of manifest.settings || []) {
    if (!s.key) no('settings', '有条目没有 key');
    else if (!['text', 'password', 'boolean', 'select'].includes(s.type)) no('settings.' + s.key, 'type 必须是 text/password/boolean/select');
    // 有 settings 但带了 op 字段的话，宿主会把这个 op 关掉。
    else if (s.op) no('settings.' + s.key, '不能带 op 字段');
    else ok('settings.' + s.key, s.type + ' 默认 ' + JSON.stringify(s.default));
  }

  for (const n of manifest.navigation || []) {
    const builtin = ['home', 'liked', 'savedAlbums', 'stations', 'shows'];
    if (builtin.includes(n.builtin)) ok('navigation', n.builtin);
    else if (n.title && n.page) ok('navigation', n.title + ' → ' + n.page);
    else no('navigation', JSON.stringify(n));
  }
}

// ── 2. 入口能不能编译 ────────────────────────────────────────
// 宿主用 QuickJS 按 ES 模块编译入口，这里用 node --check 做同等的事：
// 只查语法，不执行，所以不会联网、不会碰 storage。
try {
  execFileSync(process.execPath, ['--check', ENTRY], { stdio: 'pipe' });
  ok('index.js 语法', fs.statSync(ENTRY).size + 'B');
} catch (e) {
  no('index.js 语法', String((e.stderr || e.stdout || e.message)).trim().split('\n').slice(0, 6).join('\n         '));
}

// ── 3. 导出函数的名单 ────────────────────────────────────────
// 宿主只认 lib/music/source.dart 里那些 op；多导出的函数不会被调用，
// 但如果拼错了名字，界面上那个功能就是静默失效，所以这里对一遍。
const KNOWN = new Set([
  'signIn', 'signOut', 'account', 'profile',
  'home', 'browse', 'search', 'suggest', 'hotSearches',
  'library', 'liked', 'isLiked', 'like', 'savedAlbums', 'saveAlbum', 'followArtist', 'recent', 'played',
  'album', 'artist', 'playlists', 'playlist', 'savePlaylist', 'createPlaylist', 'renamePlaylist',
  'deletePlaylist', 'addToPlaylist', 'removeFromPlaylist', 'movePlaylistTrack',
  'stream', 'lyrics', 'similar', 'station', 'dislike',
  'comments', 'postComment', 'likeComment', 'trackMenu', 'menuAction',
]);

const src = fs.readFileSync(ENTRY, 'utf8');
const exported = [...src.matchAll(/^export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)/gm)].map((m) => m[1]);
const unknown = exported.filter((n) => !KNOWN.has(n));
if (!exported.length) no('导出函数', '一个都没找到');
else if (unknown.length) no('导出函数', '宿主不认得：' + unknown.join(', '));
else ok('导出函数', exported.length + ' 个：' + exported.join(' '));

console.log(bad ? '\n' + bad + ' 项不通过' : '\n全部通过');
process.exit(bad ? 1 : 0);
