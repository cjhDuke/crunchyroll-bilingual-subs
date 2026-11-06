# Crunchyroll 双语字幕

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Manifest V3](https://img.shields.io/badge/Chrome-Manifest%20V3-4285F4?logo=googlechrome&logoColor=white)](manifest.json)
[![Tests](https://img.shields.io/badge/tests-31%20passing-brightgreen)](tests)

一个 Chrome 扩展：把 Crunchyroll 播放器里选中的字幕（通常是英文）用大模型翻译成简体中文（也可改成其他目标语言），以**双语对照**显示。大模型失败时自动回退到谷歌免费机翻。

## 功能特点

- **双语对照**：译文与原文同屏显示，显示模式可在 双语 / 仅译文 / 仅原文 之间即时切换。
- **特效字幕保留**：招牌、标题等特效字幕用 [ASS.js](https://github.com/weizhenye/ASS) 按原样式渲染，不做翻译。
- **术语统一**：开播前先提取整集术语表，人名、地名等译法前后一致。
- **多供应商**：默认 DeepSeek，也支持任意 OpenAI 兼容接口（填 Base URL、API Key、模型名即可）。
- **可靠回退**：同一批翻译失败会重试一次，仍失败则改用谷歌机翻，最终兜底是只显示原文。
- **本地缓存**：每集译文保存在本地，重看不会重复调用接口，也不重复花钱。
- **隐私**：API Key 只保存在本地，只发送到你配置的接口地址。

## 安装

本扩展目前通过“加载已解压的扩展程序”安装，尚未上架 Chrome 应用商店。

1. 从 [Releases](../../releases) 下载最新版本的源码压缩包并解压；或直接克隆本仓库。
2. 打开 Chrome，地址栏输入 `chrome://extensions`。
3. 打开右上角的 **开发者模式**。
4. 点 **加载已解压的扩展程序**，选择包含 `manifest.json` 的文件夹。
5. 点击扩展图标 → **设置**，填入 API Key，点 **测试连接**，成功后点 **保存**。

更新代码后，在 `chrome://extensions` 里点本扩展的刷新按钮，再刷新 Crunchyroll 页面。

## 使用

- 打开任意番剧播放页，在播放器里选择英文字幕即可。开播时会先暂停几秒，等第一批译文出来后自动播放。
- 点扩展图标，在弹窗的 **字幕显示** 里切换 双语 / 仅译文 / 仅原文，立即生效（播放器上不放按钮，避免遮挡画面）。
- 原文是两行的句子，译文也会按两行显示。
- 扩展弹窗显示翻译进度和谷歌兜底的句数，可以 **重翻谷歌部分** 或 **全部重翻**。
- 缓存可在设置页清空。

## 环境要求

- Google Chrome（或其他基于 Chromium 的浏览器，需支持 Manifest V3）。
- 一个 Crunchyroll 账号，且有权观看所选视频。
- 一个大模型 API Key（默认 DeepSeek），或任意 OpenAI 兼容接口。不填也能使用，此时只走谷歌机翻。
- 运行测试需要 [Node.js](https://nodejs.org/) 18 或更高版本。

## 工作原理

- Crunchyroll 网页端默认播放“英文字幕烧进画面”的视频流。插件拦截播放信息接口 `playback/v4/.../play`，让播放器改播**无字幕的干净流**，再下载对应的 ASS 字幕自己绘制：
  - 普通对白：插件自绘，译文 + 原文双语显示；
  - 招牌、标题等特效字幕：用 ASS.js 按原样式渲染，不翻译。
- 翻译：整集按 30 句一批，按播放位置优先；第一批与“术语表提取”同时发出，之后各批都带上术语表。
- 失败处理：同一批大模型重试 1 次，仍失败则改用谷歌；都失败则这一批只显示原文。
- 关闭插件（弹窗总开关）后需刷新页面，才会恢复 Crunchyroll 原来的字幕流。

### 目录结构

```
manifest.json          扩展清单（MV3）
src/
  background/sw.js     Service Worker，代理大模型与谷歌的网络请求
  page/hook.js         页面主世界脚本，改写播放信息接口
  core/                字幕解析、大模型、谷歌机翻、翻译调度、会话
  content/             双语字幕渲染（overlay）与内容脚本
  popup/               扩展弹窗
  options/             设置页
  shared/settings.js   设置读写
  lib/                 第三方库（ASS.js，MIT）
tests/                 单元测试（node:test）
docs/                  设计文档与实现计划
```

## 更换模型 / 供应商

设置页选择 **自定义（OpenAI 兼容接口）**，填写：

- **Base URL**：请求地址为 `Base URL + /chat/completions`；
- **API Key**；
- **模型名**。

保存时 Chrome 会询问是否允许访问该域名。如果供应商需要额外参数（例如关闭思考模式），填在 **额外请求参数** 里，会合并进请求体，必须是 JSON 对象。

## 开发

```bash
node --test tests/*.test.js
```

设计文档见 [docs/specs/](docs/specs/)，实现计划见 [docs/plans/](docs/plans/)。

## 已知限制

- 只支持 ASS 字幕；配音版的 CC 字幕（VTT）暂不支持，会提示后跳过。
- 依赖 Crunchyroll 当前的接口结构，网站改版后可能需要调整 `src/page/hook.js` 和 `src/core/playback.js`。
- 谷歌机翻为兜底方案，会把换行合并为空格，译文不分行。
- 目前只在 Chrome 上测试过。

## 免责声明

- 本项目与 Crunchyroll、DeepSeek、谷歌均无关联，仅供个人学习和研究使用。
- 使用本扩展请遵守 Crunchyroll 的服务条款；请勿用于传播或商业用途。
- 译文由大模型或机器翻译生成，准确性不作保证。
- API 调用会产生费用，费用由使用者自行承担。

## 许可

[MIT](LICENSE)。第三方组件的许可见 `src/lib/ASSJS-LICENSE`。

## 致谢

- [ASS.js](https://github.com/weizhenye/ASS)（作者 weizhenye，MIT）：ASS 字幕渲染。
