# 技术选型记录：FlowTray

日期：2026-10-30 · 范围：Windows 单机桌面工具 MVP · 预算：$0（本地、无云）
约束：Windows 10/11、跨应用文件拖放、悬浮透明窗、全局快捷键、托盘、本地数据库、无强制登录、无上传。

## 1. 需求驱动的硬约束

| 需求 | 难度 | 对选型的影响 |
| --- | --- | --- |
| 从 Explorer/微信/浏览器拖入文件 | 中 | 需要 Windows OLE/HTML5 DataTransfer 与真实路径获取 |
| 拖出到其他应用（多文件） | 高 | 需要 `IDropSource`/`DoDragDrop` 级别的原生拖拽；网页/普通窗口难以伪造 |
| 透明/毛玻璃、无边框、可贴边 | 中 | 需要窗口合成、透明、置顶、DPI 处理 |
| 全局快捷键、托盘 | 低 | 主流框架都有 |
| 剪贴板文件/图片/HTML | 高 | Windows 剪贴板格式多；Electron 45 API 有破坏性变化 |
| 本地 SQLite、引用路径 | 低 | 任何方案都可 |
| 不装运行时的绿色分发 | 中 | .NET 需要运行时或 self-contained；Electron 体积大但自包含 |

## 2. 候选方案

### 方案 A：Electron 45 + React + TypeScript + SQLite（选用）

**组成**：Electron 45、electron-vite 6、Vite 8、React 19、Zustand、`node:sqlite`、electron-builder。

优点：

- 跨应用拖拽、剪贴板、托盘、全局快捷键、透明窗都有成熟 API；Electron 45 的 `startDrag({files})` 原生支持多文件。
- UI 迭代速度最快，复杂设置/引导/详情页可用 Web 技术精细控制；深色毛玻璃、CSS 动效容易做到高质感。
- **没有原生 Node 插件**：SQLite 用 Electron 内置 `node:sqlite`，避免 `better-sqlite3` 的 ABI/重编译问题，CI 和用户机器都不需要 Visual Studio Build Tools。
- 调试链路成熟（Playwright `_electron` 可控制主进程、截真实桌面），适合一个人同时做产品/设计/QA。

代价：

- 安装包约 90–120MB、空闲内存约 150–250MB；对"轻量工具"是明显代价。
- 透明窗 + DWM/DPI 在 Windows 上需要实际调；系统 acrylic 与透明窗组合会露出矩形底材，本项目最终改为 CSS 半透明。
- 代码签名、自动更新要自己做。
- Electron 45 剪贴板 API 刚换代，旧示例大量失效，需要按当前文档写（本项目已踩坑并修复）。

### 方案 B：Tauri 2 + Rust + React

**组成**：Tauri 2、Rust、WebView2、SQLite（rusqlite/sqlx）。

优点：安装包 5–15MB、内存低；系统 WebView 共享；Rust 侧文件操作可靠。
代价：

- 本机没有 Rust 工具链，首次构建/迭代成本高。
- **多文件拖出到任意 Windows 应用**在 Tauri 中没有 Electron `startDrag` 这样的现成 API，需要手写 Windows `IDropSource`/`IDataObject` 与 OLE 拖放；文件夹 junction、拖拽图标、目标效果反馈都要自己填。
- WebView2 在不同 Windows 版本的透明/毛玻璃/拖放行为差异大；调试需要 Rust + 前端双栈。
- 仍需处理 WebView2 运行时（Win10 可能未预装）。

结论：如果最终目标是"极小体积 + 长期原生"，B 更好；但对 1 人 MVP、且核心难点是跨应用拖拽，B 会把时间花在系统 API 而不是产品上。

### 方案 C：.NET 8 + WPF / WinUI 3 + C#

**组成**：WPF 或 WinUI 3、C#、SQLite、Windows App SDK。

优点：Windows 原生、拖放/剪贴板/托盘/全局热键最顺；内存与体积优于 Electron；系统集成无兼容层。
代价：

- UI 精细度与迭代速度明显慢（XAML 样式、动画、响应式布局）；要复刻本项目的卡片/设置/引导需要更多代码。
- WinUI 3 的透明/ acrylic 与自定义窗口边框仍有坑；WPF 的现代视觉需要大量模板。
- 需要 .NET 运行时（或 self-contained 100MB+），与 Electron 体积差距缩小。
- 本机 .NET 环境/打包链路需要额外验证；单人全栈切换成本高。

结论：如果团队是 C# 背景、且只做 Windows，C 是稳健选择；本项目的设计驱动与快速验证更匹配 A。

## 3. 推荐

**选 A：Electron 45 + React + TS + `node:sqlite`。**

理由排序：

1. 跨应用拖拽是本产品的核心高风险点，Electron 提供唯一"开箱即用"的多文件 `startDrag`。
2. 无原生模块，安装/构建在普通 Windows 机器上可复现；`node:sqlite` 避开 ABI 坑。
3. UI 质感与迭代速度对 MVP 的品牌验证更重要；Electron 的 CSS/React 生态让我们能做出非模板化的界面。
4. 测试可自动化到主进程与真实桌面（Playwright + 原生鼠标模拟），一个人也能守住质量。

**明确接受的代价**：安装体积、内存、签名/更新自建、部分系统集成需要自己补。

## 4. 关键实现决策

| 决策 | 选择 | 备选 | 原因 |
| --- | --- | --- | --- |
| 数据库 | `node:sqlite`（内置） | better-sqlite3 / SQLite WASM | 零原生依赖；WAL 足够 |
| 缩略图 | 图片生成 512px PNG；非图片绘制类型牌 | Windows 原生图标 | 原生图标深浅色不一致、显得"系统拼贴" |
| 拖出复制 | 硬链接/junction 暂存 | 直接拖源路径 | 防止目标应用"移动"原文件 |
| 透明 | CSS 半透明 + backdrop-filter，不使用系统 acrylic | 系统 acrylic | 透明窗 + 系统材质会在卡片外露出半透明/黑色矩形边框；改为 CSS 后无外圈 |
| 打包 | 仅 zh-CN/en-US 语言包 + 最高压缩 | 全语言包 | 安装包 116MB / Portable 104.5MB |
| 边缘唤出 | 光标轮询 | 全局鼠标钩子 | 无需管理员、无安全软件误报 |
| 状态 | 主进程快照 + Zustand | 每组件 IPC | 单窗口，简单一致 |
| 打包 | NSIS + Portable | MSIX | MSIX 签名/证书链复杂；NSIS 可控 |
| 更新 | 暂不做 | electron-updater | MVP 先保可用与数据安全 |

## 5. 需要自己长期维护的东西

- Windows 代码签名证书（EV/OV）与 SmartScreen 信誉。
- 自动更新签名与回滚（electron-updater + 私有/对象存储）。
- Electron 大版本升级（45 的 async clipboard 已经证明升级会有破坏性变化）。
- 第三方应用拖放兼容矩阵（微信/QQ/Outlook/Chrome/Edge/飞书）。
- 崩溃上报与隐私政策（如果未来开启）。
- 多显示器/DPI/管理员权限测试矩阵。

## 6. 未决问题

1. 是否接受 ~100MB 安装包？若不可接受，下一版评估 Tauri + 自写 OLE 拖拽。
2. 是否上架 Microsoft Store？影响打包、签名、更新策略。
3. 是否需要企业分发（MSI/Intune）？当前 NSIS per-user 更适合个人。
4. 微信/QQ 的具体版本拖放兼容性需要真实人工回归；自动化无法覆盖登录态。
5. 文件夹拖出的 junction 语义是否会让用户困惑？需要在真实目标应用中验证后再决定是否改为递归复制。
