# FlowTray · 流转台

> 拖入即流转，用完即清理。

FlowTray 是一个 Windows 桌面文件「中转坞」：从资源管理器、浏览器或聊天窗口把文件、图片、文本、链接拖进屏幕侧边，稍后拖到另一个应用、批量复制，到期自动清理。没有账号、没有云端、没有遥测。

![FlowTray 暗色暂存台](docs/screenshots/shelf-dark.png)

## 当前能力（MVP / P0）

- **全局唤出**：托盘常驻；默认 `Ctrl + Alt + Space` 呼出/隐藏；托盘菜单；贴右/贴左；置顶；边缘悬停唤出；可拖拽调整宽高。
- **拖入收集**：文件、文件夹、图片、文本、URL；多文件一次拖入；拖入高亮；按住 `Ctrl` 临时把复制切换为剪切（可在设置里改成 Shift / Alt，也可反转默认行为）。
- **卡片信息**：类型、缩略图/类型牌、名称、大小、来源、时间、到期、固定状态；列表与网格两种视图；搜索、类型筛选、固定筛选、失效筛选。
- **多选与批量**：点选、Ctrl 点选、Shift 连选、全选、批量复制、批量复制路径、批量固定、批量删除、批量拖出。
- **拖出使用**：文件/文件夹/图片可原生拖到资源管理器、微信、邮件、浏览器等应用；文本/图片可复制到系统剪贴板；双击打开，右键定位、查看信息。
- **生命周期**：默认 24 小时过期；支持 1 小时 / 24 小时 / 7 天 / 永不过期；固定项不自动清理；到期前 15 分钟提醒；容量上限提示；启动时恢复、清理过期项并校验失效文件。
- **存储策略**：大文件默认只保存「路径 + 缩略图/类型牌」，不复制原文件；可切换「复制副本」；原文件移动/删除后标记失效，可重新定位。文本、URL、剪贴板图片保存在本地 SQLite + 缓存目录。
- **设置**：按通用、悬浮窗、存储与清理、拖拽、剪贴板与隐私、快捷键、关于分类；开机启动、管理员启动、存储位置迁移、一键清除数据。
- **隐私**：默认本地；剪贴板监听默认关闭；敏感应用排除（密码管理器等）；日志脱敏；一键清除本地数据。
- **首次引导**：3 步引导（快捷键唤出 / 拖入暂存 / 拖出使用），可在设置里重新查看。
- **可撤销**：清空、删除、到期清理都有可撤销窗口；清空默认保护固定项。

## 技术栈

| 层 | 选择 |
| --- | --- |
| 桌面运行时 | Electron 45（Windows 10 22H2+ / Windows 11） |
| UI | React 19 + TypeScript + Vite 8 + 手写设计系统 |
| 主进程 | TypeScript，服务化拆分（Item / Clipboard / Drag / Lifecycle / Shortcut / Tray / Autostart） |
| 存储 | SQLite（Electron 内置 `node:sqlite`，零原生编译依赖） |
| 文件缓存 | 用户数据目录下的 `storage/files`、`storage/thumbs` |
| 测试 | Vitest 单元测试 + Playwright Electron 端到端测试 + 原生拖拽模拟 |
| 打包 | electron-builder（NSIS 安装包 + Portable） |

没有任何原生 Node 插件；`node:sqlite` 随 Electron 内置，避免了 `better-sqlite3` 的 ABI 重编译问题。

## 快速开始

要求：Windows 10 22H2 以上 / Windows 11，Node 22.12+，pnpm 10+。

```powershell
pnpm install
pnpm dev
```

首次启动会显示 3 步引导。生产构建：

```powershell
pnpm build
pnpm dist:dir   # 生成 release/win-unpacked/FlowTray.exe，便于快速验证
pnpm dist       # 生成 NSIS 安装包 + Portable
```

产物位于 `release/`。当前没有代码签名证书，Windows SmartScreen 可能提示「未知发布者」；这是未签名本地应用的预期行为。

## 使用方式

1. 按 `Ctrl + Alt + Space` 呼出侧边暂存台；把文件/文件夹/图片/文本/链接拖进窗口。
2. 选中卡片后拖到目标应用；或点击卡片上的复制按钮、右键「复制」。
3. 固定重要内容（右键 / 卡片上的图钉），其余内容默认 24 小时后清理。
4. 需要集中清理时点右下角「清空」，30 秒内可从底部提示撤销。
5. 文本/链接可直接双击/点「复制」进入剪贴板；文件双击打开，右键可定位。

### 默认快捷键

| 动作 | 默认 |
| --- | --- |
| 呼出 / 隐藏 | `Ctrl + Alt + Space` |
| 从剪贴板暂存 | `Ctrl + Shift + D` |
| 搜索 | `/` 或 `Ctrl + F` |
| 全选 | `Ctrl + A` |
| 复制选中 | `Ctrl + C` |
| 复制路径 | `Ctrl + Shift + C` |
| 删除选中 | `Delete` |
| 关闭 / 隐藏 | `Esc` |

> 选择 `Ctrl + Alt + Space` 是因为很多输入法/工具占用了 `Ctrl + Shift + Space`；快捷键可在「设置 → 快捷键」录制修改。

## 数据与隐私

- 数据目录：`%APPDATA%\FlowTray`
- 数据库：`%APPDATA%\FlowTray\flowtray.db`（WAL 模式）
- 文件副本 / 缩略图：`%APPDATA%\FlowTray\storage`
- 日志：`%APPDATA%\FlowTray\logs\main.log`（自动轮转，只记录事件与错误码，路径与内容会脱敏）
- 拖出临时副本：`%APPDATA%\FlowTray\drag-cache`（48 小时后清理）

所有内容留在本机；不会上传文件、剪贴板文本或使用统计。清除数据可在「设置 → 剪贴板与隐私 → 本地数据」完成。

## 目录结构

```
src/
  main/
    index.ts                 # App 生命周期、协议、单实例
    app-controller.ts        # 服务编排、快照、设置、存储迁移、清空
    ipc.ts                   # IPC 入口，Zod 参数校验 + 发送者校验
    window/shelf.ts          # 无边框悬浮窗、贴边、尺寸、显隐
    services/
      items.ts               # 数据模型、拖入、复制、失效、到期、撤销
      clipboard.ts           # 异步剪贴板、文件 FileDrop、敏感应用跳过
      drag.ts                # 原生拖出、硬链接/临时副本、文件夹 junction
      lifecycle.ts           # 到期、校验、回收
      shortcuts.ts           # 全局快捷键与冲突回滚
      tray.ts / autostart.ts / edge-reveal.ts / undo.ts / foreground.ts
    store/db.ts              # node:sqlite schema / migrations
    lib/                     # logger、redact、path、fs 安全工具
  preload/index.ts           # contextBridge 类型化 API
  renderer/src/              # React 悬浮窗、设置、引导、详情
  shared/                    # 类型、设置 schema、IPC 通道、格式化函数
docs/
  screenshots/
tests/
  unit/                      # Vitest
  e2e/                       # Playwright Electron + 原生拖拽模拟
```

## 测试

```powershell
pnpm typecheck
pnpm test              # 34 个单元测试
pnpm build
pnpm test:e2e          # 功能验收：引导、拖入、剪贴板、复制、清空撤销、到期、重启恢复、50 卡
pnpm test:hotkey       # 全局快捷键 + 边缘唤出 + 桌面截图
node tests/e2e/dragout.mjs   # 真实 OS 鼠标拖出到资源管理器（可选，会打开 Explorer）
```

已实测结果（本机 2048×1152 DIP / 125% 缩放 / Windows 11）：

- 单元测试：34 passed
- E2E：全部通过；50 卡加载约 233ms，滚动约 112ms
- 全局快捷键：隐藏 49ms / 呼出 2ms（< 1 秒）
- 边缘唤出：约 519ms（默认 450ms 停留 + 轮询）
- 原生拖出到资源管理器：成功；目标出现 `产品需求.pdf`，源文件仍在，卡片仍在
- 桌面截图：悬浮窗在屏幕右边缘置顶正常显示

详见 [测试计划](docs/04-test-plan.md)。

## 已知限制与设计取舍

- **未签名**：没有代码签名，安装/首次运行会有 SmartScreen 警告；发布前需要证书。
- **管理员边界**：Windows 的 UIPI 会阻止普通权限程序与管理员程序互相拖放。设置里提供「以管理员身份重启」和「管理员自启动」；日常使用建议与目标应用保持同一权限级别。
- **拖出复制语义**：Electron `startDrag` 无法选择目标的放置效果。为保证「复制」不会把原文件移走，默认使用硬链接/临时副本（`safeDragCopy`）；跨磁盘大文件无法硬链接时会退化为原路径并提示。剪切模式才会直接使用源路径。
- **文件夹拖出**：复制拖出用 NTFS junction 暂存；部分目标应用可能把它当快捷方式。对大型文件夹建议拖到资源管理器确认内容，或使用「复制路径」。
- **边缘唤出**：通过光标轮询实现（无原生钩子），可覆盖拖拽到边缘的场景；它不是「检测系统级拖拽」，鼠标悬停同样会触发。
- **剪贴板监听**：默认关闭；开启后每 0.7 秒读取一次本机剪贴板，前台应用命中排除列表时跳过。剪贴板文件通过 `text/uri-list` 写回，已在资源管理器验证可粘贴。
- **应用级拖出目标差异**：微信、QQ、Outlook 等对文件/文件夹/文本的接受方式不同，不能保证每个版本都接受所有类型；「复制到剪贴板」是兜底方案。建议按测试计划逐项做人工回归。
- **代码/资源体积**：Electron 安装包约 110–125MB（Portable 112MB / NSIS 124MB），内存占用高于原生 WinUI；换来的是跨应用拖拽、透明毛玻璃、复杂交互与更快的 UI 迭代。
- **数据目录**：卸载默认保留数据，便于重装恢复；需要彻底清理请使用应用内「重置全部本地数据」。

## 产品文档

- [产品简报](docs/01-product-brief.md)
- [交互规范](docs/02-interaction-spec.md)
- [技术架构与决策](docs/03-architecture.md)
- [测试计划与验收记录](docs/04-test-plan.md)
- [技术选型记录](docs/decisions-tech-stack.md)

## License

MIT（示例项目，未做商标与代码签名）。
