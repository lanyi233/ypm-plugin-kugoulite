// 酷狗音乐 Lite —— YesPlayMusic 插件
//
// 协议逆向自 Salt Player 的 cn.spw.kugou.lite 插件：它的 native sidecar
// (libkugou_server.so) 是 KuGouMusicApi 的 Rust 移植，用「概念版」参数：
// appid=3116、clientver=11440，签名 = MD5(盐 + 排序后的 k=v + 请求体 + 盐)。
// 曲目 id 用 hash|albumId|albumAudioId|时长秒 编码，取流与歌词都从这里还原。

const SALT_LITE = 'LnT6xpN3khm36zse0QzvmgTZ3waWdRSA';
const SALT_WEB = 'NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt';
const APPID = '3116';
const CLIENTVER = '11440';
const SRCAPPID = '2919';
const PLAY_SECRET = '185672dd44712f60bb1736df5a377e82';
const UA = 'Android15-1070-11440-201-0-play-wifi';
const QR_LANDING = 'https://h5.kugou.com/apps/loginQRCode/html/index.html';

// 一页 30 首，和界面上的翻页粒度一致。
const PAGE = 30;
// 歌单接口一页最多给 300 首。
const TRACK_PAGE = 300;

const T = (s) => { try { return host.t(s) || s; } catch (e) { return s; } };

// ── 基础工具 ───────────────────────────────────────────────
const md5 = (s) => host.crypto.md5(String(s));

function randStr(n) {
  const pool = '1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let out = '';
  for (let i = 0; i < n; i++) out += pool[Math.floor(Math.random() * pool.length)];
  return out;
}

function uuid() {
  const hex = (n) => Math.floor(Math.random() * Math.pow(16, n)).toString(16).padStart(n, '0');
  return hex(8) + '-' + hex(4) + '-4' + hex(3) + '-a' + hex(3) + '-' + hex(12);
}

// MD5(guid) 的十六进制大整数转十进制字符串。不依赖 BigInt，纯字符串乘法。
function hexToDec(hex) {
  let digits = '0';
  for (const ch of hex.toLowerCase()) {
    const carryInit = parseInt(ch, 16);
    let carry = carryInit;
    let out = '';
    for (let i = digits.length - 1; i >= 0; i--) {
      const v = (digits.charCodeAt(i) - 48) * 16 + carry;
      out = String(v % 10) + out;
      carry = Math.floor(v / 10);
    }
    while (carry > 0) {
      out = String(carry % 10) + out;
      carry = Math.floor(carry / 10);
    }
    digits = out.replace(/^0+(?=\d)/, '');
  }
  return digits;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 存储 ──────────────────────────────────────────────────
function load(key, fallback) {
  try {
    const v = host.storage.get(key);
    return v === undefined || v === null ? fallback : v;
  } catch (e) {
    return fallback;
  }
}

function save(key, value) {
  try { host.storage.set(key, value); } catch (e) { /* 存储坏了也不能让播放挂掉 */ }
}

function drop(key) {
  try { host.storage.remove(key); } catch (e) { /* 同上 */ }
}

// 设备标识：dfid 是 24 位随机串，mid 是 guid 的 MD5 十进制；都固定下来。
function dfid() {
  let v = load('dfid', '');
  if (!v) { v = randStr(24); save('dfid', v); }
  return v;
}

function mid() {
  let v = load('mid', '');
  if (!v) { v = hexToDec(md5(uuid())); save('mid', v); }
  return v;
}

// 登录态。
function auth() {
  return { token: String(load('token', '')), userid: String(load('userid', '') || '0') };
}

const loggedIn = () => auth().token !== '';

function setAuth(token, userid) {
  save('token', String(token || ''));
  save('userid', String(userid || ''));
}

function clearAuth() {
  drop('token'); drop('userid'); drop('nickname'); drop('avatar');
}

// ── 签名与请求 ─────────────────────────────────────────────
function sortJoin(params) {
  return Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== null)
    .sort()
    .map((k) => {
      const v = params[k];
      return k + '=' + (typeof v === 'object' ? JSON.stringify(v) : String(v));
    })
    .join('');
}

function signWith(params, salt, data) {
  return md5(salt + sortJoin(params) + (data || '') + salt);
}

function baseParams() {
  const a = auth();
  const p = {
    dfid: dfid(),
    mid: mid(),
    uuid: '-',
    appid: APPID,
    clientver: CLIENTVER,
    clienttime: Math.floor(Date.now() / 1000),
  };
  if (a.token) { p.token = a.token; p.userid = a.userid; }
  return p;
}

function qs(params) {
  return Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== null)
    .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(String(params[k])))
    .join('&');
}

// ── 纯 JS 的 AES-CBC 与 RSA ───────────────────────────────
// 宿主只给 md5 和 AES-ECB，而云歌单那一族接口要求参数走 RSA、请求体走 AES-CBC，
// 所以这里自带一份最小实现：S 盒用有限域现算，RSA 只用 BigInt 做模幂。
const AES_SBOX = (() => {
  const s = new Uint8Array(256);
  let p = 1;
  let q = 1;
  do {
    p = (p ^ (p << 1) ^ (p & 0x80 ? 0x1b : 0)) & 0xff;
    q ^= q << 1; q ^= q << 2; q ^= q << 4; q &= 0xff;
    if (q & 0x80) q ^= 0x09;
    const x = q ^ ((q << 1) | (q >> 7)) ^ ((q << 2) | (q >> 6)) ^ ((q << 3) | (q >> 5)) ^ ((q << 4) | (q >> 4));
    s[p] = (x ^ 0x63) & 0xff;
  } while (p !== 1);
  s[0] = 0x63;
  return s;
})();

const AES_INV = (() => {
  const inv = new Uint8Array(256);
  for (let i = 0; i < 256; i++) inv[AES_SBOX[i]] = i;
  return inv;
})();

const aesXtime = (a) => ((a << 1) ^ (a & 0x80 ? 0x1b : 0)) & 0xff;

function aesMul(a, b) {
  let r = 0;
  while (b) {
    if (b & 1) r ^= a;
    a = aesXtime(a);
    b >>= 1;
  }
  return r & 0xff;
}

function aesExpandKey(key) {
  const nk = key.length / 4;
  const nr = nk + 6;
  const w = new Uint8Array(16 * (nr + 1));
  w.set(key);
  let rcon = 1;
  for (let i = nk; i < 4 * (nr + 1); i++) {
    let t = [w[4 * (i - 1)], w[4 * (i - 1) + 1], w[4 * (i - 1) + 2], w[4 * (i - 1) + 3]];
    if (i % nk === 0) {
      t = [AES_SBOX[t[1]] ^ rcon, AES_SBOX[t[2]], AES_SBOX[t[3]], AES_SBOX[t[0]]];
      rcon = aesXtime(rcon);
    } else if (nk > 6 && i % nk === 4) {
      t = [AES_SBOX[t[0]], AES_SBOX[t[1]], AES_SBOX[t[2]], AES_SBOX[t[3]]];
    }
    for (let j = 0; j < 4; j++) w[4 * i + j] = w[4 * (i - nk) + j] ^ t[j];
  }
  return { w, nr };
}

function aesEncryptBlock(rk, inp) {
  const { w, nr } = rk;
  const s = Uint8Array.from(inp);
  const add = (r) => { for (let i = 0; i < 16; i++) s[i] ^= w[16 * r + i]; };
  add(0);
  for (let r = 1; r <= nr; r++) {
    for (let i = 0; i < 16; i++) s[i] = AES_SBOX[s[i]];
    const t = Uint8Array.from(s);
    for (let c = 0; c < 4; c++) for (let row = 0; row < 4; row++) s[4 * c + row] = t[4 * ((c + row) % 4) + row];
    if (r !== nr) {
      for (let c = 0; c < 4; c++) {
        const a0 = s[4 * c], a1 = s[4 * c + 1], a2 = s[4 * c + 2], a3 = s[4 * c + 3];
        s[4 * c] = aesMul(a0, 2) ^ aesMul(a1, 3) ^ a2 ^ a3;
        s[4 * c + 1] = a0 ^ aesMul(a1, 2) ^ aesMul(a2, 3) ^ a3;
        s[4 * c + 2] = a0 ^ a1 ^ aesMul(a2, 2) ^ aesMul(a3, 3);
        s[4 * c + 3] = aesMul(a0, 3) ^ a1 ^ a2 ^ aesMul(a3, 2);
      }
    }
    add(r);
  }
  return s;
}

function aesDecryptBlock(rk, inp) {
  const { w, nr } = rk;
  const s = Uint8Array.from(inp);
  const add = (r) => { for (let i = 0; i < 16; i++) s[i] ^= w[16 * r + i]; };
  add(nr);
  for (let r = nr - 1; r >= 0; r--) {
    const t0 = Uint8Array.from(s);
    for (let c = 0; c < 4; c++) for (let row = 0; row < 4; row++) s[4 * ((c + row) % 4) + row] = t0[4 * c + row];
    for (let i = 0; i < 16; i++) s[i] = AES_INV[s[i]];
    add(r);
    if (r !== 0) {
      for (let c = 0; c < 4; c++) {
        const a0 = s[4 * c], a1 = s[4 * c + 1], a2 = s[4 * c + 2], a3 = s[4 * c + 3];
        s[4 * c] = aesMul(a0, 14) ^ aesMul(a1, 11) ^ aesMul(a2, 13) ^ aesMul(a3, 9);
        s[4 * c + 1] = aesMul(a0, 9) ^ aesMul(a1, 14) ^ aesMul(a2, 11) ^ aesMul(a3, 13);
        s[4 * c + 2] = aesMul(a0, 13) ^ aesMul(a1, 9) ^ aesMul(a2, 14) ^ aesMul(a3, 11);
        s[4 * c + 3] = aesMul(a0, 11) ^ aesMul(a1, 13) ^ aesMul(a2, 9) ^ aesMul(a3, 14);
      }
    }
  }
  return s;
}

function utf8Bytes(text) {
  return new TextEncoder().encode(String(text));
}

function bytesToUtf8(bytes) {
  return new TextDecoder().decode(bytes);
}

function bytesToB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function bytesToHex(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

function b64Bytes(b64) {
  const bin = atob(String(b64).replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function pkcs7Pad(data) {
  const pad = 16 - (data.length % 16);
  const out = new Uint8Array(data.length + pad);
  out.set(data);
  out.fill(pad, data.length);
  return out;
}

// key/iv 都是字符串，按 UTF-8 取字节。
function cbcEncrypt(key, iv, data) {
  const rk = aesExpandKey(utf8Bytes(key));
  const buf = pkcs7Pad(data);
  const out = new Uint8Array(buf.length);
  let prev = utf8Bytes(iv);
  for (let o = 0; o < buf.length; o += 16) {
    const block = new Uint8Array(16);
    for (let i = 0; i < 16; i++) block[i] = buf[o + i] ^ prev[i];
    prev = aesEncryptBlock(rk, block);
    out.set(prev, o);
  }
  return out;
}

function cbcDecrypt(key, iv, data) {
  const rk = aesExpandKey(utf8Bytes(key));
  const out = new Uint8Array(data.length);
  let prev = utf8Bytes(iv);
  for (let o = 0; o < data.length; o += 16) {
    const block = Uint8Array.from(data.subarray(o, o + 16));
    const dec = aesDecryptBlock(rk, block);
    for (let i = 0; i < 16; i++) out[o + i] = dec[i] ^ prev[i];
    prev = block;
  }
  const pad = out[out.length - 1];
  if (pad >= 1 && pad <= 16 && pad <= out.length) return out.subarray(0, out.length - pad);
  return out;
}

// 概念版的 RSA 公钥（1024 位），云歌单的参数 p 要用它加密。
const LITE_RSA_PUB = 'MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDECi0Np2UR87scwrvTr72L6oO01rBbbBPriSDFPxr3Z5syug0O24QyQO8bg27+0+4kBzTBTBOZ/WWU0WryL1JSXRTXLgFVxtzIY41Pe7lPOgsfTCn5kZcvKhYKJesKnnJDNr5/abvTGf+rHG3YRwsCHcQ08/q6ifSioBszvb3QiwIDAQAB';

function derRead(bytes, off) {
  let len = bytes[off + 1];
  let start = off + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + bytes[start + i];
    start += n;
  }
  return { tag: bytes[off], start, end: start + len };
}

function bytesToBig(bytes) {
  let v = 0n;
  for (let i = 0; i < bytes.length; i++) v = (v << 8n) | BigInt(bytes[i]);
  return v;
}

let liteRsaKey = null;

function liteRsa() {
  if (liteRsaKey) return liteRsaKey;
  const der = b64Bytes(LITE_RSA_PUB);
  const outer = derRead(der, 0);          // SEQUENCE
  const alg = derRead(der, outer.start);  // SEQUENCE (algorithm)
  const bits = derRead(der, alg.end);     // BIT STRING
  const inner = derRead(der, bits.start + 1); // 跳过 unused-bits 字节
  const nTlv = derRead(der, inner.start);
  const eTlv = derRead(der, nTlv.end);
  let n = der.subarray(nTlv.start, nTlv.end);
  // INTEGER 是正数时会补一个 0x00，去掉它才是模长的真实字节数。
  while (n.length > 1 && n[0] === 0) n = n.subarray(1);
  liteRsaKey = { n: bytesToBig(n), e: bytesToBig(der.subarray(eTlv.start, eTlv.end)), size: n.length };
  return liteRsaKey;
}

function modPow(base, exp, mod) {
  let result = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
}

// RSAES-PKCS1-v1_5，返回大写 hex。
function rsaPkcs1Hex(msg) {
  const k = liteRsa();
  const msgBytes = msg instanceof Uint8Array ? msg : utf8Bytes(msg);
  if (msgBytes.length > k.size - 11) throw new Error('rsa message too long');
  const psLen = k.size - 3 - msgBytes.length;
  const em = new Uint8Array(k.size);
  em[0] = 0x00;
  em[1] = 0x02;
  for (let i = 0; i < psLen; i++) em[2 + i] = Math.floor(Math.random() * 255) + 1;
  em[2 + psLen] = 0x00;
  em.set(msgBytes, 3 + psLen);
  return modPow(bytesToBig(em), k.e, k.n).toString(16).padStart(k.size * 2, '0').toUpperCase();
}

// 关注歌手那族接口：随机 16 位当种子，MD5 后 32 位当 AES-256 key、后 16 位当 iv。
function aesHexKey(text) {
  const tempKey = randStr(16).toLowerCase();
  const key = md5(tempKey).slice(0, 32);
  const iv = key.slice(16);
  return { key: tempKey, hex: bytesToHex(cbcEncrypt(key, iv, utf8Bytes(text))) };
}

function okRes(r) {
  return !!(r && r.json && (r.json.status === 1 || (r.json.data && r.json.data.status === 1)));
}

/**
 * 调一次酷狗接口。

 * base/router 按逆向出来的各接口归属主机来填；keyHash 用于 /v5/url 的 key。
 */
async function api(path, opt) {
  const o = Object.assign(
    {
      base: 'https://gateway.kugou.com', method: 'GET', params: {}, router: '', headers: {},
      keyHash: '', web: false, data: undefined, bodyBytes: null, b64Body: '', rawBody: '',
      noSign: false, decrypt: null,
    },
    opt || {},
  );
  const p = Object.assign(baseParams(), o.params || {});
  // 云歌单那一族要发密文：要么是原始字节（bodyBytes），要么是密文的 base64 文本（b64Body）。
  let body = '';
  let send;
  if (o.bodyBytes) send = o.bodyBytes;
  else if (o.b64Body) { body = o.b64Body; send = body; }
  else if (o.rawBody) { body = o.rawBody; send = body; }
  else if (o.data !== undefined) { body = JSON.stringify(o.data); send = body; }
  if (o.keyHash) {
    p.key = md5(String(o.keyHash).toLowerCase() + PLAY_SECRET + String(p.appid) + String(p.mid) + String(p.userid || 0));
  }
  // 发原始字节时签名要把字节一起算进去，宿主只给 md5(文本)，所以那条路直接不签名。
  if (!o.noSign) p.signature = signWith(p, o.web ? SALT_WEB : SALT_LITE, body);
  const headers = Object.assign({
    'User-Agent': UA,
    dfid: String(p.dfid),
    mid: String(p.mid),
    clienttime: String(p.clienttime),
    'kg-rc': '1',
    'kg-thash': '5d816a0',
    'kg-rec': '1',
    'kg-rf': 'B9EDA08A64250DEFFBCADDEE00F8F25F',
  }, o.headers || {});
  if (o.router) headers['x-router'] = o.router;
  if (body) headers['content-type'] = 'application/json';
  if (o.bodyBytes) headers['content-type'] = 'application/json;charset=utf-8';
  const url = o.base + path + '?' + qs(p);
  const res = await fetch(url, { method: o.method, headers, body: send });
  let text;
  if (o.decrypt) {
    // 响应也是密文，用同一个 key/iv 解；解不开就当明文读。
    const bytes = new Uint8Array(await res.arrayBuffer());
    text = '';
    if (bytes.length && bytes.length % 16 === 0) {
      try { text = bytesToUtf8(cbcDecrypt(o.decrypt.key, o.decrypt.iv, bytes)); } catch (e) { text = ''; }
    }
    if (!text) text = bytesToUtf8(bytes);
  } else {
    text = await res.text();
  }
  let json = null;
  try { json = JSON.parse(text); } catch (e) { json = null; }
  return { status: res.status, json, text };
}

// 把各种失败都变成一句人话；code 让界面能弹「先登录」。
function fail(message, code) {
  const e = new Error(message);
  if (code) e.code = code;
  return e;
}

function pick(obj, ...keys) {
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

function img(url, size) {
  const s = url === undefined || url === null ? '' : String(url);
  if (!s) return '';
  return s.replace('{size}', String(size || 400)).replace(/^http:/, 'https:');
}

// ── 数据归一：酷狗各接口的曲目字段完全不一样，这里统一 ─────
function trackArtists(raw) {
  const out = [];
  const add = (id, name, image) => {
    const n = String(name === undefined || name === null ? '' : name).trim();
    if (!n) return;
    if (out.some((a) => a.name === n)) return;
    const aid = String(id === undefined || id === null ? '' : id);
    out.push({ id: aid && aid !== '0' ? aid : n, name: n, imageUrl: img(image, 240) });
  };
  for (const a of raw.authors || []) add(a.author_id, a.author_name, a.sizable_avatar);
  if (!out.length) for (const a of raw.singerinfo || []) add(a.id || a.singerid, a.name || a.singername, a.avatar);
  if (!out.length) for (const a of raw.Singers || []) add(a.id, a.name, a.img);
  if (!out.length) {
    const names = String(pick(raw, 'author_name', 'SingerName', 'singername') || '');
    for (const n of names.split(/[、,，/&]|\s+feat\.?\s+/i)) add('', n);
  }
  return out;
}

function trackDuration(raw, info) {
  const values = [info.duration, raw.timelen, raw.timelength, raw.time_length, raw.Duration, raw.duration];
  for (const v of values) {
    const n = Number(v || 0);
    if (n > 0) return n > 10000 ? Math.round(n) : Math.round(n * 1000);
  }
  return 0;
}

// 曲目 id：hash|albumId|albumAudioId|时长秒。
function trackId(hash, albumId, audioId, duration) {
  return hash + '|' + albumId + '|' + audioId + '|' + Math.round((duration || 0) / 1000);
}

function parseId(id) {
  const p = String(id).split('|');
  return {
    hash: String(p[0] || ''),
    albumId: Number(p[1] || 0),
    audioId: Number(p[2] || 0),
    seconds: Number(p[3] || 0),
  };
}

// 记住 hash → 曲名，收藏时要回传给酷狗，不然「我喜欢」里是空标题。
const TRACK_META = new Map();

function toTrack(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const info = raw.audio_info || {};
  const base = raw.base || {};
  const albumInfo = raw.album_info || {};
  const trans = raw.trans_param || raw.TransParam || raw.transParam || {};
  const hash = String(
    pick(raw, 'hash', 'FileHash', 'filehash') ||
    pick(info, 'hash', 'hash_128', 'hash_320') ||
    pick(base, 'hash') ||
    pick(raw, 'hash_128', 'hash_320', 'hash_flac') ||
    '',
  ).toLowerCase();
  if (!hash) return null;
  const name = String(
    pick(raw, 'songname', 'SongName', 'name', 'audio_name', 'ori_audio_name', 'filename') ||
    pick(base, 'audio_name') ||
    '',
  ).trim();
  if (!name) return null;
  const albumId = Number(pick(raw, 'album_id', 'AlbumID', 'albumid') || pick(base, 'album_id') || 0);
  const audioId = Number(
    pick(raw, 'album_audio_id', 'Audioid', 'audio_id', 'mixsongid', 'mixsong_id') ||
    pick(base, 'album_audio_id', 'audio_id') ||
    0,
  );
  const duration = trackDuration(raw, info);
  const albumName = String(pick(raw, 'album_name', 'AlbumName', 'albumname') || pick(albumInfo, 'album_name') || '');
  const albumCover = pick(albumInfo, 'cover', 'sizable_cover') ||
    pick(raw, 'sizable_cover', 'Image', 'AlbumImage', 'img', 'cover') ||
    pick(trans, 'union_cover');
  const added = raw.collecttime ? new Date(Number(raw.collecttime) * 1000).toISOString() : '';
  if (TRACK_META.size > 2000) TRACK_META.clear();
  TRACK_META.set(hash, name);
  return {
    id: trackId(hash, albumId, audioId, duration),
    name,
    artists: trackArtists(raw),
    album: { id: String(albumId || ''), name: albumName, imageUrl: img(albumCover, 400) },
    duration,
    url: 'https://www.kugou.com/song/#hash=' + hash + '&album_id=' + albumId,
    added,
  };
}

function toTracks(list) {
  const out = [];
  for (const raw of list || []) {
    const t = toTrack(raw);
    if (t) out.push(t);
  }
  return out;
}

function toAlbum(raw) {
  const cover = pick(raw, 'sizable_cover', 'cover', 'img', 'Image', 'album_cover') || pick(raw.album_info || {}, 'cover');
  const artists = [];
  for (const a of raw.authors || []) {
    artists.push({ id: String(a.author_id || a.author_name), name: String(a.author_name || ''), imageUrl: img(a.sizable_avatar, 240) });
  }
  // 搜索回来的专辑里 singerid 恒为 "0"，这时用名字当 id，点进歌手页会走名字搜索。
  if (!artists.length && raw.singer) {
    const sid = String(raw.singerid || '');
    artists.push({ id: sid && sid !== '0' ? sid : String(raw.singer), name: String(raw.singer) });
  }
  const id = pick(raw, 'album_id', 'AlbumID', 'albumid', 'id');
  return {
    id: String(id === undefined ? '' : id),
    name: String(pick(raw, 'album_name', 'AlbumName', 'albumname', 'name') || ''),
    imageUrl: img(cover, 400),
    artists,
    released: String(pick(raw, 'publish_date', 'publish_time', 'PublishDate') || ''),
    trackCount: Number(pick(raw, 'songcount', 'song_count', 'track_count') || 0),
    kind: 'album',
  };
}

function toArtist(raw) {
  const id = pick(raw, 'author_id', 'AuthorId', 'singerid', 'id');
  return {
    id: String(id === undefined ? '' : id),
    name: String(pick(raw, 'author_name', 'AuthorName', 'SingerName', 'name') || ''),
    imageUrl: img(pick(raw, 'sizable_avatar', 'Avatar', 'img', 'avatar'), 240),
    following: false,
  };
}

function toPlaylist(raw) {
  const gid = String(pick(raw, 'global_collection_id', 'parent_global_collection_id', 'gid') || '');
  const listid = pick(raw, 'listid', 'list_create_listid', 'specialid');
  const userid = pick(raw, 'list_create_userid', 'suid', 'userid') || auth().userid;
  const id = gid || ('collection_3_' + userid + '_' + (listid === undefined ? 0 : listid) + '_0');
  return {
    id,
    name: String(pick(raw, 'name', 'specialname', 'listname', 'title') || ''),
    imageUrl: img(pick(raw, 'pic', 'img', 'cover', 'sizable_cover'), 400),
    description: String(pick(raw, 'intro', 'description') || ''),
    owner: String(pick(raw, 'list_create_username', 'nickname', 'singername') || ''),
    subtitle: '',
    trackCount: Number(pick(raw, 'count', 'song_count', 'songcount', 'percount') || 0),
    plays: Number(pick(raw, 'playcount', 'play_count', 'total_play_count', 'play_times') || 0),
    // 酷狗对自建歌单也常给 is_mine=0，所以按「type=0 且创建者是自己」判。
    mine: Number(raw.is_mine || 0) === 1 ||
      (Number(raw.type || 0) === 0 && String(pick(raw, 'list_create_userid', 'suid') || '') === auth().userid),
    saved: false,
    fixed: false,
    tracks: [],
  };
}

// ── 接口封装 ──────────────────────────────────────────────
async function searchSongs(keyword, page, pagesize) {
  const r = await api('/v2/search/song', {
    base: 'https://complexsearch.kugou.com',
    router: 'complexsearch.kugou.com',
    params: {
      keyword, page, pagesize,
      platform: 'AndroidFilter', iscorrection: 1, privilegefilter: 0, area_code: 1, dopicfull: 1, clientver: 201,
    },
  });
  const data = (r.json && r.json.data) || {};
  return { lists: data.lists || [], total: Number(data.total || 0) };
}

async function searchAlbums(keyword, page, pagesize) {
  const r = await api('/v1/search/album', {
    base: 'https://complexsearch.kugou.com',
    router: 'complexsearch.kugou.com',
    params: { albumhide: 0, iscorrection: 1, keyword, nocollect: 0, page, pagesize, platform: 'AndroidFilter' },
  });
  const data = (r.json && r.json.data) || {};
  return { lists: data.lists || [], total: Number(data.total || 0) };
}

async function searchArtists(keyword, page, pagesize) {
  const r = await api('/v1/search/author', {
    base: 'https://complexsearch.kugou.com',
    router: 'complexsearch.kugou.com',
    params: { albumhide: 0, iscorrection: 1, keyword, nocollect: 0, page, pagesize, platform: 'AndroidFilter' },
  });
  const data = (r.json && r.json.data) || {};
  return { lists: data.lists || [], total: Number(data.total || 0) };
}

async function searchPlaylists(keyword, page, pagesize) {
  const r = await api('/v1/search/special', {
    base: 'https://complexsearch.kugou.com',
    router: 'complexsearch.kugou.com',
    params: { albumhide: 0, iscorrection: 1, keyword, nocollect: 0, page, pagesize, platform: 'AndroidFilter' },
  });
  const data = (r.json && r.json.data) || {};
  return { lists: data.lists || [], total: Number(data.total || 0) };
}

async function albumInfo(id) {
  const r = await api('/kmr/v2/albums', {
    method: 'POST',
    router: 'openapi.kugou.com',
    headers: { 'kg-tid': '255' },
    data: {
      data: [{ album_id: Number(id) || id }],
      is_buy: 0,
      fields: 'album_id,album_name,publish_date,sizable_cover,intro,language,is_publish,heat,type,quality,authors,exclusive,author_name,trans_param',
    },
  });
  const data = (r.json && r.json.data) || [];
  return Array.isArray(data) ? data[0] || {} : data;
}

async function albumSongs(id, page, pagesize) {
  const r = await api('/v1/album_audio/lite', {
    method: 'POST',
    router: 'openapi.kugou.com',
    headers: { 'kg-tid': '255' },
    data: { album_id: Number(id) || id, is_buy: '', page, pagesize },
  });
  const data = (r.json && r.json.data) || {};
  return { songs: toTracks(data.songs || []), total: Number(data.total || (data.songs || []).length) };
}

async function artistInfo(id) {
  const r = await api('/kmr/v3/author', {
    method: 'POST',
    router: 'openapi.kugou.com',
    headers: { 'kg-tid': '36' },
    data: { author_id: Number(id) || id },
  });
  return (r.json && r.json.data) || {};
}

async function artistSongs(id, page, pagesize, sort) {
  const clienttime = Math.floor(Date.now() / 1000);
  const r = await api('/kmr/v1/audio_group/author', {
    method: 'POST',
    router: 'openapi.kugou.com',
    headers: { 'kg-tid': '220' },
    data: {
      appid: Number(APPID),
      clientver: Number(CLIENTVER),
      mid: mid(),
      clienttime,
      key: md5(APPID + SALT_LITE + CLIENTVER + clienttime),
      author_id: Number(id) || id,
      pagesize,
      page,
      sort: sort === 'new' ? 2 : 1,
      area_code: 'all',
    },
  });
  const data = (r.json && r.json.data) || [];
  const list = Array.isArray(data) ? data : data.list || data.info || [];
  const songs = toTracks(list);
  // 这个接口的条目里没有歌手 id，只有名字；按当前歌手页补一句，免得点歌手又走搜索。
  const me = String(id);
  for (const s of songs) {
    if (s.artists.length === 1 && !/^\d+$/.test(s.artists[0].id)) s.artists[0].id = me;
  }
  return { songs, total: list.length };
}

async function artistAlbums(id, page, pagesize) {
  const r = await api('/kmr/v1/author/albums', {
    method: 'POST',
    router: 'openapi.kugou.com',
    headers: { 'kg-tid': '36' },
    data: { author_id: Number(id) || id, pagesize, page, sort: 1, category: 1, area_code: 'all' },
  });
  const data = (r.json && r.json.data) || [];
  const list = Array.isArray(data) ? data : data.list || data.info || [];
  return list.map(toAlbum);
}

async function listInfo(gid) {
  const a = auth();
  const r = await api('/v3/get_list_info', {
    method: 'POST',
    router: 'pubsongs.kugou.com',
    data: { data: [{ global_collection_id: gid }], userid: Number(a.userid) || 0, token: a.token },
  });
  const data = (r.json && r.json.data) || [];
  const one = Array.isArray(data) ? data[0] : data;
  return one || {};
}

// 歌单里的歌：一页最多 300 首，begin_idx 是「已拿到的条数」。
async function listTracks(gid, begin, pagesize) {
  // 这个接口不能带 x-router，带了网关就 404。
  const r = await api('/pubsongs/v2/get_other_list_file_nofilt', {
    params: {
      area_code: 1,
      begin_idx: begin,
      plat: 1,
      type: 1,
      mode: 1,
      personal_switch: 1,
      extend_fields: 'abtags,hot_cmt,popularization',
      pagesize,
      global_collection_id: gid,
    },
  });
  const data = (r.json && r.json.data) || {};
  const raw = data.songs || [];
  // raw 里有已下架的占位条目，翻页要用原始条数推进，不能用转换后的条数。
  return { songs: toTracks(raw), raw: raw.length, count: Number(data.count || 0) };
}

async function loadListTracks(gid, limit) {
  const max = limit || 6;
  const out = [];
  let count = 0;
  let begin = 0;
  for (let i = 0; i < max; i++) {
    const page = await listTracks(gid, begin, TRACK_PAGE);
    count = page.count || count;
    out.push(...page.songs);
    begin += page.raw;
    if (!page.raw || (count && begin >= count)) break;
  }
  return { tracks: out, total: count || out.length };
}

async function rankList() {
  const r = await api('/ocean/v6/rank/list', { params: { plat: 2, withsong: 1, parentid: 0 } });
  const info = ((r.json && r.json.data) || {}).info || [];
  return info.map((x) => ({
    id: String(x.rankid || x.id),
    name: String(x.rankname || ''),
    imageUrl: img(x.banner_9 || x.img_9 || x.album_img_9 || x.imgurl, 400),
    trackCount: Number(x.songinfo ? (x.songinfo.count || 0) : 0),
    plays: Number(x.play_times || 0),
    description: String(x.intro || ''),
  }));
}

async function rankSongs(rankId, page, pagesize) {
  const r = await api('/openapi/kmr/v2/rank/audio', {
    method: 'POST',
    headers: { 'kg-tid': '369' },
    data: {
      show_portrait_mv: 1, show_type_total: 1, filter_original_remarks: 1,
      area_code: 1, pagesize, rank_cid: 0, type: 1, page, rank_id: Number(rankId) || rankId,
    },
  });
  const data = (r.json && r.json.data) || {};
  return { songs: toTracks(data.songlist || []), total: Number(data.total || (data.songlist || []).length) };
}

async function dailySongs() {
  const a = auth();
  const r = await api('/everyday_song_recommend', {
    method: 'POST',
    router: 'everydayrec.service.kugou.com',
    data: { platform: 'android', userid: Number(a.userid) || 0 },
  });
  const data = (r.json && r.json.data) || {};
  return { tracks: toTracks(data.song_list || []), cover: img(data.cover_img_url, 600) };
}

async function myPlaylists() {
  const a = auth();
  const all = await allLists(true);
  return all.lists.map((x) => {
    const p = toPlaylist(x);
    // 歌单 id 一律用自己这一侧的 listid，写操作（改名/删除/加歌）都靠它定位。
    p.id = 'collection_3_' + a.userid + '_' + Number(x.listid || 0) + '_0';
    p.trackCount = Number(pick(x, 'count', 'm_count', 'song_count') || 0);
    // 自己建的（type=0）算「我的」，收藏来的（type=1）归到「收藏」。
    p.mine = Number(x.type || 0) === 0;
    return p;
  }).filter((p) => p.name);
}

async function specialRecommend(page, pagesize) {
  const clienttime = String(Math.floor(Date.now() / 1000));
  const r = await api('/v2/special_recommend', {
    method: 'POST',
    router: 'specialrec.service.kugou.com',
    data: {
      appid: Number(APPID),
      mid: mid(),
      clientver: Number(CLIENTVER),
      platform: 'android',
      clienttime,
      userid: Number(auth().userid) || 0,
      module_id: 1,
      page,
      pagesize,
      key: md5(APPID + SALT_LITE + CLIENTVER + clienttime),
      special_recommend: { withtag: 1, withsong: 1, sort: 1, ugc: 1, is_selected: 0, withrecommend: 1, area_code: 1, categoryid: 0 },
      req_multi: 1,
      retrun_min: 5,
      return_special_falg: 1,
    },
  });
  const data = (r.json && r.json.data) || {};
  return (data.special_list || []).map((x) => {
    const p = toPlaylist(x);
    if (x.specialid && !p.id) p.id = 'special:' + x.specialid;
    return p;
  }).filter((p) => p.id && p.name);
}

// 取流。quality 是应用给的 standard/high/lossless。
const QUALITY_CHAIN = {
  standard: ['128'],
  high: ['320', '128'],
  lossless: ['flac', '320', '128'],
};

function qualityLabel(bitRate, ext) {
  if (/flac|ape|wav/i.test(ext || '')) return 'lossless';
  if (bitRate >= 900000) return 'lossless';
  if (bitRate >= 256000) return 'high';
  return 'standard';
}

async function songUrl(hash, albumId, audioId, quality) {
  const chain = QUALITY_CHAIN[quality] || QUALITY_CHAIN.high;
  const h = String(hash).toLowerCase();
  let lastError = '';
  let needSignIn = false;
  let needVip = false;
  // 酷狗 CDN 会按请求方 IP 所在地区做校验：签出来的地址里 ct 段是签出地
  // （如 ct440100 = 广州），来源 IP 对不上就回 404。这种失败和会员无关，
  // 报成「需要会员」会误导人，所以单独记一个标记。
  let cdnBlocked = false;
  // 另一类失败：签名正常、地址也给了，但请求根本没连上（网络抖动/代理抽风）。
  let netBroken = false;

  // 一路：概念版 /v5/url。地址多在 fs.youthandroid*.kugou.com，只认 http。
  for (const q of chain) {
    const r = await api('/v5/url', {
      router: 'trackercdn.kugou.com',
      keyHash: h,
      params: {
        // 带上专辑 id 反而会被降级成 128 的备份流，所以这两个固定传 0。
        album_id: 0,
        area_code: 1,
        hash: h,
        ssa_flag: 'is_fromtrack',
        version: 11430,
        page_id: 967177915,
        quality: q,
        album_audio_id: 0,
        behavior: 'play',
        pid: 411,
        cmd: 26,
        pidversion: 3001,
        IsFreePart: 0,
        // 收藏页标记：有些歌从「我喜欢」里能解锁。
        ppage_id: '356753938,823673182,967485191',
        cdnBackup: 1,
        module: '',
        clientver: 11430,
      },
    });
    const d = (r.json && (r.json.data || r.json)) || {};
    const errcode = Number(d.errcode !== undefined ? d.errcode : (r.json && r.json.errcode) || 0);
    const urls = allUrls(d);
    let sawDenied = false;
    let sawNetErr = false;
    for (const u of urls) {
      const st = await probe(u);
      if (st === 'ok') return streamOf(u, d);
      if (st === 'denied') sawDenied = true;
      else sawNetErr = true;
    }
    if (urls.length) {
      // 全是「没连上」时是网络问题，不能算 CDN 地区拦截。
      cdnBlocked = sawDenied && !sawNetErr;
      if (sawNetErr && !sawDenied) netBroken = true;
      lastError = T('取到的播放地址打不开');
    }
    if (errcode === 20028 || errcode === 20029) needSignIn = true;
    if (Number(d.status) === 2 || Number(d.error_code) === 20018) needVip = true;
    // 不能无条件覆盖：上面刚写进去的「地址打不开」是有用信息。
    const msg = String(d.error || (r.json && r.json.error) || d.errmsg || '');
    if (msg) lastError = msg;
  }

  // 二路：老 tracker（pid=409 + appid=1000）。它给的是 sharefs.kugou.com，
  // 证书正常，https 可用；v5 抽风时这条路通常还在。
  for (const q of chain) {
    const bits = q === '128' ? 128000 : q === '320' ? 320000 : 0;
    const d = await httpJson(
      'https://trackercdn.kugou.com/i/v2/?cmd=25&hash=' + h +
      '&key=' + md5(h + 'kgcloudv2') +
      '&pid=409&behavior=play&appid=1000&clientver=' + CLIENTVER +
      (bits ? '&bitrate=' + bits : ''),
    );
    if (!d) continue;
    for (const u of allUrls(d)) {
      if (await playable(u)) return streamOf(u, d);
    }
    if (Number(d.status) === 2) needVip = true;
  }

  // 三路：移动端 playInfo，匿名可取，只给免费曲。
  const m = await httpJson('https://m.kugou.com/app/i/getSongInfo.php?cmd=playInfo&hash=' + h.toUpperCase());
  if (m) {
    if (m.url) return streamOf(String(m.url), m);
    if (m.error && /付费|会员/.test(String(m.error))) needVip = true;
  }

  if (!loggedIn() || needSignIn) {
    throw fail(T('该曲目需要登录酷狗账号才能播放'), 'signIn');
  }
  // 地址签出来了但读不到，说明是 CDN 那边按地区拦的，跟会员无关。
  if (cdnBlocked) {
    throw fail(
      T('酷狗给了播放地址但拒绝下发（404）。这类地址会校验请求方所在地区，' +
        '通常是因为网络出口不在国内或与歌曲地区不一致，换个网络再试。'),
      'unavailable',
    );
  }
  if (netBroken) {
    throw fail(
      T('连不上酷狗的文件服务器（地址签发正常，但下载请求失败）。' +
        '多为网络波动或代理不稳，稍后再试。'),
      'unavailable',
    );
  }
  if (needVip) {
    throw fail(T('该曲目需要酷狗会员，当前账号没有播放权限'), 'unavailable');
  }
  throw fail(lastError || T('酷狗没有给出这首歌的播放地址'), 'unavailable');
}

// 取到的地址先探一下能不能读，读不了就走下一条路（酷狗 CDN 会抽风给死链）。
// 探测结果分三种：ok 能用、denied 连上了但被拒、neterr 根本没连上。
// 「被拒」是 CDN 侧的地区校验，重试没用；「没连上」多半是网络抖动，重试一次常常就好。
async function probe(url) {
  for (let i = 0; i < 2; i++) {
    try {
      const res = await fetch(url, { headers: { Range: 'bytes=0-1' } });
      if (res.status === 200 || res.status === 206) return 'ok';
      return 'denied';
    } catch (e) {
      if (i === 0) await sleep(200);
    }
  }
  return 'neterr';
}

async function playable(url) {
  return (await probe(url)) === 'ok';
}

function firstUrl(u) {
  if (Array.isArray(u)) return String(u[0] || '');
  return u ? String(u) : '';
}

// 酷狗一次会给主地址加几个备份地址，主机和 ct 段可能不一样，
// 挨个试比只试第一个成功率明显高。
function allUrls(d) {
  const out = [];
  const push = (u) => {
    if (Array.isArray(u)) {
      for (const x of u) push(x);
      return;
    }
    const s = u ? String(u) : '';
    if (s && out.indexOf(s) < 0) out.push(s);
  };
  if (!d) return out;
  push(d.url);
  push(d.backupUrl);
  push(d.backup_url);
  return out;
}

// 把取流结果拼成宿主认识的 AudioStream。
function streamOf(url, d) {
  const ext = String((d && (d.extName || d.extname)) || 'mp3').toLowerCase();
  const bitRate = Number((d && (d.bitRate || d.bitrate)) || 0);
  return {
    // 酷狗 CDN 只认 http：换成 https 会 403，且 fs.youthandroid* 的证书是错的。
    url: String(url),
    type: ext,
    quality: qualityLabel(bitRate, ext),
    bitRate,
    size: Number((d && (d.fileSize || d.filesize)) || 0),
    headers: {},
  };
}
// 歌词接口不走签名，直接 GET。
async function httpJson(url) {
  // 这里的几个地址都是「备用路」，连不上就直接当没有，不要让它把
  // 主路已经攒好的错误信息盖掉（否则用户只会看到一句 fetch failed）。
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const text = await res.text();
    try { return JSON.parse(text); } catch (e) { return null; }
  } catch (e) {
    return null;
  }
}

function b64ToText(b64) {
  const bin = atob(String(b64).replace(/\s+/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// LRC → 逐行（含结束时间）。一行里可能有多个时间戳。
function parseLrc(text) {
  const rows = [];
  const stamp = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const times = [];
    let m;
    stamp.lastIndex = 0;
    while ((m = stamp.exec(line))) {
      const min = Number(m[1]);
      const sec = Number(m[2]);
      const frac = m[3] ? Number(m[3].padEnd(3, '0')) : 0;
      times.push(min * 60000 + sec * 1000 + frac);
    }
    if (!times.length) continue;
    const content = line.replace(stamp, '').trim();
    for (const t of times) rows.push({ start: t, text: content });
  }
  rows.sort((a, b) => a.start - b.start);
  const lines = [];
  for (let i = 0; i < rows.length; i++) {
    const end = i + 1 < rows.length ? rows[i + 1].start : rows[i].start + 4000;
    lines.push({ start: rows[i].start, end, text: rows[i].text, words: [] });
  }
  return lines;
}

// ── 每日会员签到 ──────────────────────────────────────────
// 酷狗概念版的签到其实是两件事：先领「每日畅听 VIP」，再领「升级概念版奖励」。
// MoeKoe 里那两条 /youth/day/vip 只是它本地 express 服务起的别名，真实接口是
// /youth/v1/recharge/receive_vip_listen_song 与 /youth/v1/listen_song/upgrade_vip_reward。
const CHECKIN_GAP = 15 * 60 * 1000;
const CHECKIN_KEY = 'checkin';

function pad2(n) {
  return (n < 10 ? '0' : '') + String(n);
}

// 用接口回的 server_time（秒）算「今天」，免得本机时区把日期算错。
function dayOf(sec) {
  const n = Number(sec || 0);
  if (!n) {
    const d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  const d = new Date((n + 8 * 3600) * 1000);
  return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
}

// 本月签到记录：data.list[] 每项 { day, receive_vip, vip_type }。
async function monthRecord() {
  const r = await api('/youth/v1/activity/get_month_vip_record', { params: { latest_limit: 100 } });
  const j = r.json || {};
  if (Number(j.error_code || 0) === 20002) throw fail(T('请先登录酷狗账号'), 'signIn');
  return j.data || {};
}

// 概念版会员状态：顶层 is_vip / vip_end_time 是过期的旧字段，要看 busi_vip[] 里
// busi_type=concept 且 product_type=svip 那条。
async function unionVip() {
  const r = await api('/v1/get_union_vip', {
    base: 'https://kugouvip.kugou.com',
    params: { busi_type: 'concept', opt_product_types: 'dvip,qvip', product_type: 'svip' },
  });
  const d = (r.json && r.json.data) || {};
  const list = Array.isArray(d.busi_vip) ? d.busi_vip : [];
  let item = list.filter((x) => x && x.busi_type === 'concept' && x.product_type === 'svip')[0];
  if (!item) item = list.filter((x) => x && x.product_type === 'svip')[0];
  if (!item) return { vip: false, end: '' };
  return { vip: Number(item.is_vip || 0) === 1, end: String(item.vip_end_time || '') };
}

// 领今天的每日 VIP。131001 = 今天已经领过。
async function receiveDaily(day) {
  const r = await api('/youth/v1/recharge/receive_vip_listen_song', {
    method: 'POST',
    params: { source_id: 90139, receive_day: day },
  });
  const j = r.json || {};
  return { ok: Number(j.status || 0) === 1, code: Number(j.error_code || 0), msg: String(j.error_msg || '') };
}

// 领升级概念版的奖励。297002 = 今天已经领过。
async function receiveUpgrade() {
  const r = await api('/youth/v1/listen_song/upgrade_vip_reward', {
    method: 'POST',
    params: { kugouid: Number(auth().userid) || 0, ad_type: 1 },
  });
  const j = r.json || {};
  return { ok: Number(j.status || 0) === 1, code: Number(j.error_code || 0), msg: String(j.error_msg || '') };
}

let checkinCache = Object.assign({ at: 0, day: '', signed: false, days: 0, vip: false, end: '', claimed: false }, load(CHECKIN_KEY, {}) || {});
let checkinBusy = null;

/**
 * 查一次签到状态，没签就签。
 * force=false 时命中 15 分钟缓存，定时器和各页面共用一份结果。
 */
async function runCheckin(force) {
  if (!loggedIn()) return null;
  if (!force && checkinCache.at && Date.now() - checkinCache.at < CHECKIN_GAP) return checkinCache;
  if (checkinBusy) return checkinBusy;
  checkinBusy = (async () => {
    const rec = await monthRecord();
    const day = dayOf(rec.server_time);
    const month = String(rec.month || day.slice(0, 7));
    const list = Array.isArray(rec.list) ? rec.list : [];
    const days = list.filter((x) => x && String(x.day || '').slice(0, 7) === month).length;
    const today = list.filter((x) => x && String(x.day || '') === day).length > 0;
    let signed = today;
    let claimed = false;
    if (!signed) {
      const a = await receiveDaily(day);
      // 131001 是「今天已经领过」（比如在手机 App 上签的），照样算已签到。
      signed = a.ok || a.code === 131001;
      if (a.ok) {
        claimed = true;
        await sleep(500);
        await receiveUpgrade().catch(() => {});
      }
    }
    const v = await unionVip().catch(() => ({ vip: false, end: '' }));
    checkinCache = {
      at: Date.now(),
      day,
      signed,
      days: claimed ? days + 1 : days,
      vip: v.vip,
      end: v.end,
      claimed,
    };
    try { save(CHECKIN_KEY, checkinCache); } catch (e) { /* 存不下不影响签到 */ }
    if (claimed) console.log('kugou-lite: 已领取 ' + day + ' 的每日会员');
    return checkinCache;
  })();
  try {
    return await checkinBusy;
  } catch (e) {
    throw e;
  } finally {
    checkinBusy = null;
  }
}

function autoCheckinOn() {
  try { return String(host.setting('autoCheckin')) === 'true'; } catch (e) { return true; }
}

// 应用启动后补一次，之后每 15 分钟查一次。插件只在应用运行时活着，关掉应用就停。
setTimeout(() => {
  if (!autoCheckinOn()) return;
  runCheckin(true).catch((e) => console.error('kugou-lite checkin: ' + ((e && e.message) || e)));
}, 8 * 1000);
setInterval(() => {
  if (!autoCheckinOn()) return;
  // 这里是真查，不吃 15 分钟缓存，跨零点后能立刻发现「今天还没签」。
  runCheckin(true).catch((e) => console.error('kugou-lite checkin: ' + ((e && e.message) || e)));
}, CHECKIN_GAP);

// ── 插件接口 ──────────────────────────────────────────────
function likedGid() {
  return 'collection_3_' + auth().userid + '_2_0';
}

export async function account() {
  const a = auth();
  if (!a.token) return null;
  let name = String(load('nickname', ''));
  let avatar = String(load('avatar', ''));
  if (!name) {
    try {
      const info = await listInfo(likedGid());
      name = String(info.list_create_username || '');
      avatar = img(info.create_user_pic, 240);
      if (name) { save('nickname', name); save('avatar', avatar); }
    } catch (e) { /* 拿不到昵称不影响播放 */ }
  }
  return { id: a.userid, name: name || T('酷狗用户'), imageUrl: avatar };
}

export async function signIn() {
  // 1. 取二维码 key
  const qr = await api('/v2/qrcode', {
    base: 'https://login-user.kugou.com',
    web: true,
    params: {
      appid: 1001,
      type: 1,
      plat: 4,
      qrcode_txt: QR_LANDING + '?appid=' + APPID + '&',
      srcappid: SRCAPPID,
    },
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  const key = ((qr.json && qr.json.data) || {}).qrcode;
  if (!key) throw fail(T('酷狗没有返回二维码，请稍后再试'));
  const dev = load('dev', '') || randStr(10);
  save('dev', dev);
  host.signInPrompt({ qr: QR_LANDING + '?qrcode=' + key, text: T('用酷狗 App 扫码登录') });

  // 2. 轮询扫码状态：1 待扫码、2 已扫码、4 成功、0 过期。
  const deadline = Date.now() + 9 * 60 * 1000;
  let scanned = false;
  while (Date.now() < deadline) {
    await sleep(2000);
    const r = await api('/v2/get_userinfo_qrcode', {
      base: 'https://login-user.kugou.com',
      web: true,
      params: { plat: 4, appid: Number(APPID), srcappid: SRCAPPID, qrcode: key, dev },
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    const d = (r.json && r.json.data) || {};
    const status = Number(d.status || 0);
    if (status === 4 && d.token) {
      setAuth(d.token, d.userid);
      try {
        const info = await listInfo('collection_3_' + d.userid + '_2_0');
        if (info.list_create_username) {
          save('nickname', String(info.list_create_username));
          save('avatar', img(info.create_user_pic, 240));
        }
      } catch (e) { /* 昵称稍后再补 */ }
      return await account();
    }
    if (status === 2 && !scanned) {
      scanned = true;
      host.signInPrompt({ qr: QR_LANDING + '?qrcode=' + key, text: T('已扫码，请在手机上确认') });
    }
    if (status === 0) throw fail(T('二维码已过期，请重新登录'), 'signIn');
  }
  throw fail(T('登录超时，请重试'), 'signIn');
}

export async function signOut() {
  clearAuth();
}

export async function profile() {
  if (!loggedIn()) throw fail(T('请先登录酷狗账号'), 'signIn');
  const info = await listInfo(likedGid()).catch(() => ({}));
  const lists = await myPlaylists().catch(() => []);
  const liked = toPlaylist(Object.assign({}, info, { is_mine: 1 }));
  // 签到状态顺手刷一次（15 分钟内直接用缓存），失败不影响资料页。
  const ck = await runCheckin(false).catch(() => null);
  const facts = [];
  if (ck) {
    facts.push({ label: T('本月签到'), value: String(ck.days) + ' ' + T('天') });
    facts.push({ label: T('今日签到'), value: ck.signed ? T('已签到') : T('未签到') });
    if (ck.vip && ck.end) facts.push({ label: T('概念版会员'), value: ck.end.slice(0, 10) + ' ' + T('到期') });
  }
  return {
    name: String(info.list_create_username || load('nickname', '') || T('酷狗用户')),
    imageUrl: img(info.create_user_pic, 240),
    signature: String(info.intro || ''),
    badges: ck && ck.vip ? [T('概念版会员')] : [],
    facts,
    stats: [
      { title: T('歌单'), value: String(lists.length) },
      { title: T('我喜欢'), value: String(liked.trackCount || 0) },
    ],
    playlists: lists,
  };
}

export async function home() {
  const sections = [];

  if (loggedIn()) {
    try {
      const daily = await dailySongs();
      if (daily.tracks.length) {
        sections.push({
          title: T('每日推荐'),
          style: 'modes',
          modes: [{
            title: T('每日推荐'),
            subtitle: T('按你的口味挑的'),
            note: T('每天更新'),
            imageUrl: daily.cover,
            tracks: daily.tracks,
          }],
        });
      }
    } catch (e) { /* 没登录或接口抽风时跳过 */ }
  }

  try {
    const ranks = (await rankList()).slice(0, 4);
    const withSongs = await Promise.all(ranks.map(async (r) => {
      const item = {
        id: 'rank:' + r.id,
        name: r.name,
        imageUrl: r.imageUrl,
        plays: r.plays,
        trackCount: r.trackCount,
        tracks: [],
      };
      try {
        const s = await rankSongs(r.id, 1, 3);
        item.tracks = s.songs;
        item.trackCount = item.trackCount || s.total;
      } catch (e) { /* 某个榜单取不到就只显示卡片 */ }
      return item;
    }));
    if (withSongs.length) sections.push({ title: T('排行榜'), style: 'charts', playlists: withSongs, morePage: 'rank' });
  } catch (e) { /* 忽略 */ }

  try {
    const playlists = await specialRecommend(1, 18);
    if (playlists.length) sections.push({ title: T('推荐歌单'), style: 'grid', playlists, morePage: 'playlist' });
  } catch (e) { /* 忽略 */ }

  return {
    title: T('酷狗音乐'),
    subtitle: loggedIn() ? '' : T('用酷狗 App 扫码登录后可以听每日推荐和「我喜欢」'),
    sections,
  };
}

export async function browse({ page }) {
  const p = String(page || '');
  if (p === 'daily') {
    if (!loggedIn()) throw fail(T('请先登录酷狗账号'), 'signIn');
    const daily = await dailySongs();
    return {
      title: T('每日推荐'),
      subtitle: T('每天更新'),
      imageUrl: daily.cover,
      sections: [{ title: '', style: 'songs', tracks: daily.tracks }],
    };
  }
  if (p === 'playlist') {
    const playlists = await specialRecommend(1, 30);
    return { title: T('推荐歌单'), sections: [{ title: '', style: 'grid', playlists }] };
  }
  if (p === 'rank' || p === 'charts') {
    const ranks = await rankList();
    return {
      title: T('排行榜'),
      sections: [{
        title: T('排行榜'),
        style: 'grid',
        playlists: ranks.map((r) => ({
          id: 'rank:' + r.id,
          name: r.name,
          imageUrl: r.imageUrl,
          plays: r.plays,
          trackCount: r.trackCount,
        })),
      }],
    };
  }
  // 默认回首页内容，免得点错页面时白屏。
  return await home();
}

export async function search({ query, kind, offset }) {
  const q = String(query || '').trim();
  const off = Number(offset || 0);
  const page = Math.floor(off / PAGE) + 1;
  if (!q) return { tracks: [], more: false };
  if (kind === 'albums') {
    const r = await searchAlbums(q, page, PAGE);
    const albums = r.lists.map(toAlbum).filter((a) => a.id && a.name);
    return { albums, more: off + albums.length < r.total || albums.length >= PAGE };
  }
  if (kind === 'artists') {
    const r = await searchArtists(q, page, PAGE);
    const artists = r.lists.map(toArtist).filter((a) => a.id && a.name);
    return { artists, more: off + artists.length < r.total || artists.length >= PAGE };
  }
  if (kind === 'playlists') {
    const r = await searchPlaylists(q, page, PAGE);
    const playlists = r.lists.map(toPlaylist).filter((p) => p.id && p.name);
    return { playlists, more: off + playlists.length < r.total || playlists.length >= PAGE };
  }
  const r = await searchSongs(q, page, PAGE);
  const tracks = toTracks(r.lists);
  return { tracks, more: off + tracks.length < r.total || tracks.length >= PAGE };
}

export async function suggest({ query }) {
  const q = String(query || '').trim();
  if (!q) return [];
  const r = await api('/v2/getSearchTip', {
    router: 'searchtip.kugou.com',
    params: { keyword: q, AlbumTipCount: 10, CorrectTipCount: 10, MVTipCount: 10, MusicTipCount: 10, radiotip: 1 },
  });
  const out = [];
  for (const block of (r.json && r.json.data) || []) {
    for (const item of block.RecordDatas || []) {
      const w = String(item.HintInfo || '').trim();
      if (w && out.indexOf(w) < 0) out.push(w);
    }
  }
  return out.slice(0, 10);
}

export async function hotSearches() {
  const r = await api('/api/v3/search/hot_tab', { router: 'msearch.kugou.com', params: { navid: 1, plat: 2 } });
  const list = ((r.json && r.json.data) || {}).list || [];
  const out = [];
  for (const tab of list) {
    for (const k of tab.keywords || []) {
      const w = String(k.keyword || '').trim();
      if (w && !out.some((x) => x.word === w)) out.push({ word: w, hint: String(k.reason || '') });
    }
  }
  return out.slice(0, 30);
}

export async function album({ id }) {
  const info = await albumInfo(id);
  // 专辑曲目接口一页最多 50 首，多了直接报 invalid param。
  const tracks = [];
  let total = 0;
  for (let page = 1; page <= 10; page++) {
    const part = await albumSongs(id, page, 50);
    total = part.total || total;
    tracks.push(...part.songs);
    if (!part.songs.length || tracks.length >= total) break;
  }
  const a = toAlbum(info);
  a.id = String(id);
  a.trackCount = total || a.trackCount;
  return { album: a, tracks };
}

export async function artist({ id }) {
  let authorId = String(id || '');
  if (!/^\d+$/.test(authorId)) {
    // 从歌名、歌手名拆出来的歌手只有名字没有 id，用搜索补一个。
    const r = await searchArtists(authorId, 1, 5);
    const hit = (r.lists || []).find((x) => String(x.AuthorName || '') === authorId) || (r.lists || [])[0];
    if (!hit) throw fail(T('找不到这个歌手'), 'unavailable');
    authorId = String(hit.AuthorId);
  }
  const info = await artistInfo(authorId);
  const songs = await artistSongs(authorId, 1, 100);
  const albums = await artistAlbums(authorId, 1, 30).catch(() => []);
  const base = toArtist(info);
  base.id = authorId;
  return { artist: base, tracks: songs.songs, albums, related: [] };
}

export async function playlists() {
  if (!loggedIn()) throw fail(T('请先登录酷狗账号'), 'signIn');
  return await myPlaylists();
}

export async function playlist({ id }) {
  const pid = String(id || '');
  if (pid.indexOf('rank:') === 0) {
    const rankId = pid.slice(5);
    const ranks = await rankList().catch(() => []);
    const songs = await rankSongs(rankId, 1, TRACK_PAGE).catch(() => ({ songs: [], total: 0 }));
    const meta = ranks.find((r) => r.id === rankId) || {};
    return {
      id: pid,
      name: meta.name || T('排行榜'),
      imageUrl: meta.imageUrl || '',
      description: meta.description || '',
      trackCount: songs.total,
      plays: meta.plays || 0,
      tracks: songs.songs,
    };
  }
  if (pid.indexOf('special:') === 0) {
    // 搜索回来的歌单只有 specialid，转成 global_collection_id 再查。
    const specialId = pid.slice(8);
    const r = await api('/v3/get_list_info', {
      method: 'POST',
      router: 'pubsongs.kugou.com',
      data: { data: [{ specialid: Number(specialId) }], userid: Number(auth().userid) || 0, token: auth().token },
    });
    const data = (r.json && r.json.data) || [];
    const one = Array.isArray(data) ? data[0] : data;
    if (one && one.global_collection_id) return await playlist({ id: one.global_collection_id });
    throw fail(T('这个歌单打不开'), 'unavailable');
  }
  const info = await listInfo(pid);
  const a = toPlaylist(Object.assign({}, info, { global_collection_id: pid }));
  const songs = await loadListTracks(pid);
  a.tracks = songs.tracks;
  a.trackCount = songs.total || a.trackCount;
  return a;
}

// 「我喜欢」里有已下架的占位条目（只有 fileid，没有 hash），按 offset 直接翻页会和
// 上一页最后一条重复。所以整表拉一次缓存起来，按 offset 切窗口。
let likedAllCache = { tracks: null, at: 0, count: 0 };

async function likedAll() {
  if (likedAllCache.tracks && Date.now() - likedAllCache.at < 60 * 1000) return likedAllCache;
  const tracks = [];
  let count = 0;
  let begin = 0;
  for (let i = 0; i < 8; i++) {
    const r = await api('/pubsongs/v2/get_other_list_file_nofilt', {
      params: {
        area_code: 1, begin_idx: begin, plat: 1, type: 1, mode: 1, personal_switch: 1,
        extend_fields: 'abtags,hot_cmt,popularization', pagesize: TRACK_PAGE, global_collection_id: likedGid(),
      },
    });
    const data = (r.json && r.json.data) || {};
    const songs = data.songs || [];
    count = Number(data.count || count);
    tracks.push(...toTracks(songs));
    begin += songs.length;
    if (!songs.length || (count && begin >= count)) break;
  }
  likedAllCache = { tracks, at: Date.now(), count: count || tracks.length };
  return likedAllCache;
}

export async function liked({ offset }) {
  if (!loggedIn()) throw fail(T('请先登录酷狗账号'), 'signIn');
  const off = Math.max(0, Number(offset || 0));
  const all = await likedAll();
  return { tracks: all.tracks.slice(off, off + 100), more: off + 100 < all.tracks.length };
}

let likedCache = { hashes: null, at: 0 };

async function likedHashes() {
  if (likedCache.hashes && Date.now() - likedCache.at < 60 * 1000) return likedCache.hashes;
  const all = await likedAll();
  const hashes = new Set();
  for (const t of all.tracks) hashes.add(parseId(t.id).hash);
  likedCache = { hashes, at: Date.now() };
  return hashes;
}

export async function isLiked({ ids }) {
  const list = ids || [];
  if (!loggedIn()) return list.map(() => false);
  let hashes;
  try { hashes = await likedHashes(); } catch (e) { return list.map(() => false); }
  return list.map((id) => hashes.has(parseId(id).hash));
}

export async function like({ id, on }) {
  if (!loggedIn()) throw fail(T('请先登录酷狗账号'), 'signIn');
  const t = parseId(id);
  const a = auth();
  const listid = 2;
  if (on) {
    const r = await api('/cloudlist.service/v6/add_song', {
      method: 'POST',
      params: { last_time: Math.floor(Date.now() / 1000), last_area: 'gztx', userid: Number(a.userid) || 0, token: a.token },
      data: {
        userid: Number(a.userid) || 0,
        token: a.token,
        listid,
        list_ver: 0,
        type: 0,
        slow_upload: 1,
        scene: 'false;null',
        data: [{
          number: 1,
          name: TRACK_META.get(t.hash) || '',
          hash: t.hash.toUpperCase(),
          size: 0,
          sort: 0,
          timelen: t.seconds * 1000,
          bitrate: 0,
          album_id: t.albumId,
          mixsongid: t.audioId,
        }],
      },
    });
    const ok = (r.json && (r.json.status === 1 || (r.json.data && r.json.data.status === 1))) || false;
    if (!ok) throw fail(T('收藏失败，请稍后再试'));
  } else {
    // 取消收藏要酷狗那边的 fileid，从「我喜欢」里按 hash 找。
    const fileid = await findLikedFileId(t.hash);
    if (!fileid) throw fail(T('这首歌不在「我喜欢」里'));
    const r = await api('/v4/delete_songs', {
      method: 'POST',
      router: 'cloudlist.service.kugou.com',
      data: { listid, userid: Number(a.userid) || 0, data: [{ fileid }], type: 0, token: a.token, list_ver: 0 },
    });
    const ok = (r.json && (r.json.status === 1 || (r.json.data && r.json.data.status === 1))) || false;
    if (!ok) throw fail(T('取消收藏失败，请稍后再试'));
  }
  likedCache = { hashes: null, at: 0 };
  likedAllCache = { tracks: null, at: 0, count: 0 };
}

async function findLikedFileId(hash) {
  const target = String(hash).toUpperCase();
  let begin = 0;
  for (let i = 0; i < 12; i++) {
    const r = await api('/pubsongs/v2/get_other_list_file_nofilt', {
      params: {
        area_code: 1, begin_idx: begin, plat: 1, type: 1, mode: 1, personal_switch: 1,
        extend_fields: 'abtags,hot_cmt,popularization', pagesize: TRACK_PAGE, global_collection_id: likedGid(),
      },
    });
    const data = (r.json && r.json.data) || {};
    const songs = data.songs || [];
    for (const s of songs) {
      if (String(s.hash || '').toUpperCase() === target) return Number(s.fileid || 0) || 0;
    }
    begin += songs.length;
    if (!songs.length || (data.count && begin >= data.count)) break;
  }
  return 0;
}

// 插件设置里选的音质。空字符串表示「跟随播放器」，用宿主传进来的那一档。
// 宿主现在固定传 high（lib/state.dart 调 sources.stream 不带 quality），
// 所以想让用户自己选，只能在插件侧覆盖。
function settingQuality() {
  let v = '';
  try { v = String(host.setting('quality') || '').trim(); } catch (e) { v = ''; }
  // 用 hasOwnProperty 而不是直接取：QUALITY_CHAIN 是普通对象，
  // 直接 QUALITY_CHAIN['constructor'] 会拿到构造函数，不是档位。
  return Object.prototype.hasOwnProperty.call(QUALITY_CHAIN, v) ? v : '';
}

export async function stream({ id, quality }) {
  const t = parseId(id);
  if (!t.hash) throw fail(T('这首歌没有可播放的地址'), 'unavailable');
  const q = settingQuality() || String(quality || 'high');
  return await songUrl(t.hash, t.albumId, t.audioId, q);
}

export async function lyrics({ id }) {
  const t = parseId(id);
  if (!t.hash) return { lrc: '', lines: [] };
  const search = await httpJson(
    'https://krcs.kugou.com/search?ver=1&man=yes&client=pc&keyword=' +
    encodeURIComponent('') +
    '&duration=' + encodeURIComponent(String(t.seconds || 0)) +
    '&hash=' + encodeURIComponent(t.hash.toUpperCase()),
  );
  const cand = ((search && search.candidates) || [])[0];
  if (!cand || !cand.id) return { lrc: '', lines: [] };
  const dl = await httpJson(
    'https://lyrics.kugou.com/download?ver=1&client=pc&fmt=lrc&charset=utf8&id=' +
    encodeURIComponent(cand.id) + '&accesskey=' + encodeURIComponent(cand.accesskey || ''),
  );
  if (!dl || !dl.content) return { lrc: '', lines: [] };
  const text = b64ToText(dl.content);
  const lines = parseLrc(text);
  if (!lines.length) return { lrc: '', lines: [] };
  return { lrc: text, lines };
}
// ── 写操作：云歌单那一族 ───────────────────────────────────
// 这一族接口的参数要 RSA 加密（p）、请求体要 AES-CBC 加密，所以走 cloudCall。
const CLOUD_ROUTER = 'cloudlist.service.kugou.com';
const nowSec = () => Math.floor(Date.now() / 1000);
const meId = () => Number(auth().userid) || 0;

function cloudRand(n) {
  const pool = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let s = '';
  for (let i = 0; i < n; i++) s += pool.charAt(Math.floor(Math.random() * pool.length));
  return s;
}

// 歌单 id 是 collection_3_<userid>_<listid>_0，listid 就是中间那段。
function listIdOf(id) {
  const parts = String(id || '').split('_');
  if (parts.length >= 5 && parts[0] === 'collection') return Number(parts[3]) || 0;
  return 0;
}

/**
 * 调一次云歌单接口。
 * b64=true 时请求体发密文的 base64 文本（删除歌单要这样），否则发原始字节（改名、排序）。
 */
async function cloudCall(path, dataMap, opt) {
  const o = Object.assign({ router: CLOUD_ROUTER, b64: false, sign: false, params: {} }, opt || {});
  const a = auth();
  const aes = cloudRand(6);
  const h = md5(aes);
  const key = h.slice(0, 16);
  const iv = h.slice(16, 32);
  const clienttime = nowSec();
  // 这里 uid 必须当字符串放进 JSON，跟酷狗自己的拼法一致。
  const p = rsaPkcs1Hex(JSON.stringify({ aes, uid: String(a.userid), token: a.token }));
  const enc = cbcEncrypt(key, iv, utf8Bytes(JSON.stringify(dataMap)));
  const params = Object.assign({
    dfid: dfid(),
    mid: mid(),
    uuid: '-',
    appid: APPID,
    clientver: CLIENTVER,
    clienttime,
    key: md5(APPID + SALT_LITE + CLIENTVER + clienttime).toLowerCase(),
    p,
  }, o.params || {});
  let b64 = '';
  if (o.b64) {
    b64 = bytesToB64(enc);
    // 带 signature 的版本要把 base64 文本一起算进签名。
    if (o.sign) params.signature = signWith(params, SALT_LITE, b64);
  }
  return await api(path, {
    method: 'POST',
    params,
    router: o.router,
    bodyBytes: o.b64 ? null : enc,
    b64Body: b64,
    noSign: true,
    decrypt: { key, iv },
  });
}

// 我的歌单列表。/v7 要带 total_ver，但传 0 也能拿到全量。
let myListsCache = { at: 0, totalVer: 0, lists: [] };

async function allLists(force) {
  if (!force && myListsCache.lists.length && Date.now() - myListsCache.at < 30 * 1000) return myListsCache;
  const a = auth();
  const r = await api('/v7/get_all_list', {
    method: 'POST',
    router: CLOUD_ROUTER,
    params: { plat: 1, userid: meId(), token: a.token },
    data: { total_ver: 0, type: 2, page: 1, pagesize: 100 },
  });
  const data = (r.json && r.json.data) || {};
  myListsCache = { at: Date.now(), totalVer: Number(data.total_ver || 0), lists: data.info || [] };
  return myListsCache;
}

// 歌单里的原始条目（带 fileid），顺序就是界面上的顺序。
async function listFilesByGid(gid, maxPages) {
  const out = [];
  let begin = 0;
  for (let i = 0; i < (maxPages || 10); i++) {
    const r = await api('/pubsongs/v2/get_other_list_file_nofilt', {
      params: {
        area_code: 1, begin_idx: begin, plat: 1, type: 1, mode: 1, personal_switch: 1,
        extend_fields: 'abtags,hot_cmt,popularization', pagesize: TRACK_PAGE, global_collection_id: gid,
      },
    });
    const data = (r.json && r.json.data) || {};
    const songs = data.songs || [];
    out.push(...songs);
    begin += songs.length;
    if (!songs.length || (data.count && begin >= data.count)) break;
  }
  return out;
}

function resetListCaches() {
  myListsCache = { at: 0, totalVer: 0, lists: [] };
  likedCache = { hashes: null, at: 0 };
  likedAllCache = { tracks: null, at: 0, count: 0 };
}

function needLogin() {
  if (!loggedIn()) throw fail(T('请先登录酷狗账号'), 'signIn');
}

export async function createPlaylist({ name }) {
  needLogin();
  const a = auth();
  const title = String(name || '').trim();
  if (!title) throw fail(T('歌单名不能为空'));
  const r = await api('/cloudlist.service/v5/add_list', {
    method: 'POST',
    params: { last_time: nowSec(), last_area: 'gztx', userid: meId(), token: a.token },
    data: {
      userid: meId(),
      token: a.token,
      total_ver: 0,
      name: title,
      type: 0,
      source: 1,
      is_pri: 0,
      list_create_userid: meId(),
      list_create_listid: 0,
      list_create_gid: '',
      from_shupinmv: 0,
    },
  });
  const info = (r.json && r.json.data && r.json.data.info) || {};
  const listid = Number(info.list_create_listid || 0);
  if (!listid) throw fail(T('新建歌单失败，请稍后再试'));
  resetListCaches();
  return {
    id: 'collection_3_' + a.userid + '_' + listid + '_0',
    name: String(info.name || title),
    imageUrl: '',
    description: '',
    owner: '',
    subtitle: '',
    trackCount: 0,
    plays: 0,
    mine: true,
    saved: false,
    fixed: false,
    tracks: [],
  };
}

export async function renamePlaylist({ id, name }) {
  needLogin();
  const listid = listIdOf(id);
  const title = String(name || '').trim();
  if (!listid) throw fail(T('这个歌单不能改名'), 'unsupported');
  if (!title) throw fail(T('歌单名不能为空'));
  const lists = await allLists(true);
  const a = auth();
  // total_ver 必须跟服务端一致，传 0 会返回 30203。
  const r = await cloudCall('/v1/modify_list', {
    total_ver: lists.totalVer,
    listid,
    type: 0,
    sort: 0,
    tags: '',
    intro: '',
    name: title,
  }, { params: { token: a.token, userid: meId(), last_time: nowSec(), last_area: 'gztx' } });
  const info = (r.json && r.json.data && r.json.data.info) || {};
  if (String(info.name || '') !== title) throw fail(T('改名失败，请稍后再试'));
  resetListCaches();
}

export async function deletePlaylist({ id }) {
  needLogin();
  const listid = listIdOf(id);
  if (!listid) throw fail(T('这个歌单不能删除'), 'unsupported');
  const lists = await allLists(true);
  const entry = lists.lists.find((x) => Number(x.listid) === listid);
  // type=1 是收藏来的歌单，type=0 才是自己建的。
  const type = entry && Number(entry.type || 0) === 1 ? 1 : 0;
  const a = auth();
  const r = await cloudCall('/v2/delete_list', { listid, total_ver: 0, type }, {
    b64: true, sign: true,
    params: { token: a.token, userid: meId(), last_time: nowSec(), last_area: 'gztx' },
  });
  if (!okRes(r)) throw fail(T('删除歌单失败，请稍后再试'));
  resetListCaches();
}

export async function addToPlaylist({ id, trackIds }) {
  needLogin();
  const listid = listIdOf(id);
  if (!listid) throw fail(T('这个歌单不能添加歌曲'), 'unsupported');
  const ids = trackIds || [];
  if (!ids.length) return;
  const a = auth();
  const rows = ids.map((tid, i) => {
    const t = parseId(tid);
    return {
      number: i + 1,
      name: TRACK_META.get(t.hash) || '',
      hash: t.hash.toUpperCase(),
      size: 0,
      sort: 0,
      timelen: t.seconds * 1000,
      bitrate: 0,
      album_id: t.albumId,
      mixsongid: t.audioId,
    };
  });
  const r = await api('/cloudlist.service/v6/add_song', {
    method: 'POST',
    params: { last_time: nowSec(), last_area: 'gztx', userid: meId(), token: a.token },
    data: {
      userid: meId(),
      token: a.token,
      listid,
      list_ver: 0,
      type: 0,
      slow_upload: 1,
      scene: 'false;null',
      data: rows,
    },
  });
  if (!okRes(r)) throw fail(T('添加失败，请稍后再试'));
  resetListCaches();
}

export async function removeFromPlaylist({ id, trackIds }) {
  needLogin();
  const listid = listIdOf(id);
  if (!listid) throw fail(T('这个歌单不能删除歌曲'), 'unsupported');
  const want = new Set((trackIds || []).map((tid) => parseId(tid).hash));
  if (!want.size) return;
  // 删歌要酷狗那边的 fileid，按 hash 在歌单里找。
  const files = await listFilesByGid(String(id));
  const rows = [];
  for (const s of files) {
    if (want.has(String(s.hash || '').toLowerCase())) rows.push({ fileid: Number(s.fileid || 0) });
  }
  if (!rows.length) throw fail(T('歌单里没有这些歌'));
  const a = auth();
  const r = await api('/v4/delete_songs', {
    method: 'POST',
    router: CLOUD_ROUTER,
    data: { listid, userid: meId(), data: rows, type: 0, token: a.token, list_ver: 0 },
  });
  if (!okRes(r)) throw fail(T('删除失败，请稍后再试'));
  resetListCaches();
}

export async function movePlaylistTrack({ id, from, to }) {
  needLogin();
  const listid = listIdOf(id);
  if (!listid) throw fail(T('这个歌单不能排序'), 'unsupported');
  const files = (await listFilesByGid(String(id))).filter((s) => s.hash);
  if (!files.length) throw fail(T('歌单里还没有歌'));
  const a1 = Math.max(0, Math.min(files.length - 1, Number(from) || 0));
  const a2 = Math.max(0, Math.min(files.length - 1, Number(to) || 0));
  if (a1 === a2) return;
  const order = files.slice();
  const moved = order.splice(a1, 1)[0];
  order.splice(a2, 0, moved);
  const data = order.map((s, i) => ({ fileid: Number(s.fileid || 0), sort: i + 1 }));
  const a = auth();
  const r = await cloudCall('/v1/modify_song_sort', { listid, list_ver: 0, type: 0, data }, {
    params: { token: a.token, userid: meId(), last_time: nowSec(), last_area: 'gztx' },
  });
  if (!okRes(r)) throw fail(T('排序失败，请稍后再试'));
}

// 收藏状态在界面里是按「我的歌单里有没有指向它」算的，所以这里也按同一个口径找。
async function myListFor(gid) {
  const lists = await allLists(true);
  const listid = listIdOf(gid);
  return lists.lists.find((x) => Number(x.listid) === listid) ||
    lists.lists.find((x) => String(x.list_create_gid || '') === String(gid)) ||
    null;
}

export async function savePlaylist({ id, on }) {
  needLogin();
  const parts = String(id || '').split('_');
  if (parts.length < 5) throw fail(T('这个歌单打不开'), 'unavailable');
  const a = auth();
  if (on) {
    if (await myListFor(String(id))) return;
    // 收藏别人的歌单：把来源歌单的 userid/listid/gid 填进去，type 传 1。
    const info = await listInfo(String(id)).catch(() => ({}));
    const name = String(info.name || '') || T('歌单');
    const r = await api('/cloudlist.service/v5/add_list', {
      method: 'POST',
      params: { last_time: nowSec(), last_area: 'gztx', userid: meId(), token: a.token },
      data: {
        userid: meId(),
        token: a.token,
        total_ver: 0,
        name,
        type: 1,
        source: 1,
        is_pri: 0,
        list_create_userid: Number(parts[2]) || 0,
        list_create_listid: Number(parts[3]) || 0,
        list_create_gid: String(id),
        from_shupinmv: 0,
      },
    });
    const got = (r.json && r.json.data && r.json.data.info) || {};
    if (!Number(got.list_create_listid || 0)) throw fail(T('收藏歌单失败，请稍后再试'));
  } else {
    const entry = await myListFor(String(id));
    if (!entry) throw fail(T('还没有收藏这个歌单'));
    const type = Number(entry.type || 0) === 1 ? 1 : 0;
    const r = await cloudCall('/v2/delete_list', { listid: Number(entry.listid), total_ver: 0, type }, {
      b64: true, sign: true,
      params: { token: a.token, userid: meId(), last_time: nowSec(), last_area: 'gztx' },
    });
    if (!okRes(r)) throw fail(T('取消收藏失败，请稍后再试'));
  }
  resetListCaches();
}

export async function followArtist({ id, on }) {
  needLogin();
  const singerid = Number(id);
  if (!singerid) throw fail(T('这个歌手关注不了'), 'unsupported');
  const a = auth();
  const clienttime = nowSec();
  // 歌手 id 与 token 先用 AES-256-CBC 加密，再把临时 key 用 RSA 加密。
  const enc = aesHexKey(JSON.stringify({ singerid, token: a.token }));
  const p = rsaPkcs1Hex(JSON.stringify({ clienttime, key: enc.key }));
  const r = await api(on ? '/followservice/v3/follow_singer' : '/followservice/v3/unfollow_singer', {
    method: 'POST',
    params: { clienttime },
    data: { plat: 0, userid: meId(), singerid, source: 7, p, params: enc.hex },
  });
  if (!okRes(r)) throw fail(T(on ? '关注失败，请稍后再试' : '取消关注失败，请稍后再试'));
}

export async function recent() {
  needLogin();
  const a = auth();
  const r = await api('/playhistory/v1/get_songs', {
    method: 'POST',
    data: { token: a.token, userid: meId(), source_classify: 'app', to_subdivide_sr: 1 },
  });
  const songs = ((r.json && r.json.data) || {}).songs || [];
  return toTracks(songs.map((s) => Object.assign({}, s.info || {})));
}

export async function played({ id }) {
  if (!loggedIn()) return;
  const t = parseId(id);
  const a = auth();
  if (!t.audioId) return;
  await api('/playhistory/v1/upload_songs', {
    method: 'POST',
    params: { plat: 3 },
    data: { songs: [{ mxid: t.audioId, op: 1, ot: t.seconds, pc: 1 }], token: a.token, userid: meId() },
  });
}

// ── 右键菜单：手动签到 ────────────────────────────────────
// 菜单本身有 2 秒超时，这里绝不能联网，只读缓存。
export async function trackMenu() {
  // 没登录、或今天已经签过，就不往右键菜单里塞东西，免得菜单越来越长。
  // 缓存的日期必须是本机今天，否则昨天签过的记录会让今天的入口一直消失。
  if (!loggedIn()) return [];
  if (checkinCache && checkinCache.signed && checkinCache.day === dayOf(0)) return [];
  return [{ id: 'checkin', title: T('领取今日会员'), icon: 'check', danger: false }];
}

export async function menuAction({ id }) {
  if (String(id) !== 'checkin') return {};
  if (!loggedIn()) throw fail(T('请先登录酷狗账号'), 'signIn');
  const ck = await runCheckin(true);
  if (!ck) return { toast: T('签到失败，请稍后再试') };
  const days = T('本月已签') + ' ' + String(ck.days) + ' ' + T('天');
  if (ck.claimed) return { toast: T('签到成功') + '，' + days };
  if (ck.signed) return { toast: T('今天已经签过了') + '，' + days };
  return { toast: T('签到失败，请稍后再试') };
}

