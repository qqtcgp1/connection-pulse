# Network Tester - AI Agent Instructions

## Project Overview
A Tauri cross-platform app that performs TCP connectivity tests (tcping) and ICMP ping from the client machine to multiple IP:port targets. Built for trading software network monitoring where reliability and latency matter.

**Note:** ICMP ping is not available on iOS due to platform sandboxing restrictions. The ping option is hidden on iOS.

## Tech Stack
- **Backend**: Rust + Tauri v2
- **Frontend**: React + TypeScript + Vite
- **UI**: Single-page app with dark theme
- **Drag-and-drop**: @dnd-kit (unified solution for desktop and mobile)

## Architecture
Single native process with embedded WebView (not separate backend/frontend processes):
- Rust handles: TCP probes, file I/O, background loop
- React handles: UI rendering, stats calculation, user interactions
- Communication: `invoke()` for UI→Rust, `emit()` events for Rust→UI

## Key Files

### Rust Backend (`src-tauri/`)
- `src/lib.rs` - Main app logic:
  - `tcp_probe()` - TCP connect test with timeout
  - `start_probe_loop()` - Background task probing all targets every 5 seconds (on mobile, only while app is in foreground)
  - Tauri commands: `get_targets`, `set_targets`, `probe_target`
  - Emits `probe:update` events to frontend

### React Frontend (`src/`)
- `App.tsx` - Main component:
  - Target list with health badges
  - Add/Edit/Delete/Refresh buttons
  - Drag-drop JSON import
  - Stats calculation (average, p90, success rate)
  - `computeHealth()` - Determines health category
- `storage.ts` - Load/save targets to AppData as JSON
- `types.ts` - TypeScript interfaces
- `App.css` - Dark theme styles

### Config
- `src-tauri/tauri.conf.json` - Window size, app metadata
- `src-tauri/capabilities/default.json` - Plugin permissions (fs, dialog)

## Health Categories (Trading-Grade Thresholds)

| Badge | Success Rate | Average | p90 |
|-------|-------------|---------|-----|
| OPTIMAL | ≥99.5% | ≤15ms | ≤30ms |
| GREAT | ≥99% | ≤30ms | ≤80ms |
| GOOD | ≥98% | ≤80ms | ≤200ms |
| WARN | ≥95% | — | — |
| BAD | ≥70% | — | — |
| DOWN | <70% | — | — |

Stats are calculated over a 5-minute rolling window.

## Commands

```bash
# Development (desktop)
npm install
npm run tauri dev

# Build release (desktop)
npm run tauri build

# Clean rebuild (if icon or config changes don't apply)
cd src-tauri && cargo clean && cd .. && npm run tauri dev

# Android - first time setup
npm run tauri android init

# Android - development (requires emulator or device)
npm run tauri android dev

# Android - release build
npm run tauri android build

# Linux/WSL - first install dependencies
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libssl-dev libayatana-appindicator3-dev librsvg2-dev

# Linux/WSL - development (from /mnt/c/... path)
npm run tauri dev

# Linux/WSL - build release
npm run tauri build
```

### Windows Helper Scripts

- `build.bat` - Windows desktop build with VS environment
- `android-dev.bat` - Android dev server with proper environment variables
- `android-build.bat` - Android release build (APK/AAB)

### Android Environment Setup

Required environment variables:
```
JAVA_HOME=C:\Program Files\Microsoft\jdk-21.x.x-hotspot
ANDROID_HOME=C:\Users\<user>\AppData\Local\Android\Sdk
NDK_HOME=%ANDROID_HOME%\ndk\27.x.x
```

Required Rust targets:
```bash
rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
```

Required Android SDK components:
- platform-tools
- build-tools;35.0.0
- platforms;android-35
- ndk;27.0.12077973 (or similar 27.x)

## Data Storage

### Storage Modes
1. **Portable Mode**: If `targets.json` exists next to the exe, uses that file
2. **AppData Mode**: Default - saves to `%APPDATA%/com.network-tester.app/targets.json`

Detection logic in `storage.ts`:
- On startup, checks for `targets.json` in exe directory (resourceDir)
- If found → portable mode
- If not found → AppData mode

### Format
`[{ "id": "uuid", "name": "...", "host": "...", "port": 443 }, ...]`

### Behavior
- **Auto-save**: Changes saved immediately on add/edit/delete/import
- **Stats not persisted**: Health stats reset each session (calculated from live probes)

## Import/Export
- Drag-drop `.json` file onto window to import
- Click "Import JSON" for file picker
- Click "Export JSON" to download current targets

## Key Behaviors
1. **Probe loop starts immediately** on app launch
2. **Concurrent probes** - all targets probed in parallel each cycle
3. **Socket closed immediately** after each probe (proper cleanup)
4. **Refresh button** - clears stats for a target (useful when server comes back online)
5. **Auto-clear on edit** - changing host/port clears that target's stats
6. **Drag-to-reorder** - drag rows to reorder targets (works on both desktop and mobile via @dnd-kit)

## Common Modifications

### Change probe interval
In `src-tauri/src/lib.rs`, find:
```rust
let mut ticker = interval(Duration::from_secs(5));
```

### Change health thresholds
In `src/App.tsx`, find `computeHealth()` function.

### Change rolling window duration
In `src/App.tsx`, find:
```typescript
const WINDOW_MS = 5 * 60 * 1000; // 5 minutes
```

### Add new table columns
1. Update `TargetStats` interface in `types.ts`
2. Calculate new stat in `App.tsx` stats mapping
3. Add `<th>` and `<td>` in the table JSX

## Tauri Plugins Used
- `tauri-plugin-fs` - Read/write targets JSON
- `tauri-plugin-dialog` - File picker for import

## Icon
Source: `app-icon-new.png` (network pulse style)
Generated icons in: `src-tauri/icons/`
To regenerate: `npx tauri icon app-icon-new.png`

## Mobile UI

The app has a responsive mobile layout (activated at ≤768px width):
- **Card-based layout**: Table rows become cards on mobile
- **Compact stats**: 2x2 grid with inline label:value (LAST 6ms, AVG 9ms, etc.)
- **Icon buttons**: Refresh (↻), Edit (✎), Delete (✕) instead of text
- **Hidden on mobile**: Import JSON, Export JSON buttons (desktop-only)
- **Card header**: Name + Health badge on same row (no labels)

All mobile styles are in `@media (max-width: 768px)` block in `App.css`.
Desktop layout is unchanged - standard horizontal table with all features.

## Android Build Output

- APK: `src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk`
- AAB: `src-tauri/gen/android/app/build/outputs/bundle/universalRelease/app-universal-release.aab`
