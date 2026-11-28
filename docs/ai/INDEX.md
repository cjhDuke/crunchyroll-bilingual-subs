# 代码记忆索引

## 扩展运行链路

- `src/page/hook.js` 在主世界拦截 fetch / XHR 播放响应及选轨请求，跟踪正片轨道，并用请求序号防止旧响应覆盖。
- `src/core/playback.js` 提取字幕地址与格式、识别广告；旧版结构沿用干净流改写，新版 stitched 结构按正片段验证无字幕来源后切换硬字幕流，混合响应独立处理顶层与各正片段。
- `src/content/content.js` 接收播放/字幕语言消息，仅下载并解析 ASS，创建 `TrackSession` 并控制开播等待；VTT 等格式会提示不支持并跳过，不具备 WebVTT 解析链路。
- `src/core/ass.js` 解析 Dialogue，抽取可读文本，将普通居中字幕与原位字幕分开渲染。两类可读文字按原事件 ID 进入同一个翻译会话。
- `src/content/overlay.js` 自绘顶部和底部居中字幕，用 ASS.js 渲染原位字幕。会话从缓存或网络取到译文后刷新原位字幕，ASS 内容变化时才替换渲染实例。
- `src/popup/popup.js` / `popup.html` 提供“本集字幕时间”滑块、数值、提前/延后与重置；通过内容脚本读写本集偏移。弹窗串行发送待保存值，并用集 ID 和版本号隔离换集及迟到响应，避免刷新状态覆盖正在编辑的数值。

## 重要约定

- 广告或预告片等没有字幕轨的播放响应不应覆盖正式剧集状态。
- 播放信息有两种结构：旧版顶层 `subtitles`/`hardSubs`；新版 `stitchedElements[].textTracks[]` 的 `EXTERNAL` 轨用 `externalTextUrl` 提取字幕，`BURNED_IN.videoUrl` 不作为外置字幕下载。只收集 `type` 以 `main` 开头的元素；跳过 `ad/promo/recap/preview/logo`。
- 旧版继续用 `json.url` 改写 `hardSubs` 并附加选轨标记。混合响应不能因存在 `stitchedElements` 跳过旧结构：顶层以自身有效的 `hardSubs.none.url` 作为同语言顶层 ASS 对应硬字幕轨的 clean，保留 `none`，不要求该地址与 `json.url` 相等（签名或查询参数可不同）；没有有效 `none` 地址则保留顶层选择。该地址绝不用于任何 main；各 main 独立处理，不受顶层是否改写影响。
- stitched 每段先收集本段同语言 EXTERNAL ASS 轨自带的 `videoUrl`，没有此类地址时才用本段明确 `none` 轨的 `videoUrl`；候选唯一时改写同语言 `BURNED_IN.videoUrl` 并附加 `crbs_sub`。禁止借用全片 URL、元素默认 `videoUrl` 或其他 main 的候选拼接、猜测；缺少可靠来源保留原流。广告、预告等片段的 URL、时长、顺序保持原样。
- hook 收集所有 main 的选轨 URL；共用 URL 不猜语言，fetch/XHR 均识别选轨及 `none`。旧响应先按请求序号拦截再改写，避免旧流新增标记污染当前集。
- 既有限制：`info.subtitles` 每种语言目前只容纳一个 ASS 地址，独立分段 ASS 尚未聚合；多 main 的视频 URL 回归通过不代表所有分段字幕已支持，也不保证覆盖所有广告类型。
- `info.hasAds`（显式 `hasAds`、非空 `ads.adBreaks`、顶层或 stitched 元素 `type: ad`）为真时不做开播暂停，避免暂停广告或打乱时间轴；无广告时开播等待最多 25 秒。
- 同一集按集 ID、语言、格式识别当前轨道，URL 签名变化不重启会话；选轨由 `desiredLang` + `ensureSelection()` 幂等自愈，2.5 秒收不到选轨信号时优先选英文 ASS、其次其他 ASS，最后才是首个轨道（非 ASS 会提示不支持）。明确选择 `none` 时不得兜底重开；换集应清除旧选轨计时器。
- `generation` 隔离字幕下载、会话启动等异步结果，换集或切轨后旧结果不得污染当前状态。
- 本集时间差存于 `state.subtitleOffsetSeconds`，由 `src/shared/settings.js` 的 `normalizeSubtitleOffset()` 规范为 ±600 秒、0.5 秒步进；`subtitleOffsetKey(episodeId)` 生成 `subtitleOffset:<episodeId>`，通过 `chrome.storage.local` 每集独立保存，不混入全局设置或译文缓存。
- `getStatus` 返回 `episodeId`、`subtitleOffsetSeconds`；`setSubtitleOffset` 接收 `{ episodeId, offsetSeconds }`，拒绝跨集或非有限数值。调整立即生效并异步保存；保存失败会返回错误。`offsetRevision` 防止迟到的存储读取覆盖用户调整或串集，`offsetWrites` 串行保存。换集先恢复零偏移，再读取该集存储。
- 时间差正值延后、负值提前。内容脚本和自绘 overlay 使用 `video.currentTime - subtitleOffsetSeconds`，ASS.js 使用 `ASS.delay = subtitleOffsetSeconds`。调整更新时间、显示与开播等待判定，沿用当前翻译会话和缓存。
- `displayMode: translation` 在两个渲染路径都只显示有效非空译文。原位字幕按显示模式生成 ASS，双语模式用原锚点和时间显示原译，纯绘图在仅译文模式隐藏。视频像素里的硬烧录文字不在字幕翻译输入内。
- manifest URL 中的 ID 只是清单/流 ID，不能拿来和 playback URL 的集 ID 做严格匹配。
- 普通居中对白按顶部或底部自绘。带坐标、移动、招牌和非上下居中对齐的字幕交给 ASS.js，保留位置和时间，勿同时在自绘层重复显示。混合绘图事件只将可读文字送去翻译。弹窗的翻译总数包括所有可读行。
- 保持已解析 Dialogue 的原事件 ID，缓存仍使用集 ID、原语言、目标语言和 ASS 内容哈希。翻译会话等缓存载入后才开始请求，普通加载只补缺失的行，手动重翻沿用所选范围。

## 验证

- 单元测试：`node --test tests/*.test.js`；`tests/` 中正式回归测试是维护资产，清理临时产物时应保留。
- 标题分类与布局看 `tests/ass.test.js`、`tests/overlay.test.js`；播放信息、选轨与异步状态看 `tests/playback.test.js`、`tests/hook.test.js`、`tests/content.test.js`；翻译调度看其余会话与翻译测试。
- 可读文字提取、原位字幕的时间定位和显示模式看 `tests/ass.test.js`；会话、译文刷新及弹窗计数看 `tests/content.test.js`，新增字幕复用已有译文看 `tests/session.test.js`。
- 通用去硬字幕回归看 `tests/playback.test.js`、`tests/hook.test.js`：旧版/混合结构、逐段可靠候选、缺少同语言 ASS 或 clean 时保留原流、广告保持、签名刷新、共用 URL、`none` 和旧响应保护。
- 时间差接口、每集存储与异步隔离回归定位 `tests/content.test.js`；仅译文过滤、原文特效可见性与偏移显示回归定位 `tests/overlay.test.js`。验收时检查正负偏移、重置、重开弹窗、刷新本集与往返换集，并确认调整不触发重新翻译。
- `tests/settings.test.js` 覆盖偏移范围、半秒步进及与全局设置隔离；`tests/popup.test.js` 覆盖控件禁用、迟到状态响应、编辑与拖动保护、连续保存及换集时丢弃旧集待保存操作。
- 真实 Crunchyroll 播放页仍需验收同屏上下字幕、标题静态定位、广告前导与换集；单元测试不能代替真实播放验证。

## 文档关系

- 本索引与真实源码记录当前行为；[首版设计](../specs/2026-11-05-crunchyroll-bilingual-subs-design.md) 保留历史背景，其中无广告假设与部分交互已过时。
- 已完成的首版实现计划已删除，不再作为待办入口。
