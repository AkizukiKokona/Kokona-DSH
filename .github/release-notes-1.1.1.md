## ⚠️ 如果你装过 1.1.0，请更新

**1.1.0 在一台没有装过 Node.js 的电脑上无法启动**，会卡在启动页并报：

```
Node.js not found. Install Node 22.19+ (winget install OpenJS.NodeJS.LTS) or set "nodePath" in config.json
```

这是我的失误：1.1.0 的验证是在开发机上做的，而开发机上 Node、npm、pnpm、内核全都在，所以任何依赖它们的代码都显示「通过」。**发行版是给干净机器用的，这个区别我之前没有真正验证过。**

1.1.1 修好了它，并且这次是在**隔离的 userData + PATH 里剥掉 Node/npm/pnpm** 的环境下实测通过才发出来的。

---

## 这个版本的核心变化：装完就能用，什么都不用装

安装包现在自带运行所需的一切：

| 内置内容 | 体积 | 作用 |
|---|---|---|
| **Node.js 运行时** | 88 MB | 跑内核。用户不需要自己装 Node |
| **DSH 内核** | 453 MB | 完整内核，首次启动直接铺开，不联网下载 |
| **npm** | 11 MB | 内核升级用 |
| **pnpm** | 17 MB | 插件管理用 |
| **插件 profile** | 252 MB | 含下列插件及其全部依赖 |

**首次启动不需要网络，不需要 Node、npm 或 pnpm。**

### 内置插件

- `dsh-better-sidebar` —— 侧栏
- `dsh-plugin-wallpaper-engine` —— 动态壁纸
- `dsh-whale-widget` —— 小鲸鱼挂件
- `dshmarket` —— 插件市场

---

## 功能依赖说明

### 动态壁纸

- **需要本机已安装 [Wallpaper Engine](https://www.wallpaperengine.io/)。** 没有安装的话只有这个功能不可用，其余功能完全不受影响。
- **仅限 Windows。** macOS 和 Linux 上没有这个功能。

---

## 修复

- **干净机器无法启动** —— 内核现在跑在内置的真 Node 上，不再依赖系统 PATH。
- **`ELECTRON_RUN_AS_NODE` 被错误删除** —— 环境构造不再动这个标志。
- **首次启动必须联网装内核** —— 内核、pnpm 和插件 profile 全部内置。
- **终端里的 `dsh` 命令** —— 不再依赖 PATH 里的 `node`，直接走内置运行时。
- **安全模式** —— 内置 profile 不会污染安全模式，它仍然是插件全禁的干净 profile。

## 已知限制

- **安装包体积显著增大**（约 250 MB）。这是「零依赖可用」的代价 —— 需要离线可用就必须把运行时带在身上。
- macOS 和 Linux 的产物由 CI 构建，本版本在 Windows 上完成了干净环境实测。

## 校验

干净环境实测（全新 userData、全新 dshHome、PATH 中剥除 node/npm/pnpm）：

```
[runtime] seeding core 0.1.7-rc.2 from bundled baseline
[profile] seeding profile "kokona" from the bundled copy
[core] spawning core: ...\resources\node\node.exe ...dsh\lib\bin.js
[core] core ready at http://127.0.0.1:19412/
[window] page loaded: http://127.0.0.1:19412/ titlebar=true
```

启动到就绪约 45 秒（含首次铺开 700 MB 内置资源）。
