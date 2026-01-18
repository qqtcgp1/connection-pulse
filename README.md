# Connection Pulse

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

**Mobile:** The app can be built for Android/iOS with `npm run tauri android build` or `npm run tauri ios build`. The backend works as-is; the UI is currently desktop-optimized and would need adaptation for touch.

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

Requires Node.js and Rust.

```bash
npm install
npm run tauri build
```

**Output locations:**
- Windows: `src-tauri/target/release/connection-pulse.exe`
- macOS: `src-tauri/target/release/bundle/dmg/Connection Pulse.dmg`
- Linux: `src-tauri/target/release/bundle/appimage/connection-pulse.AppImage`

## Development

```bash
npm run tauri dev
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
