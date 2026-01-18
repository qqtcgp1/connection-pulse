# Network Tester

A lightweight desktop application for monitoring TCP connectivity to multiple servers. Built with Tauri, React, and Rust.

## Features

- **TCP Probing**: Tests connectivity every 5 seconds per target
- **Health Monitoring**: Categorizes targets as Optimal/Great/Good/Warn/Bad/Down based on success rate and latency
- **Rolling Stats**: Average, p90 latency, and success rate over a 5-minute window
- **Drag & Drop Reordering**: Rearrange targets by dragging rows
- **Import/Export**: Save and load target configurations as JSON files
- **Portable Mode**: Place `targets.json` next to the exe for portable storage

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

The executable will be at `src-tauri/target/release/network-tester.exe`.

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
- **Portable**: `targets.json` next to the executable
- **AppData**: `%APPDATA%/com.network-tester.app/targets.json` (Windows)
