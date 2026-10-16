# Shared toolchain paths and defaults for project scripts. Source this file; don't run it.
export LANG="${LANG:-en_US.UTF-8}" # CocoaPods requires UTF-8
# Dev builds reach Metro via localhost (Android uses adb reverse); LAN IPs get blocked by firewalls.
export REACT_NATIVE_PACKAGER_HOSTNAME=localhost
export MAESTRO_CLI_NO_ANALYTICS=1 MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED=true
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home}"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$ANDROID_HOME/cmdline-tools/latest/bin:$HOME/.maestro/bin:/opt/homebrew/bin:$PATH"

# Default targets. Override per command, e.g. IOS_SIMULATOR="iPhone 17" npm run ios
export IOS_SIMULATOR="${IOS_SIMULATOR:-SafeShare iPhone}"
# iOS runtime of that simulator. Empty = newest installed (27.0 with Xcode 27). Older one: IOS_RUNTIME=26.5 npm run ios
# boot.sh (scripts/ios-simulator.js) creates IOS_SIMULATOR on the chosen runtime if it does not exist there yet.
export IOS_RUNTIME="${IOS_RUNTIME:-}"
export ANDROID_AVD="${ANDROID_AVD:-SafeShare_API_36}"
# Dedicated ports so other apps can build in parallel (D20).
export METRO_PORT="${METRO_PORT:-8094}"
export ANDROID_EMULATOR_PORT="${ANDROID_EMULATOR_PORT:-5584}"
