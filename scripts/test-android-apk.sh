#!/usr/bin/env bash
set -euo pipefail
apk="$1"
sdk="${ANDROID_HOME:?Android SDK is required}"
tools="$sdk/cmdline-tools/latest/bin"
image='system-images;android-35;google_apis;x86_64'
log="${RUNNER_TEMP:-/tmp}/campus-emulator.log"
"$tools/sdkmanager" 'emulator' 'platform-tools' "$image" >/dev/null
echo no | "$tools/avdmanager" create avd --force --name campus-ci --package "$image"
adb="$sdk/platform-tools/adb"
"$adb" start-server
"$sdk/emulator/emulator" -avd campus-ci -port 5554 -no-window -noaudio -no-boot-anim \
  -no-snapshot -gpu software -camera-back none -camera-front none -memory 2048 \
  -cores 2 -partition-size 2048 -accel on >"$log" 2>&1 &
emulator=$!
finish() {
  result=$?
  if [[ $result != 0 ]]; then
    tail -120 "$log" >&2
    "$adb" devices -l >&2 || true
  fi
  kill "$emulator" 2>/dev/null || true
  return "$result"
}
trap finish EXIT
device=("$adb" -s emulator-5554)
for attempt in $(seq 1 120); do
  kill -0 "$emulator"
  if [[ $("${device[@]}" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r') == 1 ]]; then
    break
  fi
  sleep 3
done
[[ $("${device[@]}" shell getprop sys.boot_completed | tr -d '\r') == 1 ]]
"${device[@]}" install "$apk"
"${device[@]}" shell am start -W -n edu.dbl.campus/.MainActivity
"${device[@]}" shell pidof edu.dbl.campus
