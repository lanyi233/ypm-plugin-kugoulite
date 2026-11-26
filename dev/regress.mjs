// dev/regress.mjs —— 只读回归：把插件对外暴露的接口全跑一遍，看有没有报错、返回结构对不对。
//
//   node dev/regress.mjs          只读，不碰你的账号
//   node dev/regress.mjs --write  额外跑一遍会改账号的往返测试（收藏/取消收藏），跑完还原
//
// 需要 dev/storage.json 里有一份已登录的存档（从应用的 plugin-data 目录拷过来）：
//   ~/.local/share/YesPlayMusic/plugin-data/kugou-lite/storage.json
// 没有存档时自动跳过需要登录的部分，只测匿名可用的接口。

import { loadPlugin, hasAccount } from './harness.mjs';

const WRITE = process.argv.includes('--write');
const { mod } = await loadPlugin();

let pass = 0;
let fail = 0;
const ok = (name, detail) => { pass++; console.log('  PASS ' + name + (detail ? '  ' + detail : '')); };
const no = (name, why) => { fail++; console.log('  FAIL ' + name + '  ' + why); };
const run = async (name, fn) => {
  try {
    const detail = await fn();
    ok(name, detail);
    return true;
  } catch (e) {
    no(name, (e && e.message) || String(e));
    return false;
  }
};
const sec = (t) => console.log('\n' + t);

const logged = hasAccount() && Boolean(await mod.account().catch(() => null));
if (!logged) console.log('（没有登录存档，跳过需要账号的项）\n');

// ── 匿名就能用的 ────────────────────────────────────────────
sec('搜索与浏览');

let track = null;
await run('search tracks', async () => {
  const r = await mod.search({ query: '晴天 周杰伦', kind: 'tracks', offset: 0 });
  track = r.tracks && r.tracks[0];
  if (!track) throw new Error('一首都没搜到');
  return r.tracks.length + ' 首，第一首 ' + track.name;
});
await run('search albums', async () => {
  const r = await mod.search({ query: '周杰伦', kind: 'albums', offset: 0 });
  if (!r.albums || !r.albums.length) throw new Error('没有专辑');
  return r.albums.length + ' 张，第一张 ' + r.albums[0].name;
});
await run('search artists', async () => {
  const r = await mod.search({ query: '周杰伦', kind: 'artists', offset: 0 });
  if (!r.artists || !r.artists.length) throw new Error('没有歌手');
  return r.artists.length + ' 位，第一位 ' + r.artists[0].name;
});
await run('search playlists', async () => {
  const r = await mod.search({ query: '华语', kind: 'playlists', offset: 0 });
  if (!r.playlists || !r.playlists.length) throw new Error('没有歌单');
  return r.playlists.length + ' 个，第一个 ' + r.playlists[0].name;
});
await run('suggest', async () => {
  const r = await mod.suggest({ query: '晴天' });
  return JSON.stringify(r).slice(0, 60);
});
await run('hotSearches', async () => {
  const r = await mod.hotSearches();
  if (!r || !r.length) throw new Error('热搜是空的');
  return r.length + ' 条';
});
await run('album', async () => {
  const r = await mod.album({ id: '8443612' });
  if (!r.tracks || !r.tracks.length) throw new Error('专辑里没有歌');
  return r.album.name + '，' + r.tracks.length + ' 首';
});
await run('artist 按名字', async () => {
  const r = await mod.artist({ id: '周杰伦' });
  if (!r.tracks || !r.tracks.length) throw new Error('没有歌');
  return r.tracks.length + ' 首，' + (r.albums || []).length + ' 张专辑';
});
await run('browse daily', async () => {
  const r = await mod.browse({ page: 'daily' });
  const n = (r.sections && r.sections[0] && r.sections[0].tracks || []).length;
  if (!n) throw new Error('每日推荐是空的');
  return n + ' 首';
});
await run('browse rank', async () => {
  const r = await mod.browse({ page: 'rank' });
  if (!r.sections || !r.sections.length) throw new Error('榜单是空的');
  return r.sections.length + ' 个榜单';
});
await run('browse playlist', async () => {
  const r = await mod.browse({ page: 'playlist' });
  const n = (r.sections && r.sections[0] && r.sections[0].playlists || []).length;
  if (!n) throw new Error('推荐歌单是空的');
  return n + ' 个歌单';
});

// ── 公开歌单 ────────────────────────────────────────────────
sec('歌单');
let publicPlaylist = null;
await run('playlist 公开歌单', async () => {
  const b = await mod.browse({ page: 'playlist' });
  const pl = b.sections[0].playlists[0];
  publicPlaylist = pl;
  const r = await mod.playlist({ id: pl.id });
  return r.name + '，' + r.tracks.length + ' 首';
});

// ── 取流：只验地址能不能取到字节，不下载整首 ─────────────────
sec('取流');
const sample = track;
if (sample) {
  for (const q of ['standard', 'high', 'lossless']) {
    await run('stream ' + q, async () => {
      let s;
      try {
        s = await mod.stream({ id: sample.id, quality: q });
      } catch (e) {
        // 付费曲在境外网络或没有会员时会明确报错，这不算插件坏，单独标注。
        if (e.code === 'unavailable') return '跳过（' + e.message.slice(0, 24) + '…）';
        throw e;
      }
      const r = await fetch(s.url, { headers: { Range: 'bytes=0-4095' } });
      if (r.status !== 206 && r.status !== 200) throw new Error('HTTP ' + r.status);
      const b = Buffer.from(await r.arrayBuffer());
      return s.quality + ' ' + (s.bitRate || '?') + 'bps  ' + b.length + 'B  ' + JSON.stringify(b.slice(0, 3).toString('latin1'));
    });
  }
}
if (sample) {
  await run('lyrics', async () => {
    const r = await mod.lyrics({ id: sample.id });
    if (!r.lines || !r.lines.length) throw new Error('没有歌词行');
    return r.lines.length + ' 行';
  });
}
await run('trackMenu 不联网', async () => {
  const r = await mod.trackMenu({ track: sample || { id: 'x' } });
  if (!Array.isArray(r)) throw new Error('必须返回数组');
  return r.length ? '有 ' + r.length + ' 项' : '空';
});

// ── 需要账号 ────────────────────────────────────────────────
if (logged) {
  sec('账号');
  await run('account', async () => {
    const a = await mod.account();
    if (!a || !a.name) throw new Error('拿不到昵称');
    return a.name;
  });
  let myLists = [];
  await run('profile', async () => {
    const p = await mod.profile();
    myLists = p.playlists || [];
    return (p.facts || []).join(' / ') + '，' + myLists.length + ' 个歌单';
  });
  await run('home', async () => {
    const h = await mod.home();
    if (!h.sections || !h.sections.length) throw new Error('首页是空的');
    return h.sections.length + ' 个版块';
  });
  await run('playlists', async () => {
    const r = await mod.playlists();
    if (!r.length) throw new Error('没有歌单');
    return r.length + ' 个';
  });
  await run('liked', async () => {
    const r = await mod.liked({ offset: 0 });
    if (!r.tracks || !r.tracks.length) throw new Error('「我喜欢」是空的');
    return r.tracks.length + ' 首';
  });
  let likedTrack = null;
  await run('liked → isLiked', async () => {
    const r = await mod.liked({ offset: 0 });
    likedTrack = r.tracks[0];
    const v = await mod.isLiked({ ids: [likedTrack.id] });
    if (!v[0]) throw new Error('「我喜欢」里的歌被报成未收藏');
    return 'true';
  });
  await run('recent', async () => {
    const r = await mod.recent();
    return r.length + ' 首';
  });

  if (WRITE && track) {
    sec('写操作往返（--write）');
    await run('like 往返', async () => {
      const before = (await mod.isLiked({ ids: [track.id] }))[0];
      await mod.like({ id: track.id, on: !before });
      const mid = (await mod.isLiked({ ids: [track.id] }))[0];
      await mod.like({ id: track.id, on: before });
      const after = (await mod.isLiked({ ids: [track.id] }))[0];
      if (mid !== !before) throw new Error('点了没生效');
      if (after !== before) throw new Error('没还原回去');
      return before + ' → ' + mid + ' → ' + after;
    });
    await run('savePlaylist 往返', async () => {
      if (!publicPlaylist) throw new Error('没有可用的公开歌单');
      const before = (await mod.playlist({ id: publicPlaylist.id })).saved;
      await mod.savePlaylist({ id: publicPlaylist.id, on: !before });
      const mid = (await mod.playlist({ id: publicPlaylist.id })).saved;
      await mod.savePlaylist({ id: publicPlaylist.id, on: before });
      const after = (await mod.playlist({ id: publicPlaylist.id })).saved;
      if (mid === before) throw new Error('收藏没生效');
      if (after !== before) throw new Error('没还原回去');
      return before + ' → ' + mid + ' → ' + after;
    });
  } else if (!WRITE) {
    console.log('\n（写操作往返测试需要 --write，默认不跑，免得动到你的账号）');
  }
}

console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
