#!/bin/bash
set -u
PROJ="$(cd "$(dirname "$0")/../.." && pwd -W)"
cd "$PROJ" || exit 1
taskkill //IM flowtray.exe //F >/dev/null 2>&1
sleep 1
rm -rf .tmp/runs/shots 2>/dev/null
mkdir -p .tmp/runs/shots
FLOWTRAY_USER_DATA="$PROJ/.tmp/runs/shots" \
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222" \
  ./src-tauri/target/x86_64-pc-windows-gnu/debug/flowtray.exe > .tmp/runs/shots/stdout.log 2>&1 &
for i in $(seq 1 40); do sleep 0.4; if curl -s --max-time 2 http://127.0.0.1:9222/json/list | grep -q '"type": "page"'; then break; fi; done
sleep 3
powershell -NoProfile -ExecutionPolicy Bypass -File tests/e2e/screenshots.ps1 -Project "$PROJ"
