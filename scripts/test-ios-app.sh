#!/usr/bin/env bash
set -euo pipefail
app="$1"
device=$(xcrun simctl list devices available --json | python3 -c '
import json,sys
devices=json.load(sys.stdin)["devices"]
print(next(item["udid"] for group,values in sorted(devices.items(), reverse=True) if "iOS-" in group
           for item in values if item["name"].startswith("iPhone")))
')
xcrun simctl boot "$device" 2>/dev/null || xcrun simctl list devices booted | grep -F "$device"
xcrun simctl bootstatus "$device" -b
xcrun simctl install "$device" "$app"
xcrun simctl launch "$device" edu.dbl.campus
