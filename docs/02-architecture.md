# FlowTray 架构（Tauri 2 重构版）

版本 0.2.0 · 2026-10-31

## 1. 总览

```
┌──────────────────────────── Rust（主线程 + 工作线程） ────────────────────────────┐
│ main.rs       单实例互斥、DPI、日志、窗口创建、flowtray:// 缩略图协议、事件循环        │
│ app.rs        全局状态：SQLite 连接、设置快照、撤销槽、窗口状态、广播通道              │
│ commands.rs   45 个 #[tauri::command]，对应旧 preload API                          │
│ actions.rs    跨模块业务动作（设置副作用、存储迁移、清空数据、到期提醒）              │
│ items.rs      领域核心：入库/去重/复制/失效/到期/视图/用量                          │
│ db.rs         建表与迁移（与旧版 schema 完全一致）                                   │
│ settings.rs   设置默认值、区间校验、敏感应用判定                                     │
│ fsx.rs        文件名清洗、目录内拷贝/移动、磁盘剩余、哈希、身份键                    │
│ thumbs.rs     缩略图（image 缩放为 360px PNG）                                      │
│ clipboard.rs  Win32 剪贴板：文本/HTML/文件列表/图片读写 + 监听                       │
│ drag_out.rs   OLE DoDragDrop 拖出（SHCreateDataObject + 自研 IDropSource）          │
│ drop_target.rs 可选 OLE IDropTarget（路径/文本/HTML/URL + 实时修饰键）              │
│ window.rs     悬浮窗几何（逻辑像素 + DPI 换算）、显隐、peek、失焦处理                │
│ tray.rs       托盘图标、菜单、勾选项、退出                                          │
│ shortcuts.rs  global-hotkey 服务线程（注册/回滚/挂起/恢复）                          │
│ autostart.rs  HKCU Run 键 + schtasks 管理员自启                                     │
│ edge.rs       光标轮询边缘唤出（150ms）                                             │
│ lifecycle.rs  到期扫描（30s）、失效校验（3min）、回收（1h）、剪贴板监听（700ms）      │
│ winapi.rs     Shell 打开/定位、前台进程、文件夹选择器、提升权限、DPI                  │
└────────────────────────────────┬───────────────────────────────────────────────────┘
                                 │ Tauri IPC（invoke / emit）
┌────────────────────────────────▼───────────────────────────────────────────────────┐
│ React 渲染层（WebView2）                                                           │
│ src/api/index.ts  实现 window.flowtray：命令、事件订阅、原生拖入/拖出桥接            │
│ App.tsx / components / styles：与旧版一致（仅拖入处理与 host 字段名有两处改动）      │
└────────────────────────────────────────────────────────────────────────────────────┘
```

## 2. 状态与线程模型

| 资源 | 归属 | 说明 |
| --- | --- | --- |
| `rusqlite::Connection` | `App.db: Mutex<Connection>` | 所有命令与后台任务串行访问；WAL、`synchronous=NORMAL`、`busy_timeout=4000` |
| 设置 | `App.settings: RwLock<Settings>` | 读取即时；写入同时落库（`settings` 表 JSON-per-key） |
| 撤销槽 | `App.undo: Mutex<Option<UndoEntry>>` | 单槽，清空 30s / 删除 10s / 到期 60s |
| 快照广播 | `mpsc::Sender<()>` + 专用线程 | 32ms 合并，避免拖入 200 个文件时刷屏 |
| 快捷键 | 独立线程（Win32 消息循环） | 通过命令通道注册/挂起，失败自动回滚 |
| 边缘唤出 | 独立线程 | 150ms 轮询光标，不安装系统钩子 |
| 生命周期 | 独立线程 | 30s 到期扫描；3min 失效校验；1h 回收 |
| 剪贴板监听 | 独立线程 | 700ms 轮询，默认关闭 |

主线程只做窗口与事件循环相关工作；命令是同步的（Tauri 在事件循环线程执行），因此所有跨线程调用（托盘刷新、窗口位置）都通过 `run_on_main_thread` 或 Win32 消息完成，避免死锁。

## 3. 数据模型

与旧版一致（`items` 表）：

| 字段 | 说明 |
| --- | --- |
| `id` | `it_` + 时间 + 随机 |
| `type` | `file` / `folder` / `image` / `text` / `url` |
| `ref_path` | 引用模式下的原文件路径 |
| `stored_rel` | 副本相对 `storage/` 的路径 |
| `thumb_rel` | 缩略图相对路径 |
| `storage_mode` | `reference` / `copy` |
| `identity` | 去重键：路径+大小+mtime / 文本哈希 / URL / 图片哈希 |
| `expires_at` / `pinned_at` / `status` | 生命周期 |
| `sort_order` | 新项在前；重复项刷新排序 |

索引：`status`、`sort_order`、`expires_at`、`identity`。

数据库损坏时启动会备份为 `flowtray.db.corrupt-<ts>` 并重建（不触碰用户原文件）。

## 4. 关键链路

### 拖入

1. `dragDropEnabled: true` → WebView2 原生拖放把文件路径交给 wry，Tauri 触发 `tauri://drag-drop`。
2. `src/api/index.ts` 的 `onFileDrop` 订阅事件，App 统一走 `ingest()`：取前台应用名 → `items.addPaths`。
3. 文本/URL 拖入由 DOM `drop` 兜底（`dataTransfer.getData`）。
4. 实验性 `FLOWTRAY_OLE_DROP_TARGET=1` 会安装自研 `IDropTarget`，可额外拿到文本、HTML、URL 与实时修饰键，用于判断复制/剪切。

### 拖出

1. 渲染层 `items.startDrag({ids, effect})` → `drag_out::start`。
2. 后台线程创建 OLE 数据对象（`SHParseDisplayName` + `SHCreateDataObject`）。
3. 复制模式默认先做安全暂存：文件尝试硬链接（≤64MB 可退化为复制），文件夹复制（≤256MB）；超大目标退化为原路径并提示。
4. `DoDragDrop` 返回 `DROPEFFECT`；剪切或目标执行移动后 900ms 检查路径，消失则删除卡片。

### 剪贴板

- 写入：`CF_UNICODETEXT`、`HTML Format`、`CF_HDROP`、`CF_DIB` + `PNG`。
- 读取：文本、HTML Fragment、文件列表（`DragQueryFileW`）、图片（优先 PNG，回退 DIB 解码）。
- 监听：指纹去重、自身写入抑制 1.4s、前台敏感应用（进程名或窗口标题命中）跳过。

### 窗口

- 无边框透明窗，`create: false`，在 setup 中自行创建并把 WebView2 配置目录指向 `%APPDATA%\FlowTray\webview`。
- 几何全部用逻辑像素与 Tauri 交互；显示器工作区与光标位置来自 Win32（物理像素，按 `scale_factor` 换算）。
- 贴边（左/右）、垂直居中、peek 32×180 穿透窗、失焦隐藏（220ms 事件 + 看门狗）。
- 首次显示会做一次 160ms 的 hide/show，强制 WebView2 合成树挂载（否则首帧空白）。

## 5. 安全

- 前端无 Node 集成；CSP 限制脚本与连接来源；缩略图走自定义协议 `flowtray://`，只允许读取当前卡片的缩略图。
- 路径操作：`resolve_under` 拒绝绝对路径与 `..`；剪切拒绝系统目录与应用数据目录。
- 命令参数用 serde 结构体验证；设置逐字段校验并限制区间。
- 日志脱敏：路径、邮箱、内容字段全部替换；只记录事件与错误码。
- 清除数据：关闭数据库 → 删除 storage/thumbs/drag-cache → 可选删除数据库与日志 → 重启。

## 6. 与旧版实现差异

| 领域 | Electron | Tauri |
| --- | --- | --- |
| 缩略图协议 | `flowtray://thumb/<id>`（protocol.handle） | `http://flowtray.localhost/thumb/<id>`（register_uri_scheme_protocol） |
| 窗口尺寸 | BrowserWindow.setBounds（DIP） | Tauri 逻辑像素 + Win32 工作区 |
| 通知 | Electron Notification | 自动浮现 + 应用内 Toast |
| 前台应用 | PowerShell + C# 脚本 | 原生 Win32 API |
| 存储位置迁移 | Electron dialog | `IFileOpenDialog` |
| 单实例 | `app.requestSingleInstanceLock` | 命名互斥量 + `FindWindowW` 置前 |

## 6.1 启动与单实例

- 手工启动（双击、快捷方式）总是显示悬浮窗；开机自启通过 `--autostart` 参数区分，只有它遵循「启动时展开」设置。
- 首次运行 Tauri 版会写 `meta.tauri_seen` 并强制显示一次，避免沿用旧版 `openAtLaunch=false` 时看起来「没有反应」。
- 单实例：`Local\FlowTray.SingleInstance` 互斥量 + `Local\FlowTray.ShowShelf` 命名事件；第二个实例 `SetEvent` 后退出，已运行实例的监听线程唤出窗口。
- 启动 panic 会写入 `logs/crash.log` 并弹出错误框（`panic` hook），不会静默退出。

## 6.2 安装与完整性标签

- 仓库不再包含安装器：分发物是可直接运行的文件夹，打包方式见 `docs/05-app-folder.md`。
- 卸载时无法删除自身：程序会把自身复制到 `%LOCALAPPDATA%\Temp` 并以 `--cleanup` 模式启动，由它删除 `Uninstall.exe` 与安装目录，再用 `MoveFileExW(MOVEFILE_DELAY_UNTIL_REBOOT)` 删除临时副本。不调用 `powershell.exe`，避免触发安全软件的「隐藏执行 PowerShell」拦截。
- 构建产物若继承了工作区的低完整性标签，需要 `icacls … /setintegritylevel Medium`（`scripts/relabel-release.ps1`），否则进程以低完整性运行，无法写入 `%APPDATA%`。

## 6.3 显隐动画与边缘唤出

- 贴边提示条（peek）固定在工作区垂直中央：`y = work_y + (work_h - PEEK_HEIGHT) / 2`，不再读取光标位置，轮询线程也不会在光标移动时反复调用 `show_peek`（旧实现每 6px 抖动就重设一次窗口并 `show()`，是卡顿来源之一）。
- 显示流程：`show_shelf` → 仅在几何变化时 `set_size/set_position`（缓存上一次几何）→ 仅在变化时改置顶/鼠标穿透 → `window.show()` → 渲染层 `window-shown` 后直接播放 210ms 淡入+位移（0% 关键帧为全透明，避免先闪出成品卡片）。
- 隐藏流程：`hide_shelf` → `window-will-hide` → 渲染层播 150ms 淡出 → `window_hide_ready` 命令 → 后端口 `window.hide()`；另有 360ms 兜底定时器，WebView 卡死时也能收起。
- 从 peek 展开时先 `hide()` 再改尺寸，避免用户看到 32px 提示条被拉伸成整窗。
- `backdrop-filter` 从 32px 降到 18px 并加 `will-change: transform, opacity`：透明窗口每帧都要重算背景模糊，这是掉帧的主要开销。
- 显示后 1.2s 内忽略失焦：从后台进程启动时 Windows 可能不会立即把前台交给悬浮窗，抢焦失败会立刻触发 blur，导致「一闪就没了」。

## 6.4 剪贴板合集与拖拽语义（0.3.0）

- `items.source` 区分来源：`drop`（拖入）、`clipboard`（用户主动存入）、`clipboard_auto`（自动监听抓取）、`manual`。只有 `clipboard_auto` 会进入「剪贴板合集」。
- 渲染层在 `settings.clipboardSeparate` 开启时把 `clipboard_auto` 从「全部/文件/图片/文本/链接」中剔除，单独通过「剪贴板」筛选查看；主列表（及空状态）显示合集入口卡片。
- 一次捕获 ≥ 5 项时后端发提示 Toast（复制、拖入、拖出三条路径共用 `items::BULK_HINT`）。
- 拖出语义：磁盘操作固定为安全副本；是否删除卡片由 `dragOutAutoRemove` 决定，按住 `dragModifier`（默认 Ctrl）反转。OLE `QueryContinueDrag` 里记录按键状态，落点判定后 650ms 检查并删除。
- 拖拽保护：主键按住时忽略失焦隐藏（`winapi::left_button_down`），交互锁带 8s 过期；隐藏后立即给边缘唤出重新武装（`edge_rearm`），避免「窗口消失且唤不回」。

## 6.5 0.3.1 修复要点

- 拖出线程：`OleInitialize`（而不是仅 `CoInitializeEx`）→ `DoDragDrop` 不再返回 `CO_E_NOTINITIALIZED`；日志 `drag.com` / `drag.finished` / `drag.failed` 可直接定位。
- 自启动：`settings_update` 只落库并立即返回；`autostart::apply` 在后台线程执行（`schtasks` 可能被安全软件拖慢），结果写 `autostart.applied` 并广播快照。
- 失焦隐藏：检查顺序改为「等左键松开 → 再判断交互锁/近期显示/焦点」，拖拽期间不隐藏，普通点击离开会收起。

## 7. 已知技术债

- `drop_target.rs`（文本/HTML 拖入）尚未在真实人工拖拽下做完整回归，因此默认不启用。
- 托盘通知仍依赖应用内 Toast，没有接入 Windows 通知中心（可后续加 AppUserModelID + toast）。
- 拖出没有自定义拖拽图标（旧版带数量叠加图）。
- 部分结构体字段（`storage_warning`、`booted_at` 等）暂未使用，编译期有 dead_code 警告。
