# ESP Forge

The ultimate PlatformIO alternative for Rust × ESP32. Build, flash, monitor, and debug ESP32 firmware written in Rust seamlessly within VS Code.

Created by **articxdev**.

## Features

- **1-Click Environment Setup**: Auto-detects and installs all required tools (`espup`, `espflash`, Rust toolchains).
- **Beautiful & Minimal UI**: Stunning, modern, dark-themed UIs for project generation, toolchain management, and component browsing.
- **Smart Project Detection**: Automatically scans your workspace and detects ESP-Rust projects, offering to adopt existing `Cargo.toml` configurations.
- **Simplified Frameworks**: Create new projects using highly optimized templates for:
  - **ESP-IDF (Standard Library)**: Full Rust std support. Best for WiFi, BT, and general applications.
  - **Embassy (Async/No-Std)**: Modern async/await runtime for highly efficient bare-metal execution.
- **Integrated Action Bar**: Dedicated `Build`, `Flash`, and `Monitor` buttons right in the VS Code bottom status bar.
- **Advanced Serial Monitor**: High-performance integrated serial monitor with `defmt` log decoding.

## Getting Started

1. Open VS Code and look for the **ESP Forge** icon in the Activity Bar.
2. If this is your first time, run the **Setup Wizard** to install required dependencies (Git, Python, Rustup).
3. Click **New Project** in the sidebar.
4. Select your chip (e.g. ESP32-S3), your framework (ESP-IDF or Embassy), and optional features (like WiFi).
5. ESP Forge will generate your project.
6. Use the bottom status bar buttons to **Build**, **Flash**, and **Monitor** your device!

## Requirements

- VS Code 1.85.0+
- A supported ESP32 board (ESP32, S2, S3, C3, C6, H2)
- Git & Python (The Setup Wizard will help you if these are missing)

## Credits & License

Created by **[articxdev](https://github.com/articxdev)**.

Licensed under the MIT License. See `LICENSE` for details.
