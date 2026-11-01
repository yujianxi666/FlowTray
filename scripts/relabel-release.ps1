# 把 release 目录里的可执行文件恢复为「中等完整性」（Medium integrity）。
#
# 背景：本工作区目录带有低完整性标签（Low mandatory level），在其中生成的
# exe 会继承该标签。Windows 会用文件的信任标签决定进程的完整性级别，于是
# 从工作区直接运行的程序无法写入 %APPDATA% / %LOCALAPPDATA%，表现为
# 「拒绝访问 (os error 5)」。
#
# 构建完成后执行本脚本（或在 CI 里执行），用户双击即可正常运行。
param(
    [string]$Path = (Join-Path $PSScriptRoot "..\release")
)

$ErrorActionPreference = "Stop"
$targets = Get-ChildItem -Path $Path -Filter *.exe -File -ErrorAction SilentlyContinue
if (-not $targets) {
    Write-Output "没有找到可执行文件: $Path"
    exit 0
}
foreach ($file in $targets) {
    & icacls.exe $file.FullName /setintegritylevel Medium | Out-Null
    Write-Output ("已设为中等完整性: " + $file.Name)
}
