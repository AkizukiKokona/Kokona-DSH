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
  --we-sidebar-blur: var(--we-blur, 16px);
  --we-sidebar-tint: calc(var(--we-glass-alpha, 0.2) * 80%);
  --we-sidebar-saturate: var(--we-saturate, 1.8);
  --we-sidebar-sheen: 1;
}
```

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

