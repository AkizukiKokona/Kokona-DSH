# KokonaHarness

[English](README.en.md) | 简体中文

> **1.0.2 起更名为 KokonaHarness。** 仓库迁到 [GitHub](https://github.com/AkizukiKokona/KokonaHarness) 与 [Codeberg](https://codeberg.org/AkizukiKokona/KokonaHarness)，外壳内置的自动更新已指向新仓库；旧仓库和旧发行版不再维护，也不做迁移。数据目录仍叫 `%APPDATA%\KokonaDSH` —— 刻意保留原名（`app.setPath('userData', ...)` 钉住了），免得升级时把已经下好的内核重下一遍。

一个 DeepSeek Harness（`dsh`）桌面外壳。Electron + 网页渲染的内核，补上现有那些半成品桌面端缺的两件事：

1. **内核与应用分开更新。** 外壳和 DSH 内核各自版本化。每个已安装的内核版本放在独立目录，切换或回滚都不用重装应用；内置基线内核让首次启动可以离线完成。
2. **自定义深色标题栏。** 无边框窗口，没有那条白色的系统标题栏。窗口控制按钮和应用自己的侧栏品牌处在同一条 48px 线上，拖拽区域只占用真正空白的像素 —— 所以应用的控件和 `dsh-better-sidebar` 都照常工作。

## 架构

```
KokonaHarness（Electron 外壳）
  main/            应用生命周期、窗口、IPC
    runtime/       内核版本管理（基线 + npm 频道）
    core/          profile 初始化 + 启动 dsh 进程 + 就绪探测
  preload/         窗口控制桥 + 往 DSH 页面注入标题栏
  renderer/        启动页 + 内核管理面板（原生 TS，无框架）

DSH 内核（@deepseek-ai/dsh）  <- 按版本装到 <userData>/runtime/<version>
  启动命令: node <bin> --profile kokona --no-open --port <free>
  数据目录: $DSH_HOME（默认 ~/.dsh，与官方客户端共用）
```

从不修改内核。只以我们自己的 profile 启动公开 CLI，并往它服务的页面注入标题栏浮层。

## 外壳集成

注入到 DSH 网页里（从不改内核）：

- **设置头部按钮。** DSH 设置面板的内容列头部有 `settings.action` 槽（内置的"打开配置文件"按钮就在这）。KokonaHarness 往这里追加两个同级按钮，样式直接克隆现有按钮的 class：
  - **DSH 终端** —— 在 `DSH_HOME` 打开平台终端，并把当前内核的 `node_modules/.bin` 加进 `PATH`，进去即可直接用 `dsh`。
  - **重启菜单** —— 下拉：*重新加载界面*、*重启*、*重启进安全模式*。
- **设置里的"检查更新"选项卡。** 往设置导航注入一个导航项，面板分两段：
  - **内核更新**（上）：对比 npm 频道、安装新内核版本、在已安装版本间切换、重启内核。
  - **外壳更新**（下）：检查 KokonaHarness 本身是否有新发行版。国内优先 Codeberg，国外优先 GitHub（`updateSource` 可强制）；只检查发行版，有更新时给一个"打开发行页"按钮。
- **安全模式** 启动一个从官方 `web` 模板生成的兄弟 profile `<profile>-safe`，不加载任何插件。这就是 CLI 文档里的 `dsh --profile rescue --from-default-profile web`。
- **插件市场。** `dshmarket`（"DSH 可视化插件市场"）作为预设插件安装。
- **关闭右栏时隐藏残留面板。** DSH 在右栏折叠后仍把 `[data-sidebar-right-panel]` 挂载且可见（`position:absolute`、相对 0 宽的 `_rightbarCol` 向右锚定、`pointer-events:none`）。壁纸类插件会给这个面板套侧栏毛玻璃且不判断开关状态，导致右半屏出现一层半透明模糊。KokonaHarness 会在 `_rightbarCol` 宽度归零时把该面板 `display:none`，展开时恢复。

窗口标题强制为 `KokonaHarness`（拦截 `page-title-updated`），DSH 页面自己的 document title 不会改掉窗口名。

设置里的锚点是结构化的，不用 hash 类名：操作容器是紧挨设置关闭按钮（`button[class*="_close"]`）之前、class 以 `_actions` 结尾的元素；导航列表是面板下的 `[class*="_navList"]`。React 重渲染由 `MutationObserver` 兜底重注入。

## 标题栏（拓展模式）

- Windows/Linux 无边框；macOS 用 `titleBarStyle: 'hidden'` 保留红绿灯。
- 注入的浮层读取 DSH 自己的 `--dsh-frame-top-clearance`（48px），让控件和侧栏品牌对齐。
- 拖拽由按真实布局算出的多个小拖拽段完成：顶栏里每个可交互元素（按钮、品牌、`[data-slot]` 组件、better-sidebar 控件）都被排除，不会挡住任何东西。
- 窗口控制按钮钉死在最右、永不移动。应用自己的右上工具簇（`_headerUtilities` / `_headerCorner`）用 `translateX` 整体左移一次，使这一行读作 `[应用按钮][窗口控制]`。只位移最外层匹配的簇（嵌套的剔除，避免重复位移），控制容器 `pointer-events: none`（只有按钮捕获事件），绝不吞掉应用按钮的点击。
- `dsh-better-sidebar` 不受影响：不占右栏宽度，也不碰 `--dsh-sidebar-height`。

## 环境要求

- PATH 里有 Node.js `^22.19.0 || >=24`（用于跑内核）：`winget install OpenJS.NodeJS.LTS`。
- PATH 里有 pnpm `>=11`，用于插件管理（`dsh plugin ...`）：`npm i -g pnpm@11.7.0`。

## 开发

```sh
npm install
npm run dev          # electron-vite，main/preload/renderer 热重载
npm run typecheck
npm run build
```

## 打包

```sh
npm run prepare:baseline        # 可选：把一份内核内置到 resources/runtime-baseline
npm run dist                    # electron-builder -> release/
```

未内置基线时，应用首次启动会从 npm 安装当前频道版本。

## 启动页与图标

内核安装/启动期间，窗口显示启动页：应用图标、产品名，以及 Windows 10 启动转圈。转圈直接移植自 `windows_10.css` 示例：五个点，每个跑一段 4.8s 的多段 `rotate` 关键帧（225°→945°，混用 `ease-out`/`linear`/`ease-in-out`），错开 240ms，开头淡入、76% 处淡出 —— 正是这个错开的淡出让点看起来在环上流动。内核就绪后窗口跳转到 DSH 页面。启动失败时，错误显示在启动页上并带"重试"；**详情**可看实时内核日志（`kokona:logs`）。

启动页跟随 DSH 自己的主题：注入脚本读取 DSH 页面的深浅状态并上报，外壳持久化为 `lastTheme`，下次启动套用到启动页（`<html data-theme="light|dark">`）；从未见过 DSH 主题时回退到系统偏好。

图标位于 `resources/icon.png`（512×512），渲染层也引入它用于启动页（`src/renderer/src/assets/kokona.png`）。`electron-builder` 会为 Windows 转成 `.ico`，mac/Linux 共用。替换时把方形 PNG 放到这两个路径即可。

## 窗口与托盘

窗口无边框。关闭（自绘关闭按钮或系统关闭）只是**隐藏**，不退出，内核继续跑、长任务不断。托盘图标常驻：

- **左键** —— 显示并聚焦主界面
- **右键** —— 菜单：`显示主界面` / `退出`

从托盘退出会先停内核再退出。`window-all-closed` 不会自行退出；唯一的关闭路径是 `before-quit`，它会先杀掉内核进程树。

## 配置

`<userData>/config.json`：

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `channel` | `beta` | `beta` -> npm `next`（0.1.7-rc.2，插件生态的版本），`stable` -> npm `latest`（0.1.5-rc.3） |
| `profile` | `kokona` | DSH profile（不使用被保留的 `desktop`）；安全模式用 `kokona-safe` |
| `port` | `19387` | 首选端口，被占用时自动换空闲端口 |
| `dshHome` | `null` | `null` -> `~/.dsh`（与官方客户端共用） |
| `nodePath` | `null` | 显式指定 Node 可执行文件 |
| `presetPlugins` | `["dsh-better-sidebar","dshmarket"]` | 首次启动时装进 profile 的预设插件 |
| `titlebar.height` | `48` | 应用变量缺失时的回退高度 |
| `titlebar.controls` | `custom` | Win/Linux 用 `custom`；macOS 用红绿灯 |
| `titlebar.insetRight` | `0` | 控制按钮额外的左内边距（自动避让应用控件） |
| `lastTheme` | `null` | 最近一次见到的 DSH 主题（`dark`/`light`），决定启动页主题 |
| `updateSource` | `auto` | 外壳更新检查源：`auto`（按语言/时区，中文优先 Codeberg）/ `codeberg` / `github` |

## 快捷键

- `Ctrl/Cmd + Shift + K` —— 开关内核管理面板。

## 内核更新

设置里的 **检查更新** 选项卡（或 `Ctrl/Cmd + Shift + K`）会列出已安装的内核版本。`检查更新` 对比 npm 频道；`安装` 把新版本装进独立目录；`使用` 切换激活指针并重启内核。应用二进制完全不动。

- 安装是**原子**的：先装到 `<version>.installing`，成功后才改名就位，中途被打断也不会留下半空的版本目录。
- 若激活版本文件不完整，直接按固定版本重装 —— **不查 registry** —— 所以修复不会卡在网络上。
- registry 查询有 8 秒超时。
- 切换会重启内核。如果新内核起不来（例如 profile 里的插件是按另一个内核版本构建的 —— `dsh-better-sidebar` 需要 `0.1.7-rc.2`，不是 `0.1.5-rc.3`），会**自动回滚**到上一个版本并提示。启动失败时窗口回到启动页显示错误和"重试"，不会把一个死页面留在屏幕上。

## 许可证

MIT。见 [LICENSE](LICENSE)。
