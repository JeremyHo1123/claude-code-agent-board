#!/usr/bin/env bash
# Screenshots of the preview pages with headless Chrome:
#
#   shoot.sh <out-dir> <name> <page-and-query> <height> [<name> <page-and-query> <height> ...]
#
#   shoot.sh ../../docs/images board "index.html?w=380&multi=1" 1200
#   WIDTH=1100 shoot.sh ../../docs/images panel "panel.html" 1500
#
# WIDTH is the window's width (default 500, the least headless Chrome takes: a narrower sidebar
# is the page's own ?w=). CHROME names the browser when it is not where this looks.
# Chrome runs on a profile folder of its own, apart from the person's browser, and exits by itself.
set -u

here=$(cd "$(dirname "$0")" && pwd)
out=$(mkdir -p "$1" && cd "$1" && pwd)
shift

find_chrome() {
  for candidate in "${CHROME:-}" \
    "/c/Program Files/Google/Chrome/Application/chrome.exe" \
    "/c/Program Files (x86)/Google/Chrome/Application/chrome.exe" \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    "$(command -v google-chrome 2>/dev/null)" \
    "$(command -v chromium 2>/dev/null)" \
    "$(command -v chromium-browser 2>/dev/null)"; do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}

chrome=$(find_chrome) || { echo "no Chrome found: set CHROME to its path" >&2; exit 1; }
# Chrome on Windows wants Windows paths; elsewhere these are the paths as they are
native() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }
profile=$(mktemp -d)
width="${WIDTH:-500}"

while [ "$#" -ge 3 ]; do
  name=$1
  page=$2
  height=$3
  shift 3
  "$chrome" --headless=new --disable-gpu --no-first-run \
    --user-data-dir="$(native "$profile")" \
    --window-size="$width,$height" --force-device-scale-factor=2 --hide-scrollbars \
    --virtual-time-budget=3000 \
    --screenshot="$(native "$out")/$name.png" \
    "file:///$(native "$here")/$page" > /dev/null 2>&1
  if [ -f "$out/$name.png" ]; then
    echo "$name.png: $(wc -c < "$out/$name.png") bytes"
  else
    echo "$name.png: MISSING"
  fi
done
rm -rf "$profile"
