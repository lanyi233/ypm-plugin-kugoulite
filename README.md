# 酷狗音乐 Lite

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)

把酷狗曲库接进 YesPlayMusic：搜索、专辑、歌手、歌单、排行榜、每日推荐，点歌即播。

## 装法

在 YesPlayMusic 的插件目录下建一个 `kugou-lite` 文件夹，把本仓库的 `index.js`、`plugin.json`、
`icon.png`、`locales/` 放进去（`dev/`、`package.json` 这些是开发用的，不用拷）：

```
~/.local/share/YesPlayMusic/plugins/kugou-lite/     # Linux
~/Library/Application Support/YesPlayMusic/plugins/kugou-lite/   # macOS
%APPDATA%\YesPlayMusic\plugins\kugou-lite\          # Windows
```

重启应用，在「设置 → 插件」里能看到并启用。改完代码后在同一处点「重新加载」，不用重启。

## 登录

酷狗的大部分内容不用登录就能看，但「我喜欢」「我的歌单」「每日推荐」和部分曲目的取流需要账号。
在源里点登录会弹二维码，用酷狗 App 扫一下即可，token 存在插件的 storage.json 里。

## 说明

- 协议来自 Salt Player 的 `cn.spw.kugou.lite` 插件：它的 native sidecar 是 KuGouMusicApi 的 Rust 移植，
  用概念版参数（appid=3116、clientver=11440），签名是 `MD5(盐 + 排序后的 k=v + 请求体 + 盐)`。
- 音质档位：`standard` → 128k，`high` → 320k，`lossless` → flac（取不到就往下降）。
  应用本体没有音质开关（`lib/pages/settings.dart` 里写着「音质由各插件在自己的设置里决定」，
  且 `lib/state.dart` 调 `sources.stream()` 时不传 quality，插件永远收到 `high`），
  所以音质放在插件自己的设置项里，由 `stream()` 读 `host.setting('quality')` 覆盖。
- 歌词走 krcs/lyrics 的明文 LRC 接口，逐行带起止时间。
- 取流地址只能用 `http`：酷狗 CDN 的证书不是 `*.kugou.com`，升级成 https 会被宿主判成证书错误。
- 云歌单那一族接口（改名/删除/排序）要求参数走 RSA、请求体走 AES-CBC，插件里自带了一份纯 JS 实现，
  不依赖宿主的加密能力，也不需要外部程序。

## 取不到播放地址时

酷狗把播放地址发下来之后，还会校验请求方所在地区。插件把失败分成三种，提示文案不同：

| 提示 | 含义 | 怎么办 |
|---|---|---|
| 「该曲目需要酷狗会员」 | 接口直接说没权限，地址都没给 | 开会员，或换一首 |
| 「酷狗给了播放地址但拒绝下发（404）」 | 地址签发正常，但 CDN 按地区拦了 | 网络出口不在中国大陆，换回国内网络 |
| 「连不上酷狗的文件服务器」 | 地址签发正常，下载请求没连上 | 多为代理抖动，稍后重试 |

第二种是最常见的：酷狗签地址时会把出口 IP 所在城市写进 URL（形如 `ct440100`），
CDN 发现请求来源和这个城市不一致就回 404。实测把网络出口切到国内（广州最佳）后，
付费曲的高音质档位都能正常拿到字节；出口在境外时同一首歌会稳定 404。
这不是插件的问题，换网络即可。

## 每日会员签到

酷狗概念版每天可以领一次 VIP 听歌时长。插件会自动做：

- 应用启动 8 秒后检查一次，没签就签；
- 之后每 15 分钟检查一次（跨零点也能立刻补上）；
- 判断依据是 `/youth/v1/activity/get_month_vip_record` 的实际记录，不是本地时间戳，所以换设备也不会重复签；
- 领取成功会顺手领一次「升级概念版会员」奖励。

在「设置 → 插件」里可以关掉「自动签到」。也可以在任意歌曲上点右键，菜单里有「领取今日会员」手动签一次。
个人页会显示本月已签天数、今日状态和会员到期时间。

签到不涉及任何广告上报接口 —— 那种「看广告加时长」的做法要伪造播放上报，属于作弊，插件没有实现。

## 音质怎么选

「设置 → 插件 → 酷狗音乐 Lite → 设置」里有一项「音质」：

| 选项 | 实际请求的档位 | 说明 |
|---|---|---|
| 跟随播放器（320k） | 320 → 128 | 默认。宿主现在固定要 `high`，等价于 320k |
| 标准 128k | 128 | 流量小，通勤听足够 |
| 高 320k | 320 → 128 | |
| 无损 FLAC | flac → 320 → 128 | 付费曲和无损版权曲才拿得到 flac |

选中的档位酷狗没有时（比如没版权、没会员），自动往下降一档再试，不会直接报错。
改完设置之后，宿主会清掉这个源的音频缓存，下一首开始用新音质。

## 能做的事

- 浏览与播放：搜索、专辑、歌手、歌单、排行榜、每日推荐、歌词、音质切换。
- 收藏：`我喜欢` 的收藏与取消。
- 歌单：新建、改名、删除，收藏别人的歌单与取消收藏，歌单内加歌、删歌、拖动排序。
- 关注歌手：关注与取消关注。
- 历史：最近播放列表，播放时上报。

## 还没做

- 收藏专辑：酷狗的收藏接口语义没能确认，导出后会给出假按钮，所以留空。
- 评论、MV、云盘等其余接口。

## 开发

插件就是一个 `index.js`，没有构建步骤。`dev/` 下有一套在 Node 里跑的自测工具：
它照着宿主的接口把 `fetch` 和 `host.*` 搭出来，然后直接 import `index.js`，
所以不用开应用也能跑通全部接口。

```bash
npm run check      # 静态检查：清单合法性、入口语法、导出函数是否都在宿主认得的名单里
npm run regress    # 只读回归：搜索/专辑/歌手/歌单/榜单/取流/歌词/签到菜单
node dev/regress.mjs --write   # 额外跑一遍收藏与歌单的往返测试，跑完还原
```

需要登录的项（`我喜欢`、我的歌单、每日推荐、付费曲取流）要有一份账号存档：
把应用里的 `plugin-data/kugou-lite/storage.json` 拷成 `dev/storage.json`。
这个文件里有登录 token，已在 `.gitignore` 里排除，**不要提交**。
没有存档时会自动跳过这些项。

想看某个接口到底发了什么请求，在 `dev/harness.mjs` 的 `loadPlugin()` 上挂 `fetchHook` 即可：

```js
import { loadPlugin } from './dev/harness.mjs';

const { mod } = await loadPlugin({
  fetchHook: ({ url }, realFetch) => {
    if (!url.includes('127.0.0.1')) console.log(url);
    return realFetch(url);
  },
});
await mod.search({ query: '晴天', kind: 'tracks', offset: 0 });
process.exit(0);   // 插件里有 15 分钟的签到定时器，脚本要自己退出
```

**改代码时的两个坑**：一是不要给 `settings` 条目加 `op` 字段，那会让宿主把对应的接口整个关掉；
二是取流地址不要升级成 https，酷狗 CDN 的证书不是 `*.kugou.com`。

## 协议从哪来的

这些接口不是官方文档，是从 Salt Player 的酷狗插件 `cn.spw.kugou.lite` 逆出来的：
它的 native sidecar 是 [KuGouMusicApi](https://github.com/MakcRe/KuGouMusicApi) 的 Rust 移植，
签名算法和参数与那边一致。本仓库把用到的部分用纯 JS 重写了一遍，运行时不依赖任何外部程序。
