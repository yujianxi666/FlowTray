# FlowTray 技术架构（MVP）

版本 0.1.0 · 2026-10-30
运行环境：Windows 10 22H2+ / Windows 11，Electron 45.1.0（Node 24.22 / Chromium 156）

## 1. 架构摘要

```
┌────────────────────────────── Electron 主进程 ─────────────────────────────┐
│ app-controller (orchestrator)                                               │
│  ├─ Store: node:sqlite（items / settings / meta）                            │
│  ├─ ItemService         拖入、复制、引用、失效、到期、清空、视图               │
│  ├─ ClipboardService    异步 W3C 剪贴板、FileDrop、监听、敏感应用             │
│  ├─ DragService         硬链接/junction 暂存、startDrag、剪切校验             │
│  ├─ LifecycleService    30s 到期扫描 / 3min 失效校验 / 1h 回收                │
│  ├─ ShortcutService     全局快捷键、冲突探测、暂停/恢复                       │
│  ├─ TrayService         托盘菜单/计数/勾选项                                  │
│  ├─ AutostartService    登录项 + 管理员计划任务                               │
│  ├─ EdgeRevealService   光标轮询、边缘停留                                     │
│  └─ UndoManager         删除/清空/到期的单槽撤销                               │
│                                                                            │
│  ShelfWindow: 无边框透明 BrowserWindow + CSS 半透明 + 自定义贴边/尺寸/peek │
│  IPC: contextBridge + Zod 校验 + sender 校验 + 自定义 flowtray:// 缩略图协议   │
└──────────────────────────────────┬─────────────────────────────────────────┘
                                   │ typed IPC (invoke/on)
┌──────────────────────────────────▼─────────────────────────────────────────┐
│ preload（sandbox，contextIsolation）                                        │
│ window.flowtray = items / app / settings / window / shortcuts / __e2e      │
└──────────────────────────────────┬─────────────────────────────────────────┘
                                   │
┌──────────────────────────────────▼─────────────────────────────────────────┐
│ Renderer（React 19 + Zustand）                                               │
│ Header / SearchFilter / ItemList / ItemCard / SelectionBar / Footer           │
│ SettingsPanel / Onboarding / InfoSheet / ContextMenu / ConfirmDialog          │
│ ToastHost / DropOverlay / ResizeHandles                                      │
└────────────────────────────────────────────────────────────────────────────┘
```

主进程是唯一能访问文件系统、剪贴板、SQLite 与全局快捷键的地方。渲染进程没有 Node 集成，只通过 preload 暴露的类型化 API 与主进程通信。

## 2. 技术选择

| 维度 | 选择 | 理由 |
| --- | --- | --- |
| 运行时 | Electron 45 | 跨应用拖拽、透明毛玻璃、全局快捷键、剪贴板格式、托盘均开箱可用；UI 迭代快 |
| UI | React 19 + TS + Vite 8 | 组件化、状态清晰、热更新；无 UI 框架，手写设计系统控制质感 |
| 状态 | Zustand | 单窗口、快照驱动，避免 Redux 样板 |
| 存储 | `node:sqlite` | Electron 45 内置 SQLite 3.53；零原生模块、零 ABI 重编译、WAL |
| 拖拽 | 原生 HTML5 drag + Electron `webContents.startDrag` | 唯一能与其他 Windows 应用进行 OLE 拖放的方式 |
| 剪贴板 | Electron 45 异步 W3C Clipboard API | 45 起旧的同步 `readBuffer/readImage/availableFormats` 已移除 |
| 测试 | Vitest + playwright-core `_electron` | 单元快；E2E 可控制主进程、截取真实桌面 |
| 打包 | electron-builder | NSIS + Portable，成熟 |

完整方案对比与未选方案见 [decisions-tech-stack.md](decisions-tech-stack.md)。

## 3. 数据模型

`items` 关键字段：

| 字段 | 说明 |
| --- | --- |
| `id` | `it_` + 随机 |
| `type` | `file` / `folder` / `image` / `text` / `url` |
| `name` | 展示名（文件名可被用户改名；文本取首行） |
| `ref_path` | 引用原文件/文件夹的绝对路径 |
| `stored_rel` | FlowTray 自有副本相对 `storage/` 的路径 |
| `thumb_rel` | 缩略图相对 `storage/` 的路径 |
| `storage_mode` | `reference` / `copy` |
| `text_content` / `html_content` / `url` | 文本、富文本、链接内容 |
| `size` | 文件字节 / 文本字符数 / 图片字节 |
| `source_app` / `source` | 来源应用、入口（drop / clipboard / hotkey / seed） |
| `created_at` / `updated_at` / `expires_at` / `pinned_at` | 时间与固定 |
| `status` | `active` / `missing` / `deleted` / `expired` |
| `identity` | 去重键：路径+大小+mtime / 文本 hash / URL 归一化 / 图片 hash |
| `sort_order` | 最新在前；重复项会刷新 |
| `moved_in` / `original_path` | 剪切移入时可放回 |
| `last_checked_at` | 失效校验节流 |

索引：`status`、`sort_order DESC`、`expires_at`、`identity`。WAL + `synchronous=NORMAL`，写入事务用 `BEGIN IMMEDIATE`。

`settings` 以 JSON-per-key 保存，设置增量写入；`meta` 保存 schema/迁移标记。数据库损坏时，启动会把原文件重命名为 `flowtray.db.corrupt-<ts>` 并重建，避免无法启动。

## 4. 数据流

### 拖入

1. Renderer `drop` 事件收集 `DataTransfer.files` / `getData`。
2. preload 的 `webUtils.getPathForFile(file)` 取得真实路径（Electron 45 不再暴露 `file.path`）。
3. `items.addPaths/addText/addUrls` IPC；主进程用 Zod 校验、限制数量/长度。
4. `ItemService` 建行 → 复制/引用策略 → 缩略图/类型牌 → 去重 → 广播快照。
5. 快照合并 60ms 节流后推给渲染进程；渲染层乐观显示处理态，避免拖入等待。

### 快照

`getSnapshot()` 一次返回 items、counts、storage、settings、host、undo。渲染层 Zustand 只保存这一份快照；所有 mutation 返回 `MutationResult`，失败进 Toast。

### 缩略图

`flowtray://thumb/<id>?v=<updated_at>` 由主进程 `protocol.handle` 读取 `thumb_rel`，通过 `net.fetch(pathToFileURL(...))` 返回，避免 `file://` 暴露磁盘路径。非图片文件不生成 Windows 原生图标，统一绘制类型牌，保证深浅色一致。

## 5. 存储策略

默认根目录 `%APPDATA%\FlowTray\storage`：

```
storage/
  files/      # 复制/剪切移入的副本
  thumbs/     # 图片缩略图 PNG
drag-cache/   # 拖出硬链接/junction，48h 清理
```

- 副本文件名 `时间戳-随机-安全文件名`，`sanitizeFileName` 处理非法字符与保留设备名。
- 所有相对路径写入 DB；迁移只改 `storageDir` 并移动 `files`/`thumbs`，DB 不需要重写。
- 复制时先写临时文件再 rename；失败清理。
- 容量只统计 `storage/files` 与 `thumbs`，不把引用文件算进"占用"；底部显示「引用 X · 不占空间」。
- 校验：文件 `stat` 大小/mtime；mtime 变化也视为失效，避免同名替换导致误用。启动全量、运行中 3 分钟一次、窗口显示时轻量检查。
- 软删除保留 7 天，定时物理清理；副本同步删除。

## 6. 拖出实现

Electron 的 `startDrag` **不允许指定目标放置效果**，且拖动循环会阻塞主进程。因此：

| 效果 | 做法 | 风险 |
| --- | --- | --- |
| 复制 | 同卷文件硬链接（≤64MB 失败则复制）到 `drag-cache`；文件夹创建 junction | 目标若"移动"，只会移走暂存链接，原文件安全 |
| 剪切 | 直接使用源路径；拖动结束 0.9s 检查路径是否消失，消失则移除卡片 | 目标应用若只复制不移动，源文件保留（符合用户预期） |
| 复制（跨盘大文件） | 退化为源路径并 Toast 提示 | 目标应用可能移动原文件；用户被明确告知 |
| 文本 | Renderer 原生 HTML5 `text/plain` (+`text/uri-list`) | 目标应用兼容性差异 |

拖拽图标由主进程用 `nativeImage.createFromDataURL` 生成，2× 尺寸，包含数量与"复制/剪切"。

## 7. 剪贴板

Electron 45 的 `clipboard.read()` 返回 `ClipboardItem[]`；`getType()` 对文本返回 **Blob**，需要 `await blob.text()`。这是 45 的破坏性变化，旧代码按 string 读取会丢失文本/文件列表。本项目：

- 支持 `text/plain`、`text/html`、`text/uri-list`、`image/png`、`Files`/`FileNameW` 等。
- 图片生成缩略图并写本地副本；文件通过 URI list 复制；`copyFiles` 写 `text/uri-list` + `text/plain`，在资源管理器验证可粘贴为 FileDrop。
- 监听默认关闭；开启后 700ms 轮询，指纹去重，自身写入抑制 1.5s，前台敏感应用跳过。
- 敏感判定：进程名包含排除词，或窗口标题包含密码/Password 等词；排除列表用户可编辑。
- 日志只记录事件、ID、错误码；路径/邮箱/URL/内容字段一律脱敏。

## 8. 窗口与系统集成

- `transparent: true`、`frame: false`、`skipTaskbar: true`、`backgroundColor: '#00000000'`；**不使用系统 `setBackgroundMaterial('acrylic')`**，因为透明窗 + acrylic 会在卡片外的矩形区域露出半透明/黑色底材。半透明由 CSS alpha + `backdrop-filter` 完成，窗口与卡片等大。
- 卡片区域 396×680；窗口不保留 16px gutter；贴右时窗口 x=工作区右-396，卡片右边缘贴屏幕。左/上/下圆角之外的透明三角由 DWM 直接透出桌面。
- 边缘提示条复用同一个 BrowserWindow：窗口临时收窄为 32×180、`setIgnoreMouseEvents(true)`、`showInactive`；光标进入贴边 1/4 区域时显示，贴边停留后恢复 396×680 并聚焦/展开。不会新增渲染进程。
- 自定义 resize：渲染层 8 个把手 + IPC 设置 bounds；提交后写设置。
- 边缘唤出 150ms 轮询、450ms 停留、离边 80px 重新武装；不安装钩子。
- 全局快捷键注册失败会回滚到旧值；录制时暂停注册，避免按键被自己拦截。
- 开机启动用 `app.setLoginItemSettings`（普通）或 `schtasks /Create /RL HIGHEST`（管理员）；非管理员时禁用管理员项并给出一键重启。
- 单实例锁；第二次启动只显示已有窗口。
- 退出只从托盘「退出」或系统关机，不在关闭按钮退出（符合托盘工具心智）。

## 9. 安全

- `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`、`webSecurity: true`。
- preload 只暴露白名单 API；无任意 IPC 通道。
- `ipcMain.handle` 统一 sender 校验（只允许 ShelfWindow 的 webContents），所有入参 Zod 校验。
- 阻止 `will-navigate`、`setWindowOpenHandler` 外部打开一律 `shell.openExternal`。
- 权限请求默认拒绝（无摄像头/麦克风/通知需求）。
- CSP：`default-src 'self'; script-src 'self' 'unsafe-inline'（Vite dev 兼容）; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: flowtray:; object-src 'none'`。生产构建不依赖远程脚本；后续可移除 inline 脚本许可。
- 路径操作拒绝绝对/`..` 越界；剪切拒绝系统/程序目录；数据库参数化查询。
- 日志脱敏；不记录剪贴板内容、文件内容、完整 URL。
- 清除数据：关闭 DB → 删除 storage/drag-cache/thumbs → 重建；重置全部还包括 DB、日志、设置。

## 10. 性能与体积

- 窗口常驻（不做每次创建）；启动到可操作 < 1s；快捷键呼出实测 3ms。
- 50 卡实测：数据写入+渲染 252ms，滚动布局 105ms。
- 快照 60ms 合并；卡片列表只渲染当前筛选，数量上限 3000。
- 图片缩略图 512px 长边，列表用 CSS 显示；非图片不生成原生图标。
- 设置页懒加载为独立 chunk（约 57KB），首屏 JS 约 756KB；首屏后 1.5s 预取，打开设置不等待。
- 主题配色：设置保存 `darkBackground/darkAccent/lightBackground/lightAccent` 四个 hex；渲染层按当前主题把 `--bg-shell`、`--ink*`、`--line*`、`--bg-card*`、`--accent*` 写入 `:root`。背景亮度决定文字深浅，强调色亮度决定按钮文字色；固定语义色（pin/危险/类型）不跟随强调色。
- 空状态 SVG、引导插画、品牌标记与 edge peek 都改用 `var(--accent)`，切换颜色不需要重渲染组件树。
- 单窗口边缘提示：peek 复用同一个 BrowserWindow，不新增 renderer/GPU 进程。
- 去掉系统 acrylic 与 16px gutter：窗口像素减少约 6%，没有额外 DWM 材质层。
- 打包只保留 zh-CN / en-US 语言包，`compression: maximum`；NSIS 从 124.5MB 降到 116.0MB，Portable 从 112.2MB 降到 104.5MB。
- 运行时实测（Windows 11、单屏、7s idle）：4 个进程，工作集约 424MB，私有内存约 285MB；Electron 的底层成本，继续降需要换技术栈。

## 11. 目录与关键文件

| 文件 | 职责 |
| --- | --- |
| `src/main/index.ts` | app 生命周期、协议、单实例、崩溃恢复 |
| `src/main/app-controller.ts` | 服务编排、设置副作用、快照、迁移、清空 |
| `src/main/window/shelf.ts` | 窗口、贴边、尺寸、显隐、peek、自动隐藏 |
| `src/main/services/items.ts` | 领域核心（最大文件） |
| `src/main/services/drag.ts` | 拖出暂存与 startDrag |
| `src/main/services/clipboard.ts` | 剪贴板读写/监听 |
| `src/main/store/db.ts` | schema 与事务 |
| `src/shared/settings.ts` | Zod schema + 默认值 + 敏感判定 |
| `src/renderer/src/lib/theme.ts` | 主题色推导/注入：背景、强调色、文字对比、CSS 变量 |
| `src/renderer/src/App.tsx` | 浮层路由、快捷键、拖拽生命周期 |
| `src/renderer/src/store.ts` | 快照与 UI 状态 |

## 12. 已知技术债

1. 没有自动更新、崩溃上报、签名；发布前必须补。
2. 边缘唤出是轮询，无法感知"拖拽经过"的加速；延迟调优有限。
3. 文件夹复制拖出用 junction，部分应用会当快捷方式；需要按目标应用验证。
4. 存储迁移失败的回滚是"尽量恢复"，极端断电场景需要更强的日志/恢复协议。
5. 设置 UI 无独立窗口；多显示器位置记忆未实现。
6. 主进程单线程，超大文件夹的递归复制可能卡顿；已有 64MB/硬链接阈值，但没有 worker。
7. 测试主要覆盖 Windows 11/单屏/125%；高 DPI 多屏、Win10、管理员边界需人工矩阵。
