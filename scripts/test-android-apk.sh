#!/usr/bin/env bash
set -euo pipefail
apk="$1"
sdk="${ANDROID_HOME:?Android SDK is required}"
tools="$sdk/cmdline-tools/latest/bin"
image='system-images;android-35;google_apis;x86_64'
log="${RUNNER_TEMP:-/tmp}/campus-emulator.log"
export ANDROID_USER_HOME="${RUNNER_TEMP:-/tmp}/campus-android"
export ANDROID_AVD_HOME="$ANDROID_USER_HOME/avd"
unset ANDROID_SDK_HOME ANDROID_EMULATOR_HOME
mkdir -p "$ANDROID_AVD_HOME"
"$tools/sdkmanager" 'emulator' 'platform-tools' "$image" >/dev/null
echo no | "$tools/avdmanager" create avd --force --name campus-ci --package "$image" \
  --path "$ANDROID_AVD_HOME/campus-ci.avd"
"$sdk/emulator/emulator" -list-avds | grep -Fx campus-ci
adb="$sdk/platform-tools/adb"
"$adb" start-server
"$sdk/emulator/emulator" -avd campus-ci -port 5554 -no-window -noaudio -no-boot-anim \
  -no-snapshot -gpu software -camera-back none -camera-front none -memory 2048 \
  -cores 2 -partition-size 2048 -accel on >"$log" 2>&1 &
emulator=$!
server_pid=""
server_log="${RUNNER_TEMP:-/tmp}/e2e-isolated-server.log"
finish() {
  result=$?
  if [[ $result != 0 ]]; then
    tail -120 "$log" >&2
    "$adb" devices -l >&2 || true
    if [[ -f "${server_log:-}" ]]; then echo "=== e2e-server.log ===" >&2; cat "$server_log" >&2 || true; fi
  fi
  kill "$emulator" 2>/dev/null || true
if   [[ -n "${server_pid:-}" ]]; then
  kill "$server_pid" 2>/dev/null || true
fi
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
initial_pid="$("${device[@]}" shell pidof edu.dbl.campus | tr -d '\r')"
[[ -n "$initial_pid" ]]
"${device[@]}" logcat -c
"${device[@]}" shell am force-stop edu.dbl.campus
sleep 1
stopped_pid="$("${device[@]}" shell pidof edu.dbl.campus 2>/dev/null | tr -d '\r' || true)"
[[ -z "$stopped_pid" ]]
"${device[@]}" shell am start -W -n edu.dbl.campus/.MainActivity
sleep 2
restarted_pid="$("${device[@]}" shell pidof edu.dbl.campus | tr -d '\r')"
[[ -n "$restarted_pid" && "$restarted_pid" != "$initial_pid" ]]
if "${device[@]}" logcat -d | grep -q "FATAL EXCEPTION"; then
  "${device[@]}" logcat -d >&2
  exit 1
fi
if [[ "$apk" == *debug* || "$apk" == *test* ]]; then
  export ANDROID_SERIAL=emulator-5554
  "$adb" uninstall edu.dbl.campus || true
  db_path="${RUNNER_TEMP:-/tmp}/e2e-isolated-campus.sqlite"
  rm -f "$db_path" "${db_path}-wal" "${db_path}-shm"
  PORT=3999 NODE_ENV=development DBL_ALLOW_DEMO=true DBL_FORCE_HTTPS=false \
    DISABLE_HMR=true DBL_DB_PATH="$db_path" \
    DBL_SESSION_SECRET="e2e-isolated-test-session-secret-0123456789abcdef" \
    node --import tsx server.ts >"$server_log" 2>&1 &
  server_pid=$!
  server_ready=0
  health_scheme="http"
  for attempt in $(seq 1 60); do
    if curl -fsS "${health_scheme}://127.0.0.1:3999/api/health" >/dev/null 2>&1; then
      server_ready=1
      break
    fi
    sleep 1
  done
  test "$server_ready" = 1
  "$adb" reverse tcp:3999 tcp:3999
  (cd android && bash gradlew :app:installDebug :app:installDebugAndroidTest)
  run_instrumentation() {
    local test_target="$1"
    echo "Running instrumentation: $test_target"
    local output
    local status=0
    output=$("$adb" shell am instrument -w -e class "$test_target" edu.dbl.campus.test/androidx.test.runner.AndroidJUnitRunner 2>&1) || status=$?
    echo "$output"
    if [[ $status -ne 0 ]] || echo "$output" | grep -qE 'FAILURES!!!|Process crashed' || ! echo "$output" | grep -q 'OK ('; then
      echo "Instrumentation failed for: $test_target" >&2
      return 1
    fi
  }
  run_instrumentation "edu.dbl.campus.SecureSessionStoreTest,com.getcapacitor.myapp.ExampleInstrumentedTest"
  run_instrumentation "edu.dbl.campus.EndToEndSessionTest#step1_loginAndPersistSession"
  "$adb" shell am force-stop edu.dbl.campus
  sleep 1
  test -z "$("$adb" shell pidof edu.dbl.campus 2>/dev/null | tr -d '\r' || true)"
  run_instrumentation "edu.dbl.campus.EndToEndSessionTest#step2_coldRestartRestoresSessionThenLogout"
  "$adb" shell am force-stop edu.dbl.campus
  sleep 1
  test -z "$("$adb" shell pidof edu.dbl.campus 2>/dev/null | tr -d '\r' || true)"
  run_instrumentation "edu.dbl.campus.EndToEndSessionTest#step3_coldRestartAfterLogoutDoesNotRestoreSession"
fi
