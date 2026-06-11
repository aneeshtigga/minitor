#!/bin/bash
# Minitor — remove the macOS "downloaded app" quarantine so the (unsigned) app
# opens without the Gatekeeper "can't be opened" block.
#
# Usage: double-click this file in Finder after dragging Minitor.app to
# /Applications. It only touches Minitor.app and needs no admin/sudo.

set -e
APP="/Applications/Minitor.app"

if [ ! -d "$APP" ]; then
  echo "Minitor.app not found in /Applications."
  echo "Drag Minitor to your Applications folder first, then run this again."
  read -n 1 -s -r -p "Press any key to close."
  exit 1
fi

echo "Removing quarantine attribute from $APP …"
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true

# Re-assert an ad-hoc signature on the whole bundle (covers the embedded
# sidecar). Harmless if already signed; required on Apple Silicon.
echo "Ad-hoc signing $APP …"
codesign --force --deep --sign - "$APP" 2>/dev/null || true

echo "Done. You can now open Minitor normally."
read -n 1 -s -r -p "Press any key to close."
