#!/bin/bash
set -u
PROJ="$(cd "$(dirname "$0")/../.." && pwd -W)"
cd "$PROJ" || exit 1
taskkill //IM flowtray.exe //F >/dev/null 2>&1
sleep 1
rm -rf .tmp/runs/e2e1 2>/dev/null
mkdir -p .tmp/runs/e2e1
FLOWTRAY_USER_DATA="$PROJ/.tmp/runs/e2e1" \
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222" \
  ./src-tauri/target/x86_64-pc-windows-gnu/debug/flowtray.exe > .tmp/runs/e2e1/stdout.log 2>&1 &
for i in $(seq 1 40); do
  sleep 0.4
  if curl -s --max-time 2 http://127.0.0.1:9222/json/list | grep -q '"type": "page"'; then
    break
  fi
done
powershell -NoProfile -ExecutionPolicy Bypass -File tests/e2e/acceptance.ps1 -Project "$PROJ" -RunName e2e1
status=$?
echo "=== app log (tail) ==="
tail -6 .tmp/runs/e2e1/logs/main.log 2>/dev/null
exit $status
