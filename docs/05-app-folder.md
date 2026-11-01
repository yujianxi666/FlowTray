## 程序文件夹（交给安装程序打包用）

```
release/FlowTray-0.3.1/
  FlowTray.exe          主程序（Rust + 内嵌前端资源，单文件即可运行）
  FlowTray.portable     便携标记：存在时数据存放在本目录的 data\ 下
  README.txt            给打包/使用者看的说明
```

- **运行期不需要任何随附 DLL**：前端资源、图标、托盘图标都已 `include_bytes!` 内嵌进 exe，MinGW 运行库也是静态链接。已在空目录中单独运行验证过（仅需系统 WebView2 运行时，Windows 10/11 默认自带；缺失时安装 Microsoft Edge WebView2 Evergreen Runtime 即可）。
- **数据位置**：
  - 有 `FlowTray.portable` → `<程序目录>\data`（数据库、暂存文件、缩略图、日志、WebView2 配置都在这里，卸载删目录即干净）；
  - 没有该文件 → `%APPDATA%\FlowTray`。
- **安装程序需要做的事**：把整个文件夹复制到目标目录（例如 `%LOCALAPPDATA%\Programs\FlowTray`）、按需创建快捷方式、按需写 `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\FlowTray` 卸载项；卸载时结束 `FlowTray.exe` 进程后删除目录即可（用户数据也在目录内，可询问是否保留 `data`）。
- 本仓库不再包含安装程序源码；`scripts/relabel-release.ps1` 仍可用于给构建产物提升完整性标签。

