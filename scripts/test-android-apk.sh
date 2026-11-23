#!/usr/bin/env bash
set -euo pipefail
apk="$1"
sdk="${ANDROID_HOME:?Android SDK is required}"
tools="$sdk/cmdline-tools/latest/bin"
image='system-images;android-35;google_apis;x86_64'
"$tools/sdkmanager" 'emulator' 'platform-tools' "$image" >/dev/null
echo no | "$tools/avdmanager" create avd --force --name campus-ci --package "$image"
"$sdk/emulator/emulator" -avd campus-ci -no-window -no-audio -no-boot-anim -no-snapshot -gpu swiftshader_indirect >"${RUNNER_TEMP:-/tmp}/campus-emulator.log" 2>&1 &
emulator=$!
trap 'kill "$emulator" 2>/dev/null || true' EXIT
adb="$sdk/platform-tools/adb"
timeout 180 "$adb" wait-for-device
for attempt in $(seq 1 100); do
  if [[ $("$adb" shell getprop sys.boot_completed | tr -d '\r') == 1 ]]; then break; fi
  kill -0 "$emulator"
  sleep 3
done
[[ $("$adb" shell getprop sys.boot_completed | tr -d '\r') == 1 ]]
"$adb" install "$apk"
"$adb" shell am start -W -n edu.dbl.campus/.MainActivity
"$adb" shell pidof edu.dbl.campus
