# Crunchyroll 双语字幕插件 实现计划

> **For agentic workers:** 按任务顺序实现，步骤用 `- [ ]` 跟踪。项目目录不是 git 仓库，用户未要求提交，因此省略 commit 步骤。

**Goal:** 一个 Chrome MV3 扩展：在 Crunchyroll 播放页把当前字幕翻译成目标语言（默认简体中文），以双语对照显示；大模型（OpenAI 兼容接口，默认 DeepSeek `deepseek-flash` 非思考）失败时回退谷歌免费机翻。

**Architecture:** 实测（2026-11-05）发现 Crunchyroll 网页端默认播放**硬字幕视频流**，不加载 ASS。方案：页面主世界脚本拦截 `/playback/v4/{id}/.../play` 响应，把 `hardSubs[*].url` 改成无字幕的干净流（`json.url`），并在 URL 上加标记参数 `crbs_sub=<语言>`；再拦截播放器请求 manifest 的 XHR 得知当前选中的字幕语言。内容脚本通过后台下载 `subtitles[lang].url` 的 ASS，自己负责全部字幕显示：对白由自绘字幕层双语显示，招牌/标题等特效行交给 ASS.js 原样渲染。翻译编排在内容脚本，后台 service worker 只做跨域网络请求。

**Tech Stack:** 纯 JS（无构建），Chrome MV3；ASS.js 0.1.10（MIT，vendored）；测试用 Node 24 自带 `node:test`。

**Spec:** `docs/specs/2026-11-05-crunchyroll-bilingual-subs-design.md`

## Global Constraints

- 所有核心模块是经典脚本：挂到 `globalThis.CRBS` 命名空间，同时 `if (typeof module !== 'undefined') module.exports = ...` 供 Node 测试 `require`。
- DeepSeek 预设：Base URL `https://api.deepseek.com`，模型 `deepseek-flash`，额外参数 `{"thinking":{"type":"disabled"}}`，接口 `${baseUrl}/chat/completions`。
- 谷歌回退：`https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=<tl>&dt=t&q=<text>`。
- 默认目标语言 `zh-CN`；批大小 30；并发 5；单批超时 30000ms；大模型同批重试 1 次后回退谷歌。
- 开播等待第一批：最多 25 秒，超时后恢复播放并提示。
- API Key 只存 `chrome.storage.local`，只发往用户配置的 Base URL。
- 只支持 ASS；其他格式提示"此字幕格式暂不支持"，不暂停。
- 用户是付费会员，无广告。

## Review Focus

1. 大模型返回的条目数/编号与请求不符（漏行、合并行、多余解释文字、```json 围栏）→ 解析器容错围栏，编号缺失则整批视为失败走谷歌。测试：`parseLlmResponse` 的围栏与缺号用例。
2. 字幕行含 ASS 标签、`\N`、`\h`、绘图命令 → 纯文本提取正确；绘图行（`\p1`）判为特效行不翻译。测试：`plainText`、`isDialogueEvent` 用例。
3. 播放中拖进度条到未翻译区域 → 该区域批次被提到队列最前，未到前只显示原文。测试：`TrackSession` 优先级用例。
4. 播放器切换到"无字幕" / 换集（SPA）→ 旧会话停止、字幕层清空，不串集。测试：`parseManifestMarker` 对 `none` 的用例 + 运行时手测。
5. 谷歌接口对多行合并请求返回的行数不一致 → 回退为逐行请求。测试：`googleTranslateLines` 行数不一致用例。

---

### Task 1: ASS 解析与特效行分类

**Files:** Create `src/core/ass.js`; Test `tests/ass.test.js`

**Interfaces — Produces:**
- `parseAss(text) -> { events: AssEvent[], styleNames: string[] }`，`AssEvent = { index:number, start:number(秒), end:number, style:string, name:string, text:string(原始), plain:string }`，`index` 为该 Dialogue 在文件中的序号（从 0）。
- `plainText(raw) -> string`：去 `{...}`，`\N`/`\n` → `\n`，`\h` → 空格，trim。
- `isDialogueEvent(ev) -> boolean`：样式名匹配 `/^(default|main|italics?|top|italicstop|flashback\w*)$/i` 且文本不含 `\pos(`、`\move(`、`\p1`~`\p9`、`\org(`，且 plain 非空。
- `stripDialogue(text, dialogueIndexSet) -> string`：返回去掉这些 Dialogue 行的 ASS 全文（给 ASS.js 只渲染特效行）。
- `hashString(s) -> string`：FNV-1a 32 位十六进制。

- [ ] 测试：用实测样本（`main`/`italicstop`/`sign_303_...`/`Ep Title` 行、带 `{\i1}`、`\N`、`{\pos(320,50)}`、`{\p1}m 0 0 l...` 行）断言 start/end 秒数、plain、分类结果、`stripDialogue` 后不含对白行但保留 `[Script Info]`/`[V4+ Styles]`。
- [ ] 跑 `node --test tests/` 确认失败 → 实现 → 通过。

### Task 2: 播放信息改写与选中字幕识别

**Files:** Create `src/core/playback.js`; Test `tests/playback.test.js`

**Produces:**
- `rewritePlayback(json, marker='crbs_sub') -> { json, info: { episodeId:string|null, subtitles: {[lang]:{format,url}} } }`：对每个 `hardSubs[lang]`（含 `none`）把 `url` 换成 `json.url` 加 `&crbs_sub=<lang>`；`json.url` 不存在时原样返回且 `info.subtitles` 照常提取；`episodeId` 取自 `json.versions` 中 `original`/当前 guid，或由调用方传入 URL 解析（见下）。
- `episodeIdFromPlayUrl(url) -> string|null`：从 `/playback/v4/<ID>/` 取 ID。
- `parseManifestMarker(url, marker='crbs_sub') -> string|null`。

- [ ] 测试：用实测 JSON 片段断言 `en-US`、`none` 都被改为干净流+标记；无 `hardSubs` 时不抛错；`parseManifestMarker` 对 `none`、无标记返回正确。
- [ ] 失败 → 实现 → 通过。

### Task 3: 大模型请求、术语表与响应解析

**Files:** Create `src/core/llm.js`; Test `tests/llm.test.js`

**Produces:**
- `buildTranslateMessages({ lines:[{id,text}], before:string[], after:string[], glossary:[{src,dst}], title, targetLangName }) -> messages[]`：system 提示要求只输出 JSON 对象 `{"<id>":"<译文>"}`、口语化字幕风格、保留语气、不加解释；user 消息含番名、术语表、上下文（标明仅供参考不翻译）、带编号原文。
- `parseLlmResponse(content, ids:number[]) -> Map<number,string>`：去 ``` 围栏，取第一个 `{` 到最后一个 `}` 解析；任一 id 缺失或为空 → throw。
- `buildGlossaryMessages({ allText, title, targetLangName }) -> messages[]`；`parseGlossary(content) -> [{src,dst}]`（最多 60 条，失败返回 `[]`）。
- `chatCompletion(settings, messages, { fetchImpl, timeoutMs }) -> Promise<string>`：POST `${baseUrl去尾斜杠}/chat/completions`，body = `{model, messages, temperature:0.3, stream:false, ...extraParams}`，Authorization Bearer；非 2xx、超时、无 `choices[0].message.content` → throw（错误信息含状态码与响应前 200 字）。

- [ ] 测试：围栏 JSON、多余前后文字、缺号抛错；`chatCompletion` 用假 fetch 断言 URL、header、body 合并 `thinking:{type:'disabled'}`、超时抛错。
- [ ] 失败 → 实现 → 通过。

### Task 4: 谷歌回退与批翻译器

**Files:** Create `src/core/google.js`, `src/core/translator.js`; Test `tests/translator.test.js`

**Produces:**
- `googleTranslateLines(texts:string[], tl, { fetchImpl }) -> Promise<string[]>`：行内换行替换为空格，以 `\n` 连接一次请求；拼接 `data[0][*][0]` 后按 `\n` 切分，行数不等则逐行请求（并发 4）。
- `translateBatch(batch, ctx, deps) -> Promise<{ map: Map<number,string>, source:'llm'|'google' }>`，`deps = { llm(messages)->Promise<string>, google(texts,tl)->Promise<string[]> }`；大模型 2 次尝试（首次 + 重试 1 次）都失败则谷歌；谷歌也失败则 throw。
- `LANGS`：`[{code:'zh-CN', name:'简体中文', google:'zh-CN'}, 'zh-TW' 繁体中文, en, ja, ko, fr, de, es, ru, pt]`。

- [ ] 测试：llm 首次失败重试成功 → source `llm`；两次失败 → `google`；谷歌行数不符 → 逐行。
- [ ] 失败 → 实现 → 通过。

### Task 5: 翻译会话（队列、优先级、术语表、缓存）

**Files:** Create `src/core/session.js`; Test `tests/session.test.js`

**Produces:** `class TrackSession`
- `constructor({ events, title, settings, deps:{ translateBatch, glossary(allText)->Promise<[]>, cacheGet()->Promise<obj|null>, cacheSet(obj)->Promise }, now?:()=>number })`
- `start() -> Promise<void>`：读缓存（命中的行直接可用）；把对白行按 `settings.batchSize` 切批；第 0 批与术语表请求同时发出；其余批次等术语表结束（成功或失败）后按优先级、并发 `settings.concurrency` 执行。
- `setPlayhead(t)`：优先级 = 包含/最接近 t 且 `end >= t` 的批次优先，其次按时间顺序在 t 之后的，最后是 t 之前的。
- `isReadyAt(t) -> boolean`：t 所在批次（若 t 之后 30 秒内无对白则视为就绪）已完成。
- `getLine(index) -> {t, s}|undefined`；`stats() -> {total, done, google, failedBatches, running}`；`onUpdate(cb)`；`retranslate(scope:'google'|'all')`；`stop()`。
- 每完成一批调用 `cacheSet`（含 `glossary`、`lines`），节流 1 秒。

- [ ] 测试（假 deps，可控 Promise）：第 0 批不等术语表；其余批携带术语表；`setPlayhead` 跳到后面后下一个发出的批次是目标批；缓存全命中时不调用 translateBatch；`retranslate('google')` 只重翻 `s==='google'` 的批次；`stop()` 后不再发请求。
- [ ] 失败 → 实现 → 通过。

### Task 6: 扩展骨架、后台与页面钩子

**Files:** Create `manifest.json`, `src/background/sw.js`, `src/page/hook.js`, `src/shared/settings.js`, `src/lib/ass.global.min.js`, `src/lib/ASSJS-LICENSE`, `icons/*.png`

- `manifest.json`：MV3；`permissions: ["storage","unlimitedStorage"]`；`host_permissions`：`https://www.crunchyroll.com/*`、`https://*.crunchyrollcdn.com/*`、`https://api.deepseek.com/*`、`https://translate.googleapis.com/*`；`optional_host_permissions: ["https://*/*","http://*/*"]`；content_scripts：① `hook.js` `world: "MAIN"`、`run_at: document_start`、`all_frames: false`；② 隔离世界 `document_start` 加载 `settings.js, ass.js, playback.js, llm.js, google.js, translator.js, session.js, lib/ass.global.min.js, content/overlay.js, content/content.js`；background `sw.js`（经典脚本，`importScripts` 共享模块）。
- `settings.js`：`DEFAULT_SETTINGS`（见 Global Constraints + `enabled:true, displayMode:'bilingual', translationPosition:'top', fontScale:1`）、`PROVIDER_PRESETS`（`deepseek`、`custom`）、`loadSettings()`/`saveSettings(partial)`、`parseExtraParams(str)`。
- `sw.js` 消息：`{type:'fetchText', url}`、`{type:'chat', messages}`（读设置自行调用 `chatCompletion`）、`{type:'google', texts, tl}`、`{type:'testConnection'}`。
- `hook.js`：包装 `window.fetch`，匹配 `/playback/v\d+/[^/]+/web/` 的 `play` 请求：等待内容脚本的配置消息（最多 1.5 秒，默认启用）；启用时用 `rewritePlayback` 改写并返回新 `Response`；把 `info` 和 `episodeId`、`document.title` 以 `postMessage({source:'crbs-page', type:'playback', ...})` 发出。包装 `XMLHttpRequest.prototype.open`，URL 含 `crbs_sub=` 时发 `{type:'subtitle-selected', lang}`。`hook.js` 内联一份 `rewritePlayback` 的拷贝（主世界不能加载隔离世界脚本）——通过 manifest 让 MAIN 世界也先加载 `src/core/playback.js` 解决，不复制代码。

- [ ] 验证：`node -e` 加载 manifest 校验 JSON 与文件路径全部存在。

### Task 7: 字幕显示层与内容脚本编排

**Files:** Create `src/content/overlay.js`, `src/content/content.js`, `src/content/overlay.css`（由 manifest 注入）

- `Overlay`：挂在 `.bitmovinplayer-container`（找不到则 video 父元素）下，`pointer-events:none`；按视频内容区（16:9 contain）定位；`requestAnimationFrame` 读 `video.currentTime` 找出当前对白（可多条），按模式渲染：双语（译文在上/下可配，译文字号 = 原文 × 1.15 × fontScale）、仅译文（缺译文时显示原文）、原文；字号随播放器高度缩放（原文 = 高度 × 0.045）。白字黑描边。特效行：用 ASS.js 渲染 `stripDialogue` 后的 ASS，容器同样覆盖视频区。提供 `showToast(text, ms)`、模式切换按钮（右上角，悬停显示，循环 双语→仅译文→原文）。
- `content.js`：读设置并把 `{type:'config', enabled}` 发给主世界；收到 `playback` 存字幕表与标题；收到 `subtitle-selected`：`none` 或非 ASS → 停止会话、清空（非 ASS 时提示）；否则经后台 `fetchText` 取 ASS → `parseAss` → 新建 `TrackSession`（缓存键 `cache:<episodeId>:<lang>:<targetLang>:<hash>`）→ 开播等待逻辑：会话未就绪时监听 `play` 立即 `pause()`，显示"正在翻译字幕…"，就绪或 25 秒后 `play()`；之后只在 `seeking` 时 `setPlayhead`。响应弹窗消息 `getStatus`、`retranslate`、`setMode`；监听 `chrome.storage.onChanged` 更新显示设置。

- [ ] 验证：在已登录的真实播放页加载扩展，按"真实页面验证"清单检查。

### Task 8: 设置页与弹窗

**Files:** Create `src/options/options.html|js|css`, `src/popup/popup.html|js|css`

- 设置页：供应商预设下拉（选择后填充 Base URL/模型/额外参数）、API Key（password 输入框，可显示）、模型、额外参数 JSON（保存时校验）、目标语言、显示模式、译文位置、字号缩放、批大小/并发/超时（高级）、"测试连接"、缓存统计与清空。保存时若 Base URL 源不在已授权列表，在点击处理函数内 `chrome.permissions.request`。
- 弹窗：总开关；当前标签页状态（已翻译 x/y 句、谷歌回退 z 句、失败批次）；"重翻谷歌部分"、"全部重翻"；"打开设置"。

- [ ] 验证：手动打开设置页保存/测试连接；弹窗在非 Crunchyroll 页显示"当前页不是 Crunchyroll 播放页"。

### Task 9: 真实页面验证

- [ ] 内置浏览器加载不了扩展，由用户在自己的 Chrome 中"加载已解压的扩展程序"测试；对照设计文档第 9 节验收标准逐条检查。
- [ ] `node --test tests/` 全部通过。
