# KokonaDSH 接手文档（给下一个 AI）

本文档面向接手本项目的 AI 助手。目标是让你在不问东问西的情况下，能改代码、验证、打包、发布到 GitHub 和 Codeberg。

先读 `AGENTS.md`（硬性规则），再读本文（工作流）。

---

## 1. 这是什么

KokonaDSH 是一个 **Electron 外壳**，包裹 DeepSeek Harness（`@deepseek-ai/dsh`）的公开 CLI。

- 不改、不 fork DSH core。只 spawn 公开 CLI。
- 外壳版本 `1.0.1`，核心运行时版本随 `@deepseek-ai/dsh` 走（当前 `0.1.7-rc.2`）。
- 用户数据：`%APPDATA%\KokonaDSH`（`config.json`、`logs\`、`runtime\`）。
- DSH 数据：`%USERPROFILE%\.dsh`（profile：`kokona`；安全模式 profile：`kokona-safe`）。
- 默认端口 `19387`。

### 目录

| 路径 | 作用 |
|---|---|
| `src/main/` | Electron 主进程。`runtime/` 管核心版本，`core/` 启动 CLI，`shell.ts` 是编排核心 |
| `src/main/core/recovery.ts` | **启动崩溃自愈**：识别插件错误、禁用插件、写 profile patch |
| `src/preload/index.ts` | 上下文桥 + 标题栏注入 + 所有注入 CSS（最重要的文件） |
| `src/renderer/` | 原生 TS 启动屏与核心面板，无框架 |
| `src/shared/` | 类型、常量、`KokonaApi` 面 |
| `.github/workflows/release.yml` | 三平台打包 + 发布 release |

---

## 2. 环境（最容易踩的坑）

**Node 不在系统 PATH 上。** 每个新 shell 先加：

```powershell
$env:Path = "C:\Program Files\nodejs;" + $env:Path
```

`gh`（GitHub CLI）同样不在 PATH：

```powershell
$env:Path = "C:\Program Files\GitHub CLI;" + $env:Path
```

其他注意：

- 不要用 `| Out-String`、`-RedirectStandard*` 这类会卡住输出的写法；用 `Write-Output` 打标记 + 轮询。
- 工具调用结束后后台进程会被杀，别指望后台常驻。
- PowerShell 5.1 按 GBK 读 `.ps1`：**带中文的 `.ps1` 必须加 UTF-8 BOM（EF BB BF）**，否则静默语法错误。
- 本项目 `Kokona DSH.exe` 有单实例锁（`requestSingleInstanceLock`）。要边跑用户实例边做测试，用独立 userData：
  `electron.exe --user-data-dir=<临时目录> .`
- **模型看不到图片**：视觉验证靠 DOM/几何 dump + 日志自测，不要凭感觉声称“改好了”。

---

## 3. 常用命令

```sh
npm run dev          # 开发，热重载
npm run typecheck    # tsc 三份 tsconfig，必须过
npm run build        # 产出 out/main out/preload out/renderer
npm start            # 跑构建产物
npm run pack         # 刷新 release/win-unpacked（exe 被占用时会失败，先关掉正在跑的程序）
npm run dist         # 出安装包
npm run prepare:baseline  # 把一个核心 vendor 到 resources/runtime-baseline
```

**每次改完必跑**：`npm run typecheck` + `npm run build`，两个都要绿。

手动冒烟：`npm run dev` 能起核心、标题栏盖在 DSH 页面上、`Ctrl/Cmd+Shift+K` 打开核心面板。

---

## 4. 日志与自测

应用日志：`%APPDATA%\KokonaDSH\logs\kokona-YYYY-MM-DD.log`（主进程 + 核心 stdout 都在里面）。

环境变量自测钩子（都在 `src/main/`，用环境变量开启）：

| 变量 | 作用 |
|---|---|
| `KOKONA_TERMINAL_TEST` | 启动后自动开终端并回报窗口标题，验证终端链路 |
| `KOKONA_RECOVERY_TEST` | 首次 boot 注入“插件崩溃”并失败，验证自愈编排（会写一行惰性 patch，记得清理） |
| `KOKONA_CHAT_SCAN` | 10 轮聊天界面底色 + 子树 dump |
| `KOKONA_SETTINGS_SCAN` | 设置页每个 tab 的背景色统计 |
| `KOKONA_UPDATE_TAB_TEST` | 打开设置→点「检查更新」→再点别的标签，dump 面板状态（验证是真页面而非叠层） |
| `KOKONA_ANALYZE` / `KOKONA_CAPTURE` / `KOKONA_DOM` / `KOKONA_SELFTEST` / `KOKONA_SETTINGS_TEST` / `KOKONA_RIGHTPANEL` | 其他截图/几何/DOM 诊断 |

临时用 esbuild 单测某个纯模块（绕过 electron 依赖）：

```powershell
& node_modules\.bin\esbuild.cmd src/main/core/recovery.ts --bundle --format=cjs --platform=node `
  --alias:electron=<stub.js> --outfile=<bundle.cjs>
node <test.cjs>
```

`stub.js` 里给 `app.getPath` 之类打个桩即可。

---

## 5. 启动崩溃自愈（本轮新增功能）

需求：启动失败时自动查日志。若某个插件导致失败 → **自动禁用该插件并重启**（不进安全模式）；若仍失败或错误与插件无关 → 重启进安全模式。

实现要点（`src/main/core/recovery.ts` + `src/main/shell.ts`）：

- `Shell.boot()` 是**明确的三段式，没有循环**：
  1. 启动一次。成功且无插件故障 → 直接返回（健康启动只花一次启动 + 一次极轻量日志扫描）。
  2. 若有插件故障 → 禁用该插件，重试一次。
  3. 仍失败或无插件线索 → 写入 `safeMode`，再重试一次；还不行就停在启动屏。
- “启动失败”包含两种：
  - 核心进程退出 / 服务器超时（`bootOnce` 抛错）；
  - **核心起来了但插件激活失败**（DSH 打印 `dsh: warning: N entry did not activate` + `<id> (<name>): <Error>`，UI 显示 “Failed to load plugins”）。这是成功启动里的部分失败，同样会触发禁用。
- 错误识别：
  - 一级：cordis 的入口错误格式 `<entryId> (<package>): <Error>`（例：`token-usage-counter (dsh-token-usage-counter): TypeError: ...`）。
  - 二级：日志里出现已知插件包名且该行含错误关键字（用于插件抛栈崩溃）。
  - **核心包（含 `@deepseek-ai/`）永不当作插件**，这类错误直接走安全模式。
- 禁用方式：往 `~/.dsh/profiles/<profile>/cordis.patch.yml` 追加
  ```yaml
  - id: <entryId>
    disabled: true
  ```
  这是 DSH 官方的 profile patch 机制，幂等。`enablePlugin()` 可撤销。
- 只扫本次尝试新增的日志（`attemptStart` 之后），避免误判历史错误；同 session 不重复禁用同一插件。
- 验证禁用是否生效：`dsh --profile kokona --dump-config`，看对应行是否 `disabled: true`。

### 重启时的竞态（重要，别改回去）

`src/main/core/process.ts` 里，**旧核心的 `exit` 回调必须做身份校验**（`if (this.child !== child) return`），且 `stop()` 要**等旧进程真正退出**再返回。否则重启时旧进程的退出事件会把共享的 `exited` 置真，令新一次启动的 `waitForServer` 误判“已中止”，重试必然失败（现象：新核心秒退 exit 1、无任何输出，然后误进安全模式）。


---

## 6. 发布工作流（GitHub + Codeberg）

### 远端

```sh
git remote -v
# github  git@github.com:AkizukiKokona/Kokona-DSH.git
# codeberg git@codeberg.org:AkizukiKokona/Kokona-DSH.git
```

### 认证

- GitHub：`gh` 已登录 `AkizukiKokona`（scopes: repo, workflow, read:org）。OAuth 设备码登录助手 `scripts/gh-device-login.mjs`（`start`/`finish`），token 存 `%LOCALAPPDATA%\KokonaDSH\tools\github-token`。这两个 login 脚本**已被 `.gitignore` 忽略，不要提交**。
- Codeberg：token 在 `%LOCALAPPDATA%\KokonaDSH\tools\codeberg-token`（40 字符）。Codeberg 是 gitea-1.22，**没有设备码流程**；登录助手 `scripts/codeberg-login.ps1`（本地 WinForms 弹窗，中文，需 UTF-8 BOM）。

### 发布步骤

1. 改代码，`npm run typecheck && npm run build` 全绿。
2. 提交并推双远端：
   ```sh
   git add -A
   git commit -m "..."
   git push github main
   git push codeberg main
   ```
   GitHub 偶发 DNS/HTTPS 抖动（`Could not resolve hostname github.com` / `ConnectTimeoutError`）——**包重试循环**，通常 1~4 次内成功。
3. 打 tag 触发 Actions（`release.yml` 在 tag push 时构建三平台并发布 release；`workflow_dispatch` 只构建不发布）。**发新版本**（1.0.0 → 1.0.1）直接建新 tag；**同一个版本要重发**（比如上次构建挂了、或者改了代码还要留在原版本号）才需要先删 release + 删 tag 再 `git tag -f`：
   ```sh
   # 新版本：
   git tag v1.0.1 <sha>
   git push github v1.0.1
   git push codeberg v1.0.1

   # 同版本重发（把 vX.Y.Z 换成当前版本）：
   gh release delete v1.0.1 --repo AkizukiKokona/Kokona-DSH --yes --cleanup-tag
   git push codeberg :refs/tags/v1.0.1
   git tag -f v1.0.1 <sha>
   git push github v1.0.1
   git push codeberg v1.0.1
   ```
4. 等构建：
   ```sh
   gh run list --repo AkizukiKokona/Kokona-DSH --workflow release --limit 2
   gh run watch <run-id> --repo AkizukiKokona/Kokona-DSH --exit-status
   ```
5. 确认 4 个资产（版本号跟着 `package.json` 走）：
   ```
   KokonaDSH-Setup-<version>.exe             # Windows
   KokonaDSH-<version>-mac-arm64.dmg         # macOS Apple Silicon
   KokonaDSH-<version>-mac-x64.dmg           # macOS Intel
   KokonaDSH-<version>-linux-x86_64.AppImage # Linux
   ```
   ```sh
   gh release view v1.0.1 --repo AkizukiKokona/Kokona-DSH --json assets
   ```
6. 下载。**不要用 `gh release download`** —— 它是单流，在直连不稳的线路上会慢到你以为卡死了，而且全程没有任何进度输出。用 4 个 `curl.exe` 并发直连，422 MB 大约 35 秒：
   ```powershell
   $base = 'https://github.com/AkizukiKokona/Kokona-DSH/releases/download/v1.0.1'
   foreach ($f in $files) {
     Start-Process -NoNewWindow -FilePath curl.exe -ArgumentList @(
       '-sS','-L','-C','-','--retry','5','--retry-all-errors','-o', "$dir\$f", "$base/$f")
   }
   # 然后每隔十几秒比对 $dir 里的文件大小与 release 里的 size，直到逐个相等
   ```
   直连慢的备选（本轮实测）：`https://gh-proxy.com/<完整 github url>`（28 MB/s）、`https://ghfast.top/...`，以及本机 Clash 的 `--proxy http://127.0.0.1:7897`（已验证可用）。
7. 同步到 Codeberg。**发新版本**时 Codeberg 上还没有 release（推 tag 不会自动建 release），先 `POST /releases` 建，再传 4 个资产；**同一版本重发**才是先删旧资产再传。

### Codeberg API（gitea 1.22，路由别记错）

```text
GET    /api/v1/repos/{owner}/{repo}/releases/tags/{tag}            # 查 release 及其 assets
POST   /api/v1/repos/{owner}/{repo}/releases                       # 建 release（新版本必须先建）
PATCH  /api/v1/repos/{owner}/{repo}/releases/{release_id}          # 改 release（body 等）
DELETE /api/v1/repos/{owner}/{repo}/releases/{release_id}/assets/{asset_id}   # 删资产（正确路由！）
POST   /api/v1/repos/{owner}/{repo}/releases/{release_id}/assets?name=<文件名>  # 传资产
```

- 注意：`DELETE .../releases/assets/{asset_id}` 会 **404**，必须带 release_id。
- 传文件用 `curl.exe` 的 multipart，字段名 `attachment`；token 写进 header 文件避免回显：
  ```powershell
  "Authorization: token $token" | Set-Content -Encoding ASCII <header文件>
  curl.exe -s -S -X POST -H "@<header文件>" -F "attachment=@<文件>" `
    "https://codeberg.org/api/v1/repos/AkizukiKokona/Kokona-DSH/releases/<release_id>/assets?name=<文件名>"
  ```
- Codeberg 仓库需要 `has_releases = true`，否则 release 接口 404：
  `PATCH /api/v1/repos/{owner}/{repo}` body `{"has_releases":true}`。
- 传完对比 GitHub 与 Codeberg 的字节数，逐个匹配才算成功。实测上传速度约 5 MB/s，422 MB 约 90 秒。
- **PowerShell 的 `ConvertTo-Json` 会把字符串包成对象**（`{"body":{"value":"…","Drives":"C D","ReadCount":1}}`），Codeberg 直接 422 `cannot unmarshal object … of type string`。别用它发 body：手工转义（`\` → `\\`、`"` → `\"`、换行 → `\n`）后写成 UTF-8 **无 BOM** 文件，再 `curl.exe --data-binary "@<json文件>"`。

---

## 7. 代码约定（血泪教训）

- **绝不锚定 hash 前缀类名**（如 `zGbnIq_`、`rtSEdW_`、`hHd-Xa_`）。只锚定类名**后缀**（`_rowCard`、`_card`、`_newSession`、`_file`…）或结构位置（`settings.action` 槽、`class*="_actions"` 且前一个是 `button[class*="_close"]`）。
- 注入半透明底色时，**只给最外层元素上色**。用 `:not([class*="X"] *)` 排除后代，否则多层 0.72 白叠加会变成纯白块（文字底下发白就是这个原因）。
- 不要动 `--dsh-sidebar-height`，不要占用右栏宽度（那是 better-sidebar 的）。
- 标题栏绝不能挡交互：拖拽区是交互元素之间的空隙，不是全宽覆盖层。
- 安全模式必须走 `<profile>-safe`（`web` 模板），不要靠猜 loader id 去禁插件。
- 关窗只是隐藏，应用常驻托盘；不要从 `window-all-closed` 退出，所有退出走 `before-quit`（先停核心）。
- 渲染层保持零依赖。

---

## 8. 已知坑速查

| 现象 | 原因 / 处理 |
|---|---|
| `npm`/`node` 找不到 | Node 不在 PATH，先拼 `C:\Program Files\nodejs` |
| GitHub push 解析失败 | 瞬时 DNS，重试循环 |
| `npm run pack` 失败 | 正在跑的 `Kokona DSH.exe` 占用文件，先关闭 |
| 终端按钮没窗口 | 已修：`stdio:'ignore'` 会给 powershell 一个 NUL stdin，`-NoExit` 也会秒退；现在走 `cmd /c start` 开新控制台 |
| 聊天/产物文字底下发白 | 注入规则命中了嵌套子元素导致多层叠加，用 `:not(... *)` 只染最外层 |
| 主题选中项看不出区别 | 选中态被 `!important` 底色覆盖，需给 `[class*="_themeCube"][class*="_selected"]` 加白边/描边 |
| 设置里 `_themeCube` 无差异 | 同上 |
| 插件市场卸载失败 | pnpm `minimumReleaseAge` 策略违规，见第 10 节 |
| 「检查更新」半透明叠在上一页 | 旧叠层实现，见第 11 节（需重新 pack 才生效） |
| 改了代码界面没变化 | exe 未重新 `npm run pack`（且打包前要关掉正在运行的 exe） |

---

## 9. 本地快捷方式

项目根目录有 `Kokona DSH.lnk`，指向 `release\win-unpacked\Kokona DSH.exe`。改完代码要让它生效：关闭正在运行的程序 → `npm run pack` → 双击快捷方式。

> **改完源码一定要重新 `npm run pack`。** exe 不会自动更新；用户报「改了没效果」几乎都是因为跑的还是旧 exe。打包前必须先关掉正在运行的 `Kokona DSH.exe`，否则文件被占用会失败。

---

## 10. 插件管理：卸载失败的坑（pnpm minimumReleaseAge）

- 现象：插件市场点「卸载」失败。市场日志在 `~/.dsh/profiles/<profile>/.dsh-market/log.ndjson`：
  `uninstall <pkg> exit=1 err=ERR_PNPM_RESOLUTION_POLICY_VIOLATIONS_UNHANDLED: 1 resolution-policy violation was produced but no handleResolutionPolicyViolations callback was wired to them.`
- 原因：市场（dshmarket）给 profile 启用了 `minimumReleaseAge`（默认 1440 分钟；实际值见 `~/.dsh/profiles/<profile>/node_modules/.pnpm-workspace-state-v1.json` 的 `settings.minimumReleaseAge`）。卸载时 pnpm 重新解析依赖，若有「太年轻」的新版本就产生 resolution-policy violation；而 DSH 插件管理器用**编程 API** 调 pnpm 时没接 `handleResolutionPolicyViolations` 回调，于是直接抛错。
- 修法：把该包加进 profile 的 `pnpm-workspace.yaml`：
  ```yaml
  minimumReleaseAgeExclude:
    - <pkg>@<version>
  ```
  违规消失后卸载即可成功（市场自身也会用 `--config.minimum-release-age=0` 重试一次）。
- 相关日志：市场 `~/.dsh/profiles/<profile>/.dsh-market/log.ndjson`；插件管理器 `~/.dsh/profiles/<profile>/.plugin-manager/logs/operation-*/pnpm.log`。
- 卸载成功后，市场会顺手删掉它在 `cordis.patch.yml` 里的行；自愈写入的 `disabled: true` 行也会被清掉（实测日志：`removed patch rows for token-usage-counter`）。
- 判断插件是否还装着：看 `~/.dsh/profiles/<profile>/package.json` 的 `dependencies` 与 `dsh.profile.bundles`，以及 `node_modules/<pkg>` 是否存在。

---

## 11. 注入的「检查更新」设置页

- `src/preload/index.ts` 的 `injectSettingsTabs()` 克隆一个 `_navCell` 加「检查更新」；点击调用 `openUpdateTab()`。
- 正确行为（真页面）：隐藏 `_options` 的原有子节点（打 `data-kokona-options-hidden` 记录原 `display`），把面板按正常流追加进去，并给导航项加 active 类 + `aria-current=page`；切走时 `closeUpdateTab()` 还原。
- **不要改回 `position:absolute; inset:0` 的叠层做法**——那样会半透明盖在上一页上（曾经的 bug）。
- 自测：`KOKONA_UPDATE_TAB_TEST=1`，期望日志：
  `update tab open: ... {"panel":true,"position":"static","hidden":1,"visible":0,"active":["..._active"],"ariaCurrent":"page"}`
  `update tab close: ... {"panel":false,"hidden":0}`
- 注入必须是**前缘（leading edge）**。设置弹窗由 `createPortal` 挂到 `<body>`，所以观察 body 的直接子节点（`childList: true`，不递归）判断弹窗挂载，然后在**下一帧 rAF** 里注入 —— 这样「检查更新」和 shell 自己的 nav 项同一帧上屏。**不要改回 250ms 防抖**：那正是「它比其它按钮晚一步弹出来」的原因。
- `settingsRoot()` 带缓存（缓存节点必须仍 `isConnected` 且含 `_navList`）。弹窗关着的时候，全文档的观察器回调只做一次 `isConnected` 读取，不做扫描；另有 1.2s 兜底轮询。
- 面板里的版本号是 `<code>`，会被 `code:not(pre code)` 的 0.72 白 chip 命中；在 12% 玻璃设置窗里那就是一块纯白（「字体那里是白底、周围一圈半透明」）。**别给它刷任何 layer token**：wallpaper-engine 把 `--dsw-alias-bg-layer-1/2/3` 全部重映射成同一块玻璃色，拿 layer token 给子元素上色 = 在弹窗玻璃上再叠一层，比弹窗本身白一档 —— 第一版改成 `bg-layer-3` 之后剩下的就是这个「色差」。现在版本号 `<code>` 和发行说明 `<pre>` 都是 `background: transparent`，直接透出所在行的玻璃色；行本身只有描边（`item` 和 `actionButton` 都是 `background: transparent`），所以整行颜色一致。

---

## 12. 当前未提交的改动（交接状态）

工作区有未提交改动（`git status` 可见），按功能分：

| 文件 | 内容 |
|---|---|
| `src/main/core/recovery.ts`（新增） | 插件故障识别 + 禁用/启用 patch |
| `src/main/core/profile.ts` | 导出 `profileDir` |
| `src/main/shell.ts` | 三段式 `boot()` 自愈编排 |
| `src/main/core/process.ts` | 重启竞态修复（exit 身份校验 + `stop()` 等待进程退出） |
| `src/preload/index.ts` | 「检查更新」真页面修复 + 半透明表面补齐 + 顶栏留白重写 |
| `src/main/windows.ts` | 新增 `KOKONA_UPDATE_TAB_TEST` 等诊断 |
| `.gitignore` | 忽略 `*.lnk` |
| `repack.cmd`（新增） | 一键打包重启（见第 13 节） |
| `HANDOFF.md`（新增） | 本文档 |

上一个已提交的 commit 是 `07e90de`（终端 `cmd /c start` 修复等）。本节描述的改动已于 1.0.1 发布（见第 15 节）。

**下一个 AI 要做的事**：`npm run typecheck && npm run build` → 关闭正在运行的 exe → `npm run pack` → 按第 6 节提交、推双远端、打 tag、等 Actions、下载资产、同步 Codeberg。

---

## 13. 半透明表面与顶栏留白

### 半透明表面（`ensureShellStyle` 里那坨 CSS）

注入半透明底色时，**只给最外层元素上色**，用 `:not([class*="X"] *)` 或 `:has(> ...)` 卡住。两层 0.72 的白叠起来就是 0.92，看起来还是纯白——这就是「产物上面那张『已编辑 N 个文件』卡片还是白底」和「代码编辑段还是白底」的根因。

| 表面 | 稳定锚点 | 处理 |
|---|---|---|
| 已编辑 N 个文件卡片 | `[data-changed-files]`（deliverables 自带属性） | 卡片刷 `--kokona-surface-glass`；`--changes-fill` 设 `transparent`，否则 header 会再刷一层 |
| 所有代码表面（代码块 / 编辑 diff / 工具 IO 卡 / skill 卡） | 统一走 token `--dsw-alias-markdown-code-block` | 在 `body` 上把该 token 指到 `--kokona-surface-chip`（必须写 `!important`，主题在 `body{}` 里定义它） |
| 代码卡 toolbar、代码块 sticky banner、代码块 `<pre>` | `[data-code-block-banner]` / `[data-code-block-content] pre` | 刷 `transparent`，让下层的卡片透上来 |
| skill 卡头部 | `[class*="_instructionsCard"] > [class*="_instructionsHeader"]` | 同上 |

**已知残留**：工具详情面板（`DXqwVW_root`）本身也是 code-block token，里面再嵌一个 `CodeBlock` 时会叠成 0.92（比周围略白一档）。CSS 无法判断「祖先是否已经刷过底色」，要彻底解决只能逐个把 token 使用者改成叶子刷色，代价大，先留着。

### 顶栏（`installTitlebar` 的 `layout()`）

原来给右上角每个 cluster 无条件刷 `marginRight = 3*46+12 = 150px`，问题一串：

1. `_headerUtilities` 和 `_headerCorner` 是两个并列 cluster，**各刷 150px**；不在 cluster 里的按钮还会各自再刷 150px → 累加过量。
2. 写死 150px，不看真实控件宽度和 `insetRight`。
3. 永久覆盖 `_headerCorner` 自带的 `margin-right:-16px`。
4. 元素掉出「右半边」筛选后 margin 从不还原 → 来回跳。
5. `layout()` 清空重建拖拽层，这会再触发自己的 `MutationObserver` → 每 200ms 自激一次，把上面的抖动放大成持续漂移。

现在的做法（**不要退回写死值**）：

- `topStripClusters()` 按几何找「顶栏右侧最外层容器」：祖先必须整体在顶栏内、留在右半边、不出窗口、且宽度 ≤ 窗口一半（否则会一路爬进会话头或整列）。最多上溯 4 层。
- 从右往左依次处理，`boundary = 控件左边界 - 12`，每个 cluster 只移 `自然右边界 - boundary`（夹在 `[0, SHIFT_MAX]`），移完把 `boundary` 推到它左边界再减 12 → 相邻 cluster 各自让位，不叠加。
- `shiftState`（WeakMap）记住每个元素**原始** `marginRight` 和当前位移；位移归零时写 `''` 把属性交还给 shell 自己的规则（`-16px` 就是这么保住的）。不再符合条件的元素会被显式还原。
- 没有自绘控件（`controlsRect.width <= 0`，macOS / 原生控件）时全部还原，不做无意义位移。
- `MutationObserver` 过滤掉 target 在 `#${HOST_ID}` 里的记录，拖拽层的增删不再自激。

**开/关侧栏时的漂移（第二轮修复）**，三个原因叠在一起：

1. **只观察 `childList` 是不够的。** 开合侧栏只是翻一个 class / `data-sidebar-right-open` 属性再动画宽度，**一个节点都不增删** → 旧观察器完全看不到，预留 margin 停在旧值上，按钮就歪在那里；之后随便哪个 childList 变动才把它算回来 —— 这就是「有概率漂移 / 漂一下就回去」。现在观察器加了 `attributes: true` + `attributeFilter`（`class` / `data-sidebar-right-open` / `data-sidebar-right-panel` / `data-dsh-better-sidebar` / `data-we-*`）。
2. **动画中途不能量尺寸。** 侧栏宽度在过渡，顶栏每个 rect 都是动画快照，拿它算出来的位移下一趟就得撤回 → 肉眼就是「弹出去又弹回来」。`topStripBusy()` 用 `document.getAnimations()` 找顶栏范围内还在跑的 `CSSTransition`，busy 就**保持当前位移**，140ms 后重测（`scheduleRetry()` 单飞，`retries` 上限 40 防死循环）。
3. **一次性快照要两次确认。** `pendingShift`（WeakMap）要求同一个目标值连续出现两趟才落盘；只出现一次的（slot 重挂、动画某一帧）直接丢掉，不做任何位移。`boundary` 用的是**实际生效**的位移，所以延后确认不会影响下一个 cluster 的算法。

### 右侧栏的半透明（wallpaper-engine）

右侧栏走的是插件**独立**的一套旋钮（`侧栏模糊` / `侧栏透明度` / `侧栏玻璃颜色` → `--we-sidebar-blur/alpha/color/tint`），和输入框那套（`玻璃` 滑块 → `--we-blur` / `--we-glass-alpha`）**故意解耦**。当时的值是 `sidebarBlur:172` + `sidebarAlpha:173` + `sidebarColor:#67DCE7` → 172px 模糊 + saturate 2.83，直接糊成云母。

输入框（`[data-composer-card]`，读 `--dsw-specific-input-major`）的配方是：`rgba(255,255,255, glassAlpha*0.8)` + `blur(var(--we-blur))` + `saturate(var(--we-saturate))`。所以右侧栏只**重绑变量**（[`src/preload/index.ts`](src/preload/index.ts) 的 `ensureShellStyle`），不重写整条规则 —— 闭合态清除、不支持 backdrop-filter 的降级都留在插件里：

```css
body[data-we-sidebar-glass] [data-sidebar-right-panel][data-sidebar-right-open] {
  --we-sidebar-blur: var(--we-blur, 16px);
  --we-sidebar-tint: calc(var(--we-glass-alpha, 0.2) * 80%);
  --we-sidebar-saturate: var(--we-saturate, 1.8);
  --we-sidebar-sheen: 1;
}
```

**只绑右侧栏**（选择器带 `[data-sidebar-right-panel]`），左侧栏保持原样。`--we-sidebar-tint` 是 `color-mix` 里的百分比，**必须带 `%`**，且 `calc(数字 * 80%)` 合法；颜色不覆盖，所以侧栏仍保留自己的色调、和输入框区分得开。副作用：右侧栏从此跟 `玻璃` 滑块走，`侧栏` 那三个滑块只影响左侧栏。

### repack.cmd

`release/win-unpacked/Kokona DSH.exe` 是 `asar: true` 打出来的，跑着的时候换不了 `app.asar`。所以：托盘退出（点 X 只是隐藏，进程还在）→ 双击 `repack.cmd` → 脚本等进程退出、`npm run pack`、成功后自动重新拉起。脚本里的等待用 `ping -n N 127.0.0.1 >nul`，**不要用 `timeout /t`**（非交互控制台会报 Input redirection is not supported）。

**拉起必须用 `explorer.exe "<exe>"`，不能用 `start`。** Electron 会 attach 到父控制台（Chromium 的 Windows console handler 会处理 `CTRL_CLOSE_EVENT`），所以 `start` 拉起来的那个进程会跟着 CMD 窗口一起被杀 —— 「关掉窗口把应用也带走了」就是这么来的。`explorer.exe` 自己没有控制台、也不在这个控制台的 job object 里，实测：用它拉起来的进程在 `taskkill /F /T` 掉整个控制台进程树之后依然活着。应用本身不依赖 cwd（`src/main` 里所有路径都走 `process.resourcesPath` / `app.getAppPath()`，spawn 核心时都是显式 `cwd`），所以不设工作目录也没关系。

## 14. 纯白底的根因（第四轮）

### 为什么一直有「纯白」

wallpaper-engine 只在**一个 scope** 里重刷 surface token：

```css
body[data-we-glass-window] [role="dialog"]:has([data-slot="settings.section"]) {
  --dsw-alias-bg-layer-1/2/3: color-mix(in srgb, var(--we-glass-color) …%, transparent);
}
```

也就是说：**设置对话框以外的全app**，`--dsw-alias-bg-layer-1/2/3` 还是 shell 的原生值 —— 浅色下这三个 token 全是 `#fff`，深色下是 `#1c1c1e/#232325/#2c2c2e`。插件已经把 `--dsw-alias-bg-base` 全局置为 `transparent`（壁纸就是页面底），但 `bg-layer-*` 没跟上，于是**任何拿 bg-layer-* 当填充的元素，在壁纸前都是一块纯白**。这一轮报的两个点全是这个：

| 位置 | 选择器 | 填充 token |
|---|---|---|
| 「加载更早」（会话顶部） | `[class*="_older"] > button` | `--dsw-alias-interactive-bg-hover-solid`（不透明）；加载中之所以看着正常，是 disabled 掉了 `opacity:.6` |
| 右下角回到底部的箭头 | `button[class*="_toBottom"]` | `--dsw-alias-button-floating-fill`，且没有 backdrop blur |

另外 `--dsw-alias-bg-module-platform` **插件从来没重刷过**（值 = `#f5f6f7` / `#2c2c2e`），所以设置面板里所有读它的东西都是一块实心板。这一轮改成在设置面板 scope 内把它接到 `--kokona-surface-glass`：

```css
html [class*="_panel"]:has([class*="_navList"]) { --dsw-alias-bg-module-platform: var(--kokona-surface-glass); }
```

**加新规则时先问：这个 token 在「设置对话框 / 会话区 / 其它」哪个 scope？** 只有前两个 scope 被处理过。

### Agent 预设面板（设置 → Agent）

| 元素 | 原始样式 | 现在 |
|---|---|---|
| `li[data-agent-preset-id][class*="_cardActive"]` | `background: var(--dsw-alias-bg-module-platform)` → 一块黑/实心 | 和 `_themeCube[selected]` 同款：`--kokona-surface-selected` + 白描边 + ring |
| 同上 `[class*="_cardSelectionDisabled"]` | 同一个 token | `--kokona-surface-soft`（是「不可选」，不是「已选中」） |
| `[data-tone="solid"]`（「新任务默认」Tag） | `background: var(--dsw-alias-label-primary)`（浅色下近黑）+ `color: var(--dsw-alias-bg-layer-3)`（被插件刷成半透明 → 字几乎看不见） | 亮底 + 显式 `--dsw-alias-label-primary` 文字 |
| `[data-agent-preset-id] code`（卡片右上角的预设 id） | 命中全局 `code:not(pre code)` 的 0.72 chip，叠在卡片玻璃上 → 比周围白一档 | `transparent` |

`data-agent-preset-id` / `data-tone` 都是 shell 源码里写死的属性，是这里唯一该用的锚点。

### 「SERVER」提示 —— 真凶是我自己写的全局 `code` 规则

`dsh-client-ui-chat` 的 `MessageItem` 里，失败 turn 的提示长这样：

```jsx
<div className="Sixlwa_turnErrorRow" role="status">   // 这一层没有底色
  <StateDot state="error"/>
  <span className="Sixlwa_turnErrorTitle">运行失败</span>
  <span className="Sixlwa_turnErrorMessage">{…}</span>
  {node.code && <code className="Sixlwa_turnErrorCode">{node.code}</code>}   // ← 就是 SERVER
</div>
```

那个 `SERVER` 是一个 **`<code>`**。而 preload 里当时有一条全局规则：

```css
code:not(pre code) { background-color: var(--kokona-surface-chip) !important; }
```

于是它被刷上 0.72 白。而 `.turnErrorCode` 自己**只有颜色和字体、没有 border-radius** —— 出来就是「四个直角的半透明矩形」。同一条规则还误伤了更新面板的版本号 `<code>` 和 Agent 预设卡片的 id `<code>`（那两处我之前是靠逐条例外压下去的，属于治标）。

**现在这条全局规则删掉了**，改成给 shell 自己的 inline-code token 换值：

```css
body { --dsw-alias-markdown-inline-code: var(--kokona-surface-chip) !important; }
```

因为 shell 本来就只给 markdown 里的行内代码上色（`MarkdownText.module.css` 的 `.markdown :not(pre) > code`，自带描边和圆角），换 token 既保住行内代码的观感，又**不再碰任何「恰好是 `<code>`」的标签** —— 那两条 per-element 例外也一并删了。以后再看到「某个 `<code>` 白了一块」，先想这条，别再加例外。

### 归属提示卡（`data-turn-trigger`）

上一轮我把 `SERVER` 误判成了它（`TurnTriggerNodeView`，webhook / goal / subagent 触发的 turn 说明）。它不是 `SERVER`，但它确实也吃 `--dsw-alias-markdown-code-block`，被接到 chip 之后同样变成白块，所以顺手保持无底无框。想还原它原本的卡片观感就删掉这一条：

```css
[data-turn-trigger] { background-color: transparent !important; border-color: transparent !important; }
```

### 已知还没动的（同一根因，等 YG 点名）

这些也在设置对话框 scope 外、拿原生 token 填充，现在还是纯白/实心，没动是因为它们里有些是**整页容器**，刷成薄纱会把整个视图糊掉：

- 轨迹视图整页：`.qBU-ya_root` / `.Y0dWHa_split` / `.fV0t5q_root`（`bg-layer-1`）
- 插件管理器的弹窗：`.X_2TxG_registry` / `.guide` / 各种 input（`bg-layer-1/2/3`）
- 右侧栏里的空态入口卡：`.geFEbW_entry` / `.zjup-W_entry`（`bg-layer-1`）
- 文档预览浮层：`.lyqg2a_panel` / `.JqwYuG_panel` / `.dhJKeW_*`
- 会话里的 turn 预览浮层 `.eGxaPq_preview`、deliverables 输出块 `._93YTAG_output`、subagent 框 `.XJ7liG_frame` —— 这三个已经被 `body[data-we-wallpaper] [data-conversation-scroll] { --dsw-alias-bg-layer-1: var(--kokona-surface-glass) }` 覆盖掉了

要一把全刷，把上面那条 conversation-scope 的 remap 去掉 scope、改成 `body[data-we-wallpaper]` 即可 —— 但整页容器会一起变薄纱，得先确认视觉效果。

### 启动页那句

`src/renderer/src/boot.ts` 往 `main.splash` 末尾加了一个 `.splash__blessing`（绝对定位，`top:60%` + `translateX(-50%)`，`--muted` 灰），`main.splash` 因此加了 `position:relative`。位置是「中间偏下但不贴底」：`top` 百分比改一个数就能挪。

---

## 15. 1.0.1 发布记录（2026-09-26）

一次走完第 6 节的流程，记下实际结果和踩到的坑。

| 项 | 值 |
|---|---|
| commit | `bd09384` fix: scope the inline-code chip to markdown, glass the remaining white surfaces |
| tag | `v1.0.1` → `bd09384`，已推 github + codeberg |
| Actions run | `36170193778`，三平台全绿（mac 2m18s / win 2m15s / linux 1m10s） |
| GitHub release | 4 个资产，`95217983` / `112082089` / `117105786` / `117416709` 字节 |
| Codeberg release | id `12457887`，4 个资产字节数与 GitHub **逐个相等** |

本轮新增的规矩：

1. **`gh run watch` 每 3 秒重刷整个 job 状态**，一次 `watch` 能吐几千行。要盯构建就轮询 `gh run list --workflow release --limit 2`，别用 watch。
2. **`gh release download` 不要用**：单流、无进度输出，看起来就是卡死。改成 4 个并发 `curl.exe`（见第 6 节第 6 步），422 MB 约 35 秒；直连慢就换 `gh-proxy.com` 镜像或本机 `127.0.0.1:7897` 代理。
3. **任何下载/上传都别写成一条长阻塞命令**。用 `Start-Process` 起独立进程或后台 job，然后隔十几秒比对文件大小，把「X / Y MB」报出来 —— 否则用户分不清是真卡还是在跑。
4. **新版本在 Codeberg 上要先 `POST /releases` 建 release**（推 tag 不会自动建），拿到 release id 才能传资产；同一版本重发才是「先删资产再传」。
5. `package-lock.json` 的 version 字段从 0.1.0 起就没跟过 `package.json`，`npm ci` 不受影响，别去动它。
6. `repack.cmd` 是 CRLF 的批处理，而仓库的 `.gitattributes` 是 `* text=auto eol=lf` —— 新加的 `*.cmd/*.bat eol=crlf` 保证 clone 下来是 CRLF（cmd.exe 对纯 LF 的 goto/label 会解析错）。

---

## 16. 1.0.2 进行中（底栏玻璃 + 打开方式菜单抖动）

### 底栏（better-sidebar 的 bottom dock）

`dsh-better-sidebar` 的底部工作台：

```css
.nArs4W_bottomPanel { background: var(--dsw-alias-bg-layer-1); /* 不透明 #fff */ }
```

而 wallpaper-engine 只在设置对话框里重映射 `bg-layer-1/2/3`，所以这里是**实心白**；同时插件会把里面的 `_terminalWrap` / `_browserBar` / `_paneCard` 按侧栏滑块刷成 `--we-sidebar-color`（YG 是 `#67DCE7`）—— 合起来就是「青蓝色的实心底」。

处理方式与第 4 节的右侧栏完全一致（复用插件自己的变量，让里面的表面按输入框那套配方走）：

```css
body[data-we-sidebar-glass] [class*="_bottomPanel"] {
  background-color: var(--kokona-surface-glass) !important;
  --we-sidebar-color: var(--we-glass-color, #ffffff);
  --we-sidebar-blur: var(--we-blur, 16px);
  --we-sidebar-tint: calc(var(--we-glass-alpha, 0.2) * 80%);
  --we-sidebar-saturate: var(--we-saturate, 1.8);
  --we-sidebar-sheen: 1;
}
```

**第一版只改了 `--we-sidebar-tint`（浓度），没改 `--we-sidebar-color`（颜色），所以底栏依然是青的。** 插件那四条 `background-color: color-mix(in srgb, var(--we-sidebar-color, #ffffff) <浓度>, transparent) !important` 里，浓度和颜色是分开的两个变量 —— 只调浓度只是让青色变淡，不会变白。要中性玻璃就必须把颜色也换掉。已确认 `--we-sidebar-color` 在插件里**只**出现在 `background-color`（border / box-shadow 命中数为 0），而 sheen 用的是写死的 `rgba(255,255,255,…)`，所以覆盖这一个变量就够，不用再逐个元素写 `!important`。

日志验证（`diag.log`）：`_paneCard` 从 `color(srgb 0.403922 0.862745 0.905882 / 0.1236)`（= `#67DCE7` 的 12.36%）改成中性之后应变成白色的 12.36%。

### 「轨迹」页的纯白底

`dsh-client-ui-trajectory` 的整页都铺 `--dsw-alias-bg-layer-1`：最外层 `qBU-ya_root`，里面 `Y0dWHa_split`、`Y0dWHa_table`、`Y0dWHa_details`（右侧详情列）也都是。在对话作用域里 `bg-layer-1` 已被我重映射成 `--kokona-surface-glass`，所以整页是一块 0.72 的白 —— YG 要的是「跟一般对话一样，干脆不要底」。

锚点用**轨迹自己的滚动容器** `data-trajectory-scroll`（包内 JSX 里写死的，`TrajectoryTable` 的 `tablePane`）。用 `:has([data-trajectory-scroll])` 把 `_root` / `_split` / `_table` / `_details` 这四个后缀限制成「必须是轨迹滚动容器的祖先」—— 否则这些后缀太泛、会误伤别处。

```css
[class*="_root"]:has([data-trajectory-scroll]),
[class*="_split"]:has([data-trajectory-scroll]),
[class*="_table"]:has([data-trajectory-scroll]),
[class*="_details"]:has([data-trajectory-scroll]),
[data-trajectory-scroll] { background-color: transparent !important; }
```

内部的内容面板（`assistantOutput` / `programPanel` / `schema` / `promptDiff` / `overviewPreview` / 顶部工具栏 `fV0t5q_root`）**没动** —— 它们是内容面不是页面底。要一起透明再说。

### 底栏那条（已用日志验证）

`diag.log` 203461ms：`div.nArs4W_bottomPanel @280,1017 1046x221 bg=rgba(255,255,255,0.72)` —— 打开状态下就是我给的玻璃，不再是 `bg-layer-1` 的实心白。里面的 `_paneCard` 是 `color(srgb 0.403922 0.862745 0.905882 / 0.1236)` = `#67DCE7` 的 12.36%，即插件按重定向后的 `--we-sidebar-tint` 刷的侧栏色 —— 与右侧栏同一套处理，符合预期。

### 「打开方式」菜单抖动（`dsh-client-ui-open-in-app`）

现象：点右上角的打开方式按钮，菜单弹出来后**在几种高度之间反复伸缩**，一直循环。

已查明的静态事实：

- 组件是 `OpenTargetButton`（前缀 `OMoRSG_`），按钮上有 `data-open-target` / `data-open-path-more` / `data-state`，`aria-haspopup="menu"`。
- 菜单是 `dsh-client-ui-primitives` 的 `Menu`，`portal: true`、`align: "end"`、`dense: true`，条目 = `applications` 列表（+ `failed` 时追加一条不可用行，文件型还有 `footer` 的「显示位置」）。
- `Menu.module.css` 里 `.itemLabel` 是 `white-space: nowrap`，所以标签不会换行；菜单变高只可能来自**条目数变化**。
- 菜单是 portal 出去的，不在标题栏留白（`topStripClusters`）会改的节点里。**第一次诊断已证实**：菜单出现的时间窗（190s 之后）里 `shift` / `layout pending` **零条**；仅有的几条在 167–175s，是按钮被 React 重建时重新应用 4px 留白，属预期。
- 第一次诊断的日志**不可信**：`record()` 的 key 用的是**选择器**，一个选择器匹配多个节点时它们互相覆盖，看起来就像「同一个节点在反复变宽」。菜单那三条 `x/w`（187/238/289）其实是**不同元素**，右边缘都落在 1226 是 `align: end` 右对齐的必然结果。已修：按元素分配稳定 id（`WeakMap`）+ 记录 `inline style`、`visibility/display/opacity`、子节点尺寸、每个选择器的匹配数量。

### 诊断机制（临时，1.0.2 发版前删掉）

shell 没有 DOM 检查器，页面也看不见，所以加了 `src/preload/diagnostics.ts`：**只有存在 `%LOCALAPPDATA%\KokonaDSH\diag.on` 时才启用**，每 300ms 采样一批候选表面（底栏、终端、菜单、portal、item 等）的 `getBoundingClientRect` + `background-color` + `backdrop-filter` + 子节点数，有变化就追加到 `%LOCALAPPDATA%\KokonaDSH\diag.log`；另外每秒扫一遍下半屏里类名像 panel/bottom/dock 的元素。标题栏的 `applyShift` 和 `layout` 的 pending 决策也写进同一个日志。

**发 1.0.2 前必须做**：删掉 `src/preload/diagnostics.ts`、`index.ts` 里的 import 和 `installDiagnostics()` 调用、两处 `diagLine(...)`，以及 `%LOCALAPPDATA%\KokonaDSH\diag.on`。

### 新踩的坑

- **CSS 注释里写反引号会把模板字符串提前结束**。注入样式是一整个 `` `...` `` 模板字面量，注释里写 `` `background: var(...)` `` 直接 `TS1005`。这个坑我踩了两次（第 4 节和第 16 节各一次），写注释时不要用反引号。
- **采样日志的 key 必须带元素身份**。用选择器当 key，遇到 `querySelectorAll` 匹配多个节点（`_list`、`_root`）时后一个会覆盖前一个，日志读起来就像「同一个元素在抖」。第一版诊断就是这么把我自己带偏的，改成 `WeakMap` 分配 id 之后才对。
- `pwsh` 里 `Select-String -Path (Join-Path ...)` 遍历 `@deepseek-ai` 下所有包会因为很多包没有 `lib/client.js` 而刷满错误 —— 先 `Test-Path` 或直接列目录。

## 17. workspace-write 的硬伤：工作区缺 WRITE_OWNER（已修）

### 现象

权限只给「仅工作区修改」时，仍然写不了工作区文件。同一台机器上有的工作区正常、有的必挂。

### 根因

Windows 上 workspace-write 走 `dsh-sandbox-windows-acl`（`dsh-sandbox-local` 里 `win32: ["windows-acl"]`）。它要在**同一次 `SetNamedSecurityInfoW`** 里给工作区根写三样东西：能力 SID 的 grant、Everyone 的 `FILE_DELETE_CHILD` deny、Low 完整性标签。

标签在 SACL 里，所以这次调用需要 **WRITE_OWNER**。而 `Modify` 不含 WRITE_OWNER，所有者的隐式权限也只有 `READ_CONTROL` + `WRITE_DAC`（够改 DACL，不够写 SACL）。

`D:\` 的默认 ACL 是 `Authenticated Users:(OI)(CI)(IO)(M)` —— 只有 Modify，于是 D 盘上**所有**工作区都授权失败。这个失败是**故意 fail loud** 的：runner 打印 `windows-acl-run: <detail>` 并 exit 127，seam 判成「沙箱坏了」而不是「被拒绝」，**子进程根本没被拉起**。表现就是「改不了工作区文件」。

包内 README 第 122 行把这条写死了：*A directory whose DACL grants only Modify now fails the grant loudly*。

### 实测（2026-09-26，只读）

```
account: KOKONA\Akizuki
OK  (skip)   C:\Users\Akizuki                  ← 有 (F)
OK  (skip)   C:\Users\Akizuki\HaituAria        ← 继承 (F)
NEEDS GRANT  D:\kokonadsh   D:\KokonaPolaris   D:\Kokona2D
NEEDS GRANT  D:\KokonaPolaris\desktop\html   D:\Downloads   D:\kokonaaira
```

**C 盘的都正常、D 盘的全部中招** —— 「有时行有时不行」的全部来源就是工作区在哪个盘。

旁证：`icacls D:\kokonadsh` 里没有任何能力 SID 的 ACE、没有 Low 标签。按设计这两样是永久 standing、从不撤销的（README 第 90 行：授权**每机器每工作区只落地一次**，之后所有会话、所有重启都走 skip）。所以这个工作区上从来没成功授权过一次。

### 修法：只补 WRITE_OWNER，不补 Full control

`icacls` 支持具体权限位，`WO - write owner`：

```
icacls "<workspace>" /grant "*<SID>:(OI)(CI)(WO)" /Q /C
```

- 只给 `WRITE_OWNER`，可继承；
- **不给账号任何它本来没有的权限**（他本来就拥有这些目录），也不为其他主体放宽；
- 这正是沙箱拿到权限后自己会做的那次编辑；
- DACL 里已经有了就**跳过**，不每次启动重写（重写会触发整棵树继承传播，很慢）。

临时目录实测（已清理）：`before` 无显式 ACE → `after` 多出 `KOKONA\Akizuki:(OI)(CI)(WO)`，exit 0。

### 代码

- 新文件 `src/main/workspace-acl.ts`：读 `<dshHome>/storages/workspace.json` 取工作区真实路径（**别用会话目录名解码** —— `--D-KokonaPolaris-desktop-html--` 里的 `-` 分不清是分隔符还是字面量），逐个 `icacls` 查是否已有 `(F)`/`(WO)`，没有就补 `(WO)`。
- 时机：`Shell.bootOnce()` 里 fire-and-forget 调用，**不 await、不影响启动**；再 `fs.watch` 那个 registry（防抖 1.5s），于是新工作区在被第一次跑命令之前就补上了（registry 在「打开工作区」时就写，早于任何会话执行命令）。
- 开关：`config.json` 的 `fixWorkspaceAcl`（默认 `true`）。`AppConfig` / `DEFAULT_CONFIG` / `mergeConfig` 三处都加了。
- 日志走 `logLine`，core panel 的日志里会出现 `workspace acl: granted WRITE_OWNER on <path>`。

**注意**：默认开启，所以下次启动 KokonaDSH 时它会自动给上表那 6 个 D 盘工作区补 `(WO)`（一次性，之后跳过）。不想让它动就设 `fixWorkspaceAcl: false`。

### 验证到什么程度

- `npm run typecheck` 通过；`npm run build` 产出 `out/main`（77.81 kB）、`out/preload`、`out/renderer`，新逻辑确认在 `out/main/index.js` 里。
- 解析与判定逻辑用**真实 icacls 输出**跑过（上表），授权命令在临时目录上跑过。
- **没做**：没对真实 D 盘工作区执行授权（YG 说他现在用完全权限、懒得改）。所以「启动后自动补」是设计正确 + 逻辑已验证，但没在真实工作区上跑过。

### 同一症状的其他已知边界

1. 受限进程里 Node 的 `child_process.spawn/exec` 用默认 `stdio: 'pipe'` 会 EPERM（连匿名管道都开不了）—— `npm run build` / vite / electron-builder 这类全中招，沙箱层面无解，只能提权。
2. 被 AppContainer 打上包 SID（`S-1-15-2-…`）ACE 的目录对这个后端不可读。
3. 授权会在子目录留下 `FILE_DELETE_CHILD` 的 deny（继承），导致别处用 FullControl/GENERIC_ALL 打开子目录被拒 —— 删除和普通读写不受影响。
4. 工作区包含 TEMP 根会在授权前直接拒绝（YG 不成立：TEMP 在 `C:\Users\Akizuki\AppData\Local\Temp`）。

## 18. 左上角 logo 替换（方法已查明，等图）

网页端左上角的 logo 是 `dsh-client-ui-sidebar` 的 `_logoRow` → `_brandIdentity`，里面 `_brandMark` = `FishLogo`（鲸鱼）、`_brandName` = `BrandWordmark`（字标）。两个都是**内联 SVG、用 currentColor、没有 src**，所以换图不是改属性。

品牌本身是**槽位**注册的，`dsh-client-ui-brand-official` 里就两行：

```js
ctx.slots.register({ name: "sidebar.brand.mark" }, OfficialBrandMark)   // FishLogo
ctx.slots.register({ name: "sidebar.brand.name" }, OfficialBrandName)   // BrandWordmark
```

两条路：

**A. 外壳注入（推荐，KokonaDSH 用这条）**
在 `src/preload/index.ts` 里按类名**后缀**锚定（`_brandIdentity` / `_brandMark` / `_brandName` / `_logoRow` / `_railMark`），把官方 SVG 藏掉、给容器刷 PNG 作 background，并定死盒子尺寸（`_brandIdentity` 是 `height:24px` 的 inline-flex，藏掉子节点后会塌）。

- PNG 用**内联 data URI**（页面是 `http://127.0.0.1:<port>`，`file://` 可能被 CSP 拦）：运行时从 asar 里 `readFileSync` 再 base64。
- 好处：**安全模式下也生效**（安全模式禁用全部插件），不引入插件依赖，和现有整套注入一致。
- 代价：锚在类名后缀上，DSH 改结构会失效（可恢复）。

**B. 客户端插件占槽（设计上的正路）**
写个客户端插件 `ctx.slots.register({ name: "sidebar.brand.mark" }, () => <img src={...} />)`，用 `dsh plugin --profile kokona add <pkg>` 装 —— 外壳的 `ensureProfile()` 就是这么装 `dsh-better-sidebar` 的（`src/main/core/profile.ts:88`）。

- 好处：锚在**槽位 API** 上，比类名稳。
- 代价：安全模式下不加载；要多一个包。
- 待查：官方包已经占了同一个槽，多个 occupant 是替换还是叠加 —— 需要先确认 `dsh-client-ui-slots` 的 register 语义。

**需要 YG 提供**：透明底 PNG + 期望显示高度（现在 `_brandIdentity` 高 24px）。图到手后 A 方案就是「一条 CSS + 一张图」。

**结果（见 §19）**：图到了，是 SVG 不是 PNG；A 方案做了，但**不是** data URI / background —— 用内联 SVG 元素，原因在 §19。

## 19. 1.0.2：更名 KokonaHarness + 品牌 logo + 首屏文案

### 更名

- 改成 `KokonaHarness`（无空格）：`APP_NAME` / `DISPLAY_NAME`、`package.json` 的 `name` + `description`、
  `electron-builder.yml` 的 `productName` 与两个 `artifactName`、`renderer/index.html` 的 title、
  终端窗口标题、两处 HTTP user-agent、`core/recovery.ts` 的补丁层头注释、`repack.cmd` 里 5 处 exe 名、
  README / README.en / AGENTS。
- **数据目录刻意不动。** `app.setName(APP_NAME)` 决定 `app.getPath('userData')`，改名会把
  `%APPDATA%\KokonaDSH` 搬走 —— 配置、日志、已下载的内核全丢。`src/main/index.ts` 里加了
  `app.setPath('userData', join(app.getPath('appData'), 'KokonaDSH'))` 钉死。**这一行不能删。**
- `appId` 保持 `com.kokona.dsh`：AUMID 和任务栏固定项、通知身份绑在一起，改了只有坏处。
- 自动更新：`src/main/shell-update.ts` 的 `REPO` 改成 `AkizukiKokona/KokonaHarness`，GitHub 与
  Codeberg 两个 API 都从它派生。旧仓库和旧发行版不管，也不做迁移。
- 还没做：提交、打 tag、发版。新仓库现在是空的，所以发版前点「检查更新」会报「没有已发布的发行版」——
  预期行为。

### 品牌 logo（替掉官方鲸鱼 + 字标）

- 官方纵向尺寸：`FISH_LOGO_VIEWBOX = {width:23.16, height:17.04}`，`size:24` 时鲸鱼本体 **17.66px**；
  `BrandWordmark`（`includeMark:false`）是 156×24，**24px**；`_brandIdentity` 也是 `height:24px`。
  → **官方品牌块纵向 24px，YG 允许的 3 倍上限 = 72px。**
- 素材 `resources/brand.svg`（仓库根的 `KokonaHARNESS.svg`，viewBox 72.867×24 ≈ 3.036:1），72px 高时
  约 **219px 宽**。`electron-builder.yml` 的 `extraResources` 把它放到 `process.resourcesPath/brand.svg`。
- 实现（`src/preload/index.ts` 的 `installBrand()`）：读进 SVG 后**作为内联 SVG 元素**插进
  `_logoRow _brandIdentity`，`preserveAspectRatio="xMinYMid meet"` + `height:72px` + `max-width:100%`
  → **居左**，侧栏窄了自动缩。CSS 同时把 `_logoRow` 从 40px 放开到 `min-height:76px`，
  并把 `_brand`、`_brandIdentity` 强制 `justify-content:flex-start`。
  **注意：这里当时把 `overflow` 从 `hidden` 改成了 `visible`，是错的 —— 直接导致 §20 的横向震荡，
  已在 1.0.3 收回 `hidden` 并补 `min-width:0`。**
- **不是 data URI，也不是 background-image**（§18 那条推测作废）：`img-src` 可能回落到
  `default-src 'none'`，更要紧的是 `#000` 得跟着主题走，而外部图片继承不到 `currentColor`。
  所以 `installBrand()` 把 `fill="#000"` 全改写成 `currentColor`（深色主题下自动变浅），
  金色 `#D2AB57` 和金色徽章底下的白底不动。
- 兜底：资源读不到就什么都不做，`body[data-kokona-brand]` 不设，官方品牌原样留着 —— 不会出现空行。
- React 重渲染会冲掉插进去的节点，所以统一进 `tick()`（600ms + MutationObserver）；两个守卫都是
  「已经做过就直接返回」，不会自激。

### 首屏文案 + 预览版角标

- 文案是 i18n 串，不是槽位：`dsh-client-ui-conversation` 的 `"hero.headline": "探索未至之境"`
  （英文 `Into the Unknown`）。JSX 是 `titleGroup > [<span>{headline}</span>, <span class=previewBadge>]`，
  标题那个 span **没有 class**，所以按结构锚 `[class*="_titleGroup"] > :first-child`，
  `installHeroCopy()` 换成 **沐浴晨光，方得救赎！**。换完就不再匹配源串，不会反复写。
- 角标 `_previewBadge` 原本是 `background: var(--dsw-alias-state-business-tertiary)` 的实心胶囊，
  完全没有毛玻璃。CSS 只改表面：`color-mix(… --dsw-alias-state-business-primary 14% …)` 淡蓝底 +
  34% 淡蓝描边 + `backdrop-filter: blur(10px) saturate(1.6)`。**位置、圆角、padding、`align-self`
  一律不动**，所以它还贴在文案右上角原地。

### 验证

`npm run typecheck` 通过（exit 0）；`npm run build` 通过，产物 `out/main/index.js` 77.96 kB、
`out/preload/index.js` 55.62 kB（加入品牌注入后从 51.45 kB 长上来）、`out/renderer/*` 齐全。
**未做**：没有真正启动应用看效果（会杀掉正在跑的内核），所以 72px 的实际观感、深色主题下的
`currentColor` 效果、以及首屏文案替换的时序都还是纸面结论。

### 发布记录（2026-09-26）

| 项 | 值 |
|---|---|
| commit | `7a5821d` feat(1.0.2): rename to KokonaHarness, own brand mark, hero copy and preview pill（前面还有 `2b957c4` 忽略 `brand-work/`） |
| tag | `v1.0.2` → `7a5821d`，已推 github + codeberg |
| remotes | 两个远端 URL 从 `Kokona-DSH` 改成 `KokonaHarness`。仓库是**改名不是新建**：远端 `main` 历史连续，v1.0.0 / v1.0.1 都还在 |
| Actions run | `36188450878`，三平台全绿 |
| GitHub release | 4 个资产：exe `95306884`、mac-arm64 `112149090`、mac-x64 `117199035`、linux AppImage `117506785` 字节 |
| Codeberg release | id `12459312`，4 个资产字节数与 GitHub **逐个相等** |
| 资产名 | `KokonaHarness-Setup-1.0.2.exe` / `KokonaHarness-1.0.2-mac-arm64.dmg` / `-mac-x64.dmg` / `-linux-x86_64.AppImage` |
| 更新检查 | 两个端点实测都返回 `v1.0.2`：`api.github.com/repos/AkizukiKokona/KokonaHarness/releases/latest` 与 `codeberg.org/api/v1/repos/AkizukiKokona/KokonaHarness/releases?limit=1`（应用读 `[0]`）→ 1.0.1 装机会看到 hasUpdate，1.0.2 自己不会 |

**新版 PowerShell 7.6 怎么调用（重要）**：YG 用 winget 装的是 **MSIX 包**，
`C:\Program Files\PowerShell\7\pwsh.exe` **不存在**；`WindowsApps\pwsh.exe` 只是个 0 字节别名，
而且 **harness 的 `pwsh` 工具仍然落到 Windows PowerShell 5.1**（实测 `$PSVersionTable` = 5.1.26100）。
真正的 7.6 在：

```
$env:LOCALAPPDATA\Microsoft\WindowsApps\Microsoft.PowerShell_8wekyb3d8bbwe\pwsh.exe
```

调用方式（外层是 5.1，所以**只用单引号，别嵌套引号**）：

```powershell
$p7 = "$env:LOCALAPPDATA\Microsoft\WindowsApps\Microsoft.PowerShell_8wekyb3d8bbwe\pwsh.exe"
& $p7 -NoProfile -Command '$PSVersionTable.PSVersion.ToString()'   # -> 7.6.6
& $p7 -NoProfile -File 'D:\path\to\script.ps1'                      # 复杂脚本走这条
```

**别**在 `-Command` 里嵌套双引号或单引号：外层 5.1 先解析，`"` 会被拆成多个参数、
`'` 会提前结束字符串（本轮各踩一次）。要 7.6 的语法就把脚本写成 `.ps1` 再 `-File`。

**Codeberg 上传（这次的办法，比 §6 的 curl 省事）**：7.6 的
`Invoke-RestMethod -Form @{attachment = Get-Item $path}` 直接就是 gitea 要的 multipart 字段名，
不用写 header 文件；`Authorization: token <token>` 走 `-Headers`。四个资产 422 MB 一次跑完，
服务端回读的 `size` 与 GitHub 逐个相等。

## 20. 1.0.3：横向震荡 + 「文件资源管理器」点了没反应

YG 报的两个 bug，根因都不在表面。

### bug 1：打开方式菜单左右反复伸缩（1.0.2 的 logo 改动引入的回归）

现象：点开菜单后左右距离「变长一下、又变长一下、再弹回原位」，一直循环。

**根因是 §18 那次改 logo 时把 `overflow` 从 `hidden` 改成了 `visible`。** 官方
`_logoRow` 是 `height:40px; overflow:hidden`；为了放 72px 的 lockup，行高必须放开，但
`overflow:visible` 一并放开了**宽度**约束。那个 lockup 宽约 219px（3.036:1 × 72px），
于是它成了这一行 flex 的 **min-content 宽度**；侧栏是可拖拽调宽的，两者开始抢「这一列多宽」，
整个横向布局来回震荡 —— 菜单是 `align:end` 定位的，所以看起来就是菜单在伸缩。

修法：把约束装回去，**没有动任何 JS**。

```css
[class*="_logoRow"] { height:auto; min-height:76px; min-width:0; max-width:100%; overflow:hidden; align-items:center }
[class*="_logoRow"] [class*="_brand"]         { justify-content:flex-start; min-width:0; max-width:100%; overflow:hidden }
[class*="_logoRow"] [class*="_brandIdentity"] { height:auto; justify-content:flex-start; min-width:0; max-width:100%; overflow:hidden }
svg[data-kokona-brand-mark] { display:block; height:72px; width:auto; min-width:0; max-width:100%; flex:0 1 auto }
```

`min-width:0` 是关键（flex 子项默认 `min-width:auto`，会把 219px 顶到父级），
`overflow:hidden` 让侧栏窄的时候 lockup 在自己盒子里按比例缩下去而不是把侧栏顶宽 ——
`preserveAspectRatio="xMinYMid"` 保证缩下去仍然居左、垂直居中。72px 和居左都没丢。

**教训**：放大一个 flex 子项时，改高度可以，别顺手放开 `overflow`。宽高是一起被
`overflow:visible` 放开的。

### bug 2：打开方式菜单里「文件资源管理器」点了没反应

现象：点它不开任何东西；同一个文件用 VS Code 打开正常。

菜单组件是 `dsh-client-ui-open-in-app`（前缀 `OMoRSG_`），「文件资源管理器」这一条来自
`dsh-host-open-in-app/catalog.js` 的目录项：

```js
{ id: 'explorer', platforms: { win32: spec({ kind: 'fixed', launch: { kind: 'shell-open' }, iconPath: '${SystemRoot}/explorer.exe' }) } }
```

`shell-open` → `openNativePath(path)` → `runExplorer([explorerTarget(path)])` →
`execFile('explorer.exe', ['file:///D:/…'])`。**Explorer 是「打开一个目标」，不是「用某程序打开一个文件」**，
对文件它什么都不做。实测（`Shell.Application.Windows()` 回读窗口 URL，这是唯一可靠的观察手段）：

| 命令 | 结果 |
|---|---|
| `explorer.exe file:///D:/kh-open-test`（目录） | ✅ 开出该目录 |
| `explorer.exe D:\kh-open-test`（目录，已有窗口） | 0 新窗口 —— 复用已存在的窗口，所以「点了没反应」 |
| `explorer.exe file:///D:/kh-open-test/sample.txt`（**文件**） | **0 新窗口，什么也没发生** |
| `explorer.exe D:\kh-open-test\sample.txt`（文件） | 0 新窗口 |

顺带查到核心的 reveal 手势也是坏的：`revealNativePath` 写的是
`runExplorer(['/select,', explorerTarget(path)])` —— 把 `/select,` 和路径当成**两个 argv**。
Explorer 自己解析命令行，于是它收到一个空的选择项，开出一个空白窗口。必须拼成一个字符串
`/select,<path>`（源码注释里其实写了「Explorer parses its own command line and splits fields at
commas and equals signs」，但实现没照做）。

**核心不能打补丁，所以截在客户端真正用的那条传输上。** 客户端的 `launch()` 发的是
`POST open-in-app/open`，body 是 `{app, path}`（路由常量 `OPEN_IN_APP_OPEN_ROUTE = "open-in-app/open"`，
`OPEN_IN_APP_APPS_ROUTE` / `OPEN_IN_APP_ICON_PREFIX_ROUTE` 是另两条）。做法：

1. preload 用 **`webFrame.executeJavaScript`** 往页面**主世界**装一个 `window.fetch` 钩子。
   必须在主世界 —— 客户端的 `fetch` 在那；隔离世界 patch 不到。`executeJavaScript` 是隔离 preload
   唯一能到主世界的入口（CSP 挡不住它，它不是 script 标签）。
2. 命中 `POST …/open-in-app/open` 且 `body.app === 'explorer'` 时，吞掉请求、回一个合成的
   `new Response('{"ok":true}', {status:200})`，避免核心再去跑那条坏路径。
3. 两个世界之间**只能用 DOM 事件通信**（唯一共享的通道）：主世界
   `document.dispatchEvent(new CustomEvent('kokona:reveal', {detail: path}))`，preload 在隔离世界监听。
4. preload → `api.revealPath(path)` → IPC `kokona:reveal-path` → 主进程：

```ts
async function revealPath(target: string): Promise<void> {
  if (statSync(target).isDirectory()) { await electronShell.openPath(target); return }
  electronShell.showItemInFolder(target)   // Electron 自己的 reveal，/select, 和路径是拼对的
}
```

目录仍然「打开目录」，文件变成「在文件夹里选中它」—— 这才是叫「文件资源管理器」的条目该干的事。
只在 `app === 'explorer'` 时接管：macOS 的 `finder`（`open -R`）和 linux 的 `filemanager`
（`xdg-open <dirname>`）本来就是对的，不动。

新增：`IPC.revealPath`（`shared/constants.ts`）、`KokonaApi.revealPath`（`shared/api.ts`）、
主进程 `revealPath()` + handler（`main/ipc.ts`）、`installOpenInAppFix()`（`preload/index.ts`，
挂进 `tick()`，用 `documentElement` 上的 `data-kokona-open-in-app` 做一次性守卫）。

**注意**：reveal 那条（菜单底部的「显示文件位置」）走的是 session controller 的 RPC，**不是**这条
HTTP 路由，所以本次没有覆盖它。核心那个 `/select,` 两参数的 bug 仍在，要修得再找那条 RPC 的传输。

### 验证

`npm run typecheck` exit 0；`npm run build` exit 0，产物 `out/main/index.js` 76.5 kB、
`out/preload/index.js` 52.5 kB、`out/renderer/*` 齐全。逐字核对了打进包里的代码：六条 logo CSS
规则（含 `min-width:0` / `overflow:hidden`）、主世界钩子（`__kokonaOpenInAppFix`、正则
`/(^|\/)open-in-app\/open$/`、合成 `Response`）、`kokona:reveal-path`、`revealPath()` 辅助函数全部在位。
**未做**：没有启动应用看实际观感（会杀掉正在跑的内核）。

### 发布记录（2026-09-26）

| 项 | 值 |
|---|---|
| commit | `c94b06c` fix(1.0.3): stop the sidebar width oscillation, reveal files from File Explorer |
| tag | `v1.0.3` → `c94b06c`，已推 github + codeberg |
| Actions run | `36211633357`，三平台全绿 |
| GitHub release | 4 个资产：exe `95307592`、mac-arm64 `112155431`、mac-x64 `117191819`、linux AppImage `117506976` 字节 |
| Codeberg release | id `12462360`，4 个资产与 GitHub **逐个字节相等** |
| 资产名 | `KokonaHarness-Setup-1.0.3.exe` / `KokonaHarness-1.0.3-mac-arm64.dmg` / `-mac-x64.dmg` / `-linux-x86_64.AppImage` |
| 更新检查 | 两个端点实测都返回 `v1.0.3`：`api.github.com/…/releases/latest` 与 `codeberg.org/api/v1/repos/…/releases?limit=1`（应用读 `[0]`） |

**Codeberg 配额（新踩的坑，重要）**：Codeberg 的发行附件是**用户级硬配额**，不是限速。
v1.0.0/1.0.1/1.0.2 各约 421 MB，加上 v1.0.3 的前三个资产累计 1.56 GB 之后，第 4 个（95 MB 的 exe）
被直接拒掉：

```
{"message":"quota exceeded","user_id":1307129,"username":"AkizukiKokona"}
```

**重试立刻再拒**（等了一会儿也一样），所以是配额不是限速。按 YG 的决定，删掉 **v1.0.0 和 v1.0.1 的附件**
（`DELETE /releases/{id}/assets/{asset_id}` —— 只删附件，**发行说明和 tag 都保留**，GitHub 上原件也都在），
释放 843 MB → 剩 752 MB，1.0.3 的 exe 随即传完。

**下次发版前先算空间**：一版约 442 MB，配额上限落在 1.5–1.6 GB 之间，所以 Codeberg 上大约只能同时放
**三版**的附件。再发之前要先删最旧那版的附件，否则会卡在最后一个资产上（而且前三个已经传上去了，
留下一个残缺的发行版）。注意更新检查器只读 `tag_name` 然后链到发行页，**不挑资产** ——
所以缺 exe 的发行版对 Windows 用户就是「点进去下不到东西」。

**上传配方（已验证，沿用 §18）**：PS 7.6 的
`Invoke-RestMethod -Method Post -Form @{attachment = Get-Item $path}`，
打到 `$base/releases/{id}/assets`，`Authorization: token <40 位>` 走 `-Headers`。
exe 95 MB 约 31s，其余每个 19–20s。脚本按名字跳过已存在的资产，所以中断后重跑是安全的。

## 21. 本地版本号和云端不一致时的最小修法（`setver.cmd`）

**现象**：代码已经是 1.0.3 的代码，但打包那一刻 `package.json` 还是 1.0.2，于是本地这份应用自称
1.0.2，而 1.0.3 已经发布 → 更新检查一直说有更新，提示的其实是它自己。

判断逻辑在 `checkShellUpdate()`：

```ts
const current = app.getVersion()
const hasUpdate = compare(release.version, current) > 0
```

打包之后 `app.getVersion()` 读的是 **`resources/app.asar` 里的 `package.json`**
（electron-builder 把源 `package.json` 拷进去了），**不是** exe 的版本元数据 ——
所以只改 asar 里那一个字段就够，不用重新打包，更不用碰云端。

**做法**：`scripts/set-packed-version.mjs` 做**原地字节替换**。`1.0.2` 与 `1.0.3` 等长，
所以 asar 头里的 size / offset **全部保持有效**，620 kB 的归档一个字节都不用重排。

- 锚点取 `"name": "kokonaharness"` 之后的第一个 `"version": "…"`。**不能直接搜版本串**：
  包里别处也有裸的 `"version"`（渲染进程 `index.js` 里有 `el("div", "version")`）。
- 两个版本长度不一致就**拒绝**，让他走 `npm run pack`（原地替换会错位）。
- 动真文件之前先在**副本**上试：写出 `.probe`，用 `@electron/asar` 重新解析并回读
  `package.json`，确认头和版本都对，才写回去。

**验证记录**：在副本上跑 → `12 entries, packed version 1.0.3`；与原文件逐字节比对
**只有 1 个字节不同**（offset 619269，`2`→`3`），文件长度 619497 不变；真文件始终是 1.0.2。

`setver.cmd` 是外壳：等 `KokonaHarness.exe` 退出（asar 被内存映射，跑着的时候写不了）→
跑上面的脚本 → 用 `explorer.exe` 重新拉起。**纯本地，不下载、不重建、不发布。**

`repack.cmd` 留给「代码真的变了」的情况：`npm run build && electron-builder --dir` 完整重打。
这轮顺手给它加了两件事 —— 开头打印 `package.json` 的版本；打完回读 exe 的 `ProductVersion`
并与源版本比对（不一致就警告）；等待循环同时认 `KokonaHarness.exe` 和改名前的 `Kokona DSH.exe`。

**踩的坑**：`for /f "usebackq"` 的反引号里写管道要转义成 `^|`，但那个 `^` 会**原样传给**
PowerShell（`A positional parameter cannot be found that accepts argument '^'`）。
改成不用管道的写法：`(ConvertFrom-Json (Get-Content 'package.json' -Raw)).version`。

## 22. 安全模式被误触发导致「插件全丢」（2026-09-26 修的 bug）

**现象**：启动后插件全没了、设置像被重置、像「另一个 DSH」，`repack.cmd` / `setver.cmd` 都救不回来。

**真相**：什么都没丢。`%APPDATA%\KokonaDSH\config.json` 的 `safeMode` 被写成了 `true`，
于是启动的是 `<profile>-safe`（从 `web` 模板生成、**不加载任何插件**）。插件、模型配置、设置
全在 `kokona` profile 里，好好的。

**根因**：`bootOnce()` 里 `await window.loadURL(url)` 被包在 boot 的 try 里。Electron 的
`loadURL()` promise 会在 **webContents 的第一次 `did-fail-load`** 时 reject —— 启动时我们先用
`loadRenderer(window, '#boot')` 加载启动屏，核心就绪后再 `loadURL(核心URL)` 会**取代**那次导航，
触发 `ERR_ABORTED (-3) loading '.../index.html#boot'`，`loadURL` 的 promise 就以这个错误 reject
→ `bootOnce` 返回 false → 日志里没有插件线索 → 进安全模式并 `patchConfig({safeMode:true})` 持久化。
**核心其实是好的**（日志里 `core ready` 就在报错前一行）。

**修法**：核心就绪后，渲染层加载失败绝不算启动失败。

```ts
this.serverUrl = url
this.setPhase('ready')
const window = getMainWindow()
if (window) {
  try {
    await window.loadURL(url)
  } catch (error) {
    log.warn(`renderer load failed after core ready: ${(error as Error).message}`)
  }
}
return true
```

**被卡住时怎么救**（不用重装、不用重建）：
1. 把 `%APPDATA%\KokonaDSH\config.json` 的 `"safeMode"` 改成 `false`；或
2. 设置里「重启菜单 → 退出安全模式并重启」（`relaunchApp(false)`）。

重启即可，插件/设置/模型配置原样回来。

**排查要点**：
- 先看 `config.json` 的 `safeMode`，以及日志里 `spawning core ... --profile` 是 `kokona` 还是 `kokona-safe`。
- 日志里 `core ready` 出现在「进安全模式」之前 → 核心没坏，是渲染层/其它误判。
- **别急着重建/重装**：数据都在 profile 里，重建只会白等。

**设计红线**：`boot()` 只在**核心/运行时/profile 真的起不来**时才允许进安全模式。任何
「核心已 ready」之后的失败都不许触发安全模式，更不许把 `safeMode` 持久化。

## 23. 「dsh 被占用」——残留的孤儿核心（2026-09-26）

**现象**：应用里新建会话 / 发消息时，DSH 提示工作区或实例「被占用」。

**原因**：还有一个 **孤儿 `node` 核心**在跑同一个 `--profile kokona`。外壳被强杀
（`taskkill`、崩溃，或调试时直接结束进程）时 `before-quit` 没机会执行，核心就留了下来，
一直占着 profile / 工作区锁。实测遇到过：一个 10:03 启动的核心，父进程早已消失，仍在跑。

**排查**：

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'dsh' } |
  Select-Object ProcessId, ParentProcessId, CreationDate, CommandLine
```

正常应当只有 **一个** `--profile kokona` 的核心，且其父进程就是当前 `KokonaHarness.exe`。
`PPID` 指向一个已不存在的进程的那个，就是孤儿。

**处理**：`taskkill /PID <孤儿PID> /T /F`。

**避免**：退出应用走托盘 / `before-quit`（会先停核心）；调试时不要直接 `taskkill` 外壳；
要强杀就带 `/T` 杀整棵进程树。

**可做但未做**：启动时主动清理同 profile 的孤儿核心（枚举进程 → 父进程不存在且命令行匹配
本 runtime + profile → 杀掉）。若要做，务必先确认它不是另一个正在运行的合法实例，别误杀。

### 22.1 触发条件（事后从日志复盘）

那行 `await window.loadURL(url)` 来自 `d2a8358`（第一个提交），所以它**不是新 bug**，
是一直潜伏的竞态：`loadURL(核心URL)` 会取代启动屏那次导航，只要取代发生时启动屏**还在加载**，
就会 `did-fail-load` + `ERR_ABORTED`。日志把「第一次」和「之后每一次」分得很清楚：

- `01:49:25Z` 启动屏加载完 → `01:49:27Z` 核心 ready → `01:49:28Z` DSH 页面加载完 → **成功**。
  同一个二进制（09:49 那次打包）跑起来是好的。
- `03:34:49.363Z` 核心 ready → `03:34:51.320Z` `boot failed ... entering safe mode` → **失败**。
- 之后 03:35 / 03:37 / 03:38 每次都直接 `--profile kokona-safe` —— **那不是竞态，是必然**：
  第一次失败已经把 `safeMode: true` **写进 `config.json`**，后面每次启动都直接进安全模式。

所以只有**第一次**是竞态，其余全是持久化的后果。这也解释了为什么它看起来像「插件全丢了」、
怎么重启都没用，而且 `repack.cmd` / `setver.cmd` 都救不回来 —— 那两个脚本都不碰 `config.json`。

**第一次为什么会发生**：启动屏那次导航必须还在飞。最可能是**打包 / 改完 asar 之后立刻拉起应用**：
`repack.cmd` 打完 600 MB 立刻 `explorer.exe` 启动，`setver.cmd` 改完 asar 立刻启动，
首屏读的是冷文件缓存，启动屏的加载被拖长，正好让核心在它加载完之前就 ready。

**已经补的两件事**：核心 ready 之后的渲染层加载失败不再算启动失败（§22 的修法）；
两个脚本在拉起应用前先 `ping` 等约 3 秒，让文件系统落地。

**排除项**：预加载脚本**不是**原因 —— 启动屏是 `file://`，`isDshPage()` 返回 false，
`bootstrap()` 早退，注入逻辑在启动屏上根本不跑。

## 24. 本地版本号规则（`scripts/local-version.mjs`）

**目的**：代码往前走了、版本号还停在上一个已发布的号上 —— §21 那个「应用提示更新、提示的其实
是它自己」就是这么来的。这个脚本让**本地**副本永远比最后一个 release 高一个 patch。

**规则**（挂在 npm 的 `prebuild` / `predev` 上，所以 `npm run build` / `npm run pack` / `npm run dev`
都会先过一遍）：

1. 取最新的 `v*` tag 当作「已发布版本」；
2. 本地版本**等于**它，**并且**树确实动过（tag 之后有提交，或有已跟踪文件被改）→ **patch +1**；
3. 本地版本已经**高于**它 → 什么都不做。这就是「一次上云后只加一次」：加完就永远大于它，
   直到下一个 tag 出现；
4. 本地版本**低于**它 → 不动，留给人处理；
5. 树没动过（刚 clone，或正好停在 tag 上）→ 不动。

**必须是本地功能 —— CI 里绝不能跑。** 发布产物报的版本必须和它的 tag 一致，否则发布自相矛盾。
GitHub Actions 会设 `CI=true`，脚本第一步就退出。

**写法上的两个刻意选择**：
- 改版本号用**定点字符串替换**，不重新 `JSON.stringify` —— 否则整个 `package.json` 被重排，
  一行的改动淹没在噪音里。
- 「树动过没有」只看**已跟踪文件**（`git status --porcelain --untracked-files=no`）——
  仓库里本来就有故意不跟踪的草稿文件（`KokonaHARNESS.svg`、`name.png`、`tools/`），
  它们不能被当成「有改动」。

**验证记录**（v1.0.3 已发布、tag 之后有 2 个提交时）：第一次跑 `1.0.3 -> 1.0.4`；
第二次跑 `1.0.4 is already ahead` 不动；`CI=true` 直接跳过；`npm run build` 走 `prebuild`
且不重复加。

**和 `repack.cmd` 的配合**：`prebuild` 可能加号，所以 `repack.cmd` 在 `npm run pack` **之后**
重新读一次 `package.json` 再和打出来的 `ProductVersion` 比对，否则会误报「版本不一致」。

## 25. 输入框右键菜单（剪切 / 复制 / 粘贴 / 全选）

**现象**：对着输入框右键**毫无反应**。原因不在 DSH —— **Electron 默认不提供任何右键菜单**，
`contextmenu` 没人处理，所以点上去就是没有。社区封装大多也没补，所以到哪都这样。

**做法**：菜单**画在页面里**，动作仍然是 Electron 自己的。

**为什么不是原生菜单**：第一版用的是 `Menu.buildFromTemplate(...).popup()` + `role`，功能完全正常 ——
但**原生菜单由操作系统绘制，Electron 完全控制不了外观**：没有透明度、没有圆角、没有
backdrop-filter 接口。要跟底栏/右栏一样是毛玻璃就只能自绘，于是换成了 DOM 菜单，
并复用**同一套**参数：

```css
background-color: color-mix(in srgb, var(--we-sidebar-color, #ffffff) var(--we-sidebar-tint, 20%), transparent);
backdrop-filter: blur(var(--we-sidebar-blur, 16px)) saturate(var(--we-sidebar-saturate, 1.3))
                  brightness(var(--we-glass-brightness, 1.04)) contrast(1.01);
```

**分工**：
- `src/preload/index.ts` —— 文档级 `contextmenu` 监听（**捕获阶段**，趁页面还没动选区），判断这次
  点到了什么，把 `{ editable, hasSelection, hasContent }` 发给主进程；主进程回一组菜单条目，
  渲染层只负责**画**。
- `src/main/ipc.ts` —— `editMenuEntries(state, hasClipboardText, locale, platform)` 是**纯函数**：
  有哪些条目、哪些可用、标签和加速键写什么，全在这里决定。剪贴板只有主进程能读，所以判断都在这一侧。
- 点击后走 `IPC.editAction` → `webContents.cut()/copy()/paste()/selectAll()` —— **不是自己实现**，
  所以行为、撤销栈、平台习惯和原生一致。

**焦点是这个方案的命门**：那些动作作用在**当前获得焦点的元素**上。菜单项是 `<button>`，
点它会把焦点从输入框抢走 —— 所以 `mousedown` 上 `preventDefault()`，让焦点始终留在输入框里。

**状态逻辑**：

| 情况 | 剪切 | 复制 | 粘贴 | 全选 |
|---|---|---|---|---|
| 可写 · 有选区 · 剪贴板有内容 · 有内容 | ✓ | ✓ | ✓ | ✓ |
| 可写 · 有选区 · 剪贴板为空 | ✓ | ✓ | ✗ | ✓ |
| 可写 · 无选区 · 剪贴板有内容 | ✗ | ✗ | ✓ | ✓ |
| 可写 · 空字段 · 剪贴板为空 | ✗ | ✗ | ✗ | ✗ |
| 只读（`readOnly`） | 不显示 | ✓ | 不显示 | ✓ |
| **普通文本**（消息、代码块、表格） | 不显示 | 有选区才亮 | 不显示 | ✓ |
| `disabled` / 空白处 / 控件 | 不弹菜单，手势还给页面 | | | |

- 剪切/复制要**有选区**；粘贴要**可写 + 剪贴板非空**；全选要**有内容**。
- 全空时菜单照弹、但全是灰的 —— 比「什么都不弹」清楚，用户知道这个功能存在。
- 只读字段和普通文本都只给 复制 / 全选。

**接管范围**：输入框、`contenteditable`，以及**普通文本**（选中一段文字后右键，或指针正好落在文字上）。
判断顺序是「**有选区就赢**」→ 否则要求「指针在文字节点上」且「不在控件里」：

- 用 `caretRangeFromPoint` / `caretPositionFromPoint` 判断指针**是否真的压在文字节点上** ——
  只看「这个元素里有文字」是不够的，那样整个带内边距的面板都会被接管。
- `button` / `a` / `[role="button"]` 这类控件跳过，插件给自己控件加的右键菜单不会被抢。
- **空白处、图标、控件上**一律不接管，手势原样还给页面。

**焦点**：那些动作作用在**当前获得焦点的元素**上，所以两种情况分开处理：

- 点输入框 → 先 `focus()` 它；
- 点普通文本 → 把当前焦点 `blur()` 掉。否则输入框还握着焦点，复制/全选会作用在输入框上，
  而不是你刚选中的那段正文。

**标签和加速键**：加速键是显式给的（win32 上 `Ctrl+X/C/V/A`，macOS 上 `⌘X/C/V/A`，按
`process.platform` 选），它们只是**显示**用，不注册任何快捷键。标签按 `app.getLocale()` 走
zh/en 小表（实测 zh-CN 出 剪切/复制/粘贴/全选，en-US 出 Cut/Copy/Paste/Select All）。

**其它细节**：`NON_TEXT_INPUTS` 排除掉 `number`/`date`/`file` 这些选区 API 会抛错的类型；
`isContentEditable` 而不是裸的 `[contenteditable]`，否则 `contenteditable="false"` 会被误判。
菜单挂在 `document.body` 上、`position: fixed`、`z-index: 2147483000`，样式是**独立注入**的
`<style>`（不动那一大坨外壳 CSS）；收起靠 `pointerdown`（点外面）/ `Escape` / `scroll` / `blur` /
`resize`，定位会**翻转**以免出屏。菜单是 `contextmenu` 里 `await` 到条目才画的 —— 剪贴板状态得问
主进程，所以 `preventDefault()` 必须在 `await` **之前**同步调用。

**验证**：`npm run typecheck` / `npm run build` 通过。`editMenuEntries` 是**纯函数**，所以另外用
esbuild 单独打包它、在真实 Electron 进程里跑了 7 组状态 × locale/platform，逐项核对：

```
zh-CN / win32
  writable / selection / clipboard / content 剪切:on   复制:on   粘贴:on   | 全选:on
  writable / selection / EMPTY clipboard     剪切:on   复制:on   粘贴:OFF  | 全选:on
  writable / no selection / clipboard        剪切:OFF  复制:OFF  粘贴:on   | 全选:on
  writable / no selection / empty clip       剪切:OFF  复制:OFF  粘贴:OFF  | 全选:on
  writable / EMPTY field / EMPTY clipboard   剪切:OFF  复制:OFF  粘贴:OFF  | 全选:OFF
  read-only / no selection / content         复制:OFF  | 全选:on
  read-only / selection                      复制:on   | 全选:on

accelerators by locale / platform
  zh-CN / win32         剪切[Ctrl+X] 复制[Ctrl+C] 粘贴[Ctrl+V] 全选[Ctrl+A]
  en-US / win32         Cut[Ctrl+X] Copy[Ctrl+C] Paste[Ctrl+V] Select All[Ctrl+A]
  en-US / darwin        Cut[⌘X] Copy[⌘C] Paste[⌘V] Select All[⌘A]
```

（`|` 标的是分隔线位置。）第一版原生菜单的加速键缺失也是这么测出来的，不是读代码读出来的。

**坑**：electron-vite 把主进程打成**单个** `out/main/index.js`，**没有** `out/main/ipc.js` ——
想单独 `require` 一个主进程模块做不到（第一次探针就卡死在这：require 抛异常 → `whenReady`
回调 reject → 既不写结果也不退出）。要单测主进程模块，得用 esbuild 单独打包一个入口，
并且给探针加超时兜底。

## 26. 给「文件没观测」的报错补一条说明

**背景**：核心有个防盲改策略 —— 编辑一个它没「观测」过的文件会被拒绝，报
`cannot modify "<path>": file has not been read — read the file, then retry`（错误码 `FS_NOT_OBSERVED`）。

**但这句话经常是假话。** 观测表在**核心进程的内存里**：

- `dsh-fs-observation-policy/lib/index.js` —— `owner(actor) { return actor?.agent?.session }`，
  状态存在 `WeakMap` 里；`editIntent()` 查不到记录就抛 `FS_NOT_OBSERVED`。
- `apply(ctx)` 每次加载都 **new** 一个 `ObservedStateGate`，`ctx.effect` 的 teardown 里 `clear()`。
  源码注释原话：*"One instance is created per `apply()` so disposal can drop all state for HMR."*

所以记录的寿命 = **一次插件加载**。核心进程一重启（或插件热重载），全部观测归零 ——
**重启前刚读过的文件也会报「没读过」**。同一机制还有个连带效果：`writeIntent` 对未观测目标是
`createIfAbsent` 而不是覆盖，所以重启后 `write` 一个已存在的文件同样会被挡到重读为止（有意的防覆盖）。

**核心不能改**（AGENTS.md 第一条），所以壳在旁边补一条说明。

**做法**：`src/preload/index.ts` 的 `installFsObservationHint()`，挂在 `tick()` 里
（和 brand / hero / open-in-app 同一个 mutation + 600ms 轮询）。

- 在 `[data-conversation-scroll]` 里用 `TreeWalker` 找含 `file has not been read` 的**文本节点** ——
  报错是拼好的一个字符串，所以落下来就是一个文本节点；这个容器是源码里写死的 `data-*`，不是哈希类名。
- 命中就在该节点所在元素的**后面**插一条提示（`data-kokona-fs-hint`），源元素打
  `data-kokona-fs-hinted` 防重复。
- 提示样式是**内联**的，颜色取 `currentColor` + `color-mix`，所以自动跟随主题，不用额外样式表。
- 每次 tick 先清一遍**孤儿提示**（源元素被 React 重渲染换掉 → 提示的 `previousElementSibling`
  不再是带标记的元素）→ 自愈，不会堆出重复。
- 全量走文本节点有成本，所以**限流 2 秒**一次；这个延迟看不出来。

**没验证的部分**：检测依赖「报错在页面上是一个纯文本节点」。这一点是**推断**的（错误由模板字符串拼出），
没有真在页面上确认。如果实际渲染把文字拆开了，或者根本不显示这段文本，就得换锚点。

**验证**：`npm run typecheck` / `npm run build` 通过。真机确认需要**重启核心**，然后让 agent 去编辑
一个重启前读过的文件 —— 报错下面应该出现那条提示。









