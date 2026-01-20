# Connection Pulse

> Personal, experimental project.
> Shared as-is, without guarantees.
> Not intended for production use or supported deployment.

A lightweight cross-platform desktop application for monitoring TCP connectivity to multiple servers. Built with Tauri, React, and Rust.

**Platforms:** Windows, macOS, Linux

## Features

- **TCP Probing**: Tests connectivity every 5 seconds per target
- **Health Monitoring**: Categorizes targets as Optimal/Great/Good/Warn/Bad/Down based on success rate and latency
- **Rolling Stats**: Average, p90 latency, and success rate over a 5-minute window
- **Drag & Drop Reordering**: Rearrange targets by dragging rows
- **Import/Export**: Save and load target configurations as JSON files
- **Portable Mode**: Place `targets.json` next to the exe for portable storage

## Platform Support

Built with [Tauri](https://tauri.app/), the app uses each platform's native webview for a lightweight footprint (~5MB vs 150MB+ for Electron).

| Platform | Webview | Notes |
|----------|---------|-------|
| Windows | WebView2 | Included in Windows 10/11; older systems auto-prompted to install |
| macOS | WebKit | Built into macOS |
| Linux | WebKitGTK | May require `libwebkit2gtk-4.0` on some distros |
| Android | Android WebView | Requires Android Studio + NDK to build |
| iOS | WKWebView | Requires Xcode + macOS to build |

**Mobile:** The app can be built for Android/iOS with `npm run tauri android build` or `npm run tauri ios build`. The UI includes a responsive mobile layout with card-based design, compact stats grid, and touch-friendly icon buttons.

## Health Categories

| Status  | Success Rate | Avg Latency | p90 Latency |
|---------|--------------|-------------|-------------|
| Optimal | ≥99.5%       | ≤15ms       | ≤30ms       |
| Great   | ≥99%         | ≤30ms       | ≤80ms       |
| Good    | ≥98%         | ≤80ms       | ≤200ms      |
| Warn    | ≥95%         | -           | -           |
| Bad     | ≥70%         | -           | -           |
| Down    | <70%         | -           | -           |

## Build

### Prerequisites

**All platforms:**
- Node.js (LTS recommended)
- Rust (via rustup)

**Windows additional:**
- Visual Studio 2022/2026 with "Desktop development with C++" workload

**Android additional:**
- JDK 21 (e.g., Microsoft OpenJDK)
- Android SDK with: platform-tools, build-tools;35.0.0, platforms;android-35
- Android NDK 27.x
- Rust Android targets: `rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android`

### Desktop Build

```bash
npm install
npm run tauri build
```

**Output locations:**
- Windows: `src-tauri/target/release/connection-pulse.exe`
- macOS: `src-tauri/target/release/bundle/dmg/Connection Pulse.dmg`
- Linux: `src-tauri/target/release/bundle/appimage/connection-pulse.AppImage`

### Android Build

```bash
# First time setup (generates Android project)
npm run tauri android init

# Development (with emulator or device)
npm run tauri android dev

# Release build
npm run tauri android build
```

**Environment variables required:**
```bash
JAVA_HOME=<path-to-jdk-21>
ANDROID_HOME=<path-to-android-sdk>
NDK_HOME=<path-to-ndk>
```

**Output locations:**
- APK: `src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk`
- AAB: `src-tauri/gen/android/app/build/outputs/bundle/universalRelease/app-universal-release.aab`

**Helper scripts (Windows):**
- `build.bat` - Build Windows desktop release with VS environment
- `android-dev.bat` - Run Android dev server with proper environment
- `android-build.bat` - Build Android release (APK/AAB)

## Development

```bash
# Desktop
npm run tauri dev

# Android (requires emulator or device)
npm run tauri android dev
```

## Configuration

Targets are stored in JSON format:

```json
[
  {
    "id": "uuid-here",
    "name": "My Server",
    "host": "example.com",
    "port": 443
  }
]
```

**Storage locations:**
- **Portable**: `targets.json` next to the executable (all platforms)
- **Windows**: `%APPDATA%/com.connection-pulse.app/targets.json`
- **macOS**: `~/Library/Application Support/com.connection-pulse.app/targets.json`
- **Linux**: `~/.config/com.connection-pulse.app/targets.json`
