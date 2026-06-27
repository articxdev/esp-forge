import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import TOML from "toml";
import { ProcessRunner } from "../utils/processRunner";
import { PartitionEditorPanel } from "../webviews/componentBrowser/index";

export interface Ferrous32Config {
  project: {
    name: string;
    chip: ChipId;
  };
  build: {
    profile: "debug" | "release";
    features: string[];
    toolchain: string;
  };
  flash: {
    port: string;
    speed: number;
    before: string;
    after: string;
    format: string;
  };
  monitor: {
    baud: number;
    filters: string[];
    timestamps: boolean;
  };
  idf: {
    version: string;
    sdkconfig: string;
  };
  debug: {
    probe: string;
    openocd_args: string[];
  };
}

export type ChipId =
  | "esp32"
  | "esp32s2"
  | "esp32s3"
  | "esp32c3"
  | "esp32c6"
  | "esp32h2";

export interface EspProject {
  rootPath: string;
  configPath: string;
  config: Ferrous32Config;
  activePort?: string;
}

// Chip to Rust target triple mapping
export const CHIP_TARGET_MAP: Record<ChipId, string> = {
  esp32: "xtensa-esp32-espidf",
  esp32s2: "xtensa-esp32s2-espidf",
  esp32s3: "xtensa-esp32s3-espidf",
  esp32c3: "riscv32imc-esp-espidf",
  esp32c6: "riscv32imac-esp-espidf",
  esp32h2: "riscv32imac-esp-espidf"
};

export const CHIP_DESCRIPTIONS: Record<ChipId, string> = {
  esp32: "Xtensa LX6 dual-core, WiFi + BT Classic",
  esp32s2: "Xtensa LX7 single-core, USB-OTG",
  esp32s3: "Xtensa LX7 dual-core, USB-OTG, AI accelerator",
  esp32c3: "RISC-V single-core, WiFi + BT LE",
  esp32c6: "RISC-V WiFi 6, 802.15.4 Thread/Zigbee",
  esp32h2: "RISC-V 802.15.4, BT LE 5.3"
};

export class ProjectManager {
  private activeProject: EspProject | undefined;
  private readonly runner: ProcessRunner;
  private _onProjectChanged = new vscode.EventEmitter<EspProject | undefined>();
  readonly onProjectChanged = this._onProjectChanged.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel
  ) {
    this.runner = new ProcessRunner(output);
  }

  async detectProject(): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      this.activeProject = undefined;
      return;
    }

    for (const folder of workspaceFolders) {
      const ferrous32Path = path.join(folder.uri.fsPath, "ferrous32.toml");

      if (fs.existsSync(ferrous32Path)) {
        await this.loadProject(folder.uri.fsPath, ferrous32Path);
        return;
      }

      // Try to adopt existing Rust project
      const cargoTomlPath = path.join(folder.uri.fsPath, "Cargo.toml");
      const cargoConfigPath = path.join(folder.uri.fsPath, ".cargo", "config.toml");

      if (fs.existsSync(cargoTomlPath) && fs.existsSync(cargoConfigPath)) {
        const config = fs.readFileSync(cargoConfigPath, "utf8");
        if (config.includes("xtensa-") || config.includes("riscv32")) {
          const adopt = await vscode.window.showInformationMessage(
            "ESP32 Rust project detected. Adopt it with ESP Forge?",
            "Adopt Project",
            "Dismiss"
          );
          if (adopt === "Adopt Project") {
            await this.adoptProject(folder.uri.fsPath, cargoTomlPath, cargoConfigPath);
          }
        }
      }
    }
  }

  private async loadProject(rootPath: string, configPath: string): Promise<void> {
    try {
      const content = fs.readFileSync(configPath, "utf8");
      const config = TOML.parse(content) as Ferrous32Config;

      this.activeProject = {
        rootPath,
        configPath,
        config,
        activePort: config.flash.port !== "auto" ? config.flash.port : undefined
      };

      this.output.appendLine(
        `[ProjectManager] Loaded project: ${config.project.name} (${config.project.chip})`
      );

      await this.updateRustAnalyzerSettings();
      this._onProjectChanged.fire(this.activeProject);

      vscode.commands.executeCommand("setContext", "espforge.projectActive", true);
    } catch (err) {
      this.output.appendLine(`[ProjectManager] Failed to load ferrous32.toml: ${String(err)}`);
    }
  }

  private async adoptProject(
    rootPath: string,
    _cargoTomlPath: string,
    _cargoConfigPath: string
  ): Promise<void> {
    // Read cargo.toml to extract name
    let projectName = path.basename(rootPath);
    try {
      const cargoContent = fs.readFileSync(_cargoTomlPath, "utf8");
      const cargoConfig = TOML.parse(cargoContent) as { package?: { name?: string } };
      projectName = cargoConfig.package?.name ?? projectName;
    } catch { /* ignore */ }

    // Detect chip from .cargo/config.toml
    let chip: ChipId = "esp32s3";
    try {
      const configContent = fs.readFileSync(_cargoConfigPath, "utf8");
      if (configContent.includes("esp32c3")) chip = "esp32c3";
      else if (configContent.includes("esp32c6")) chip = "esp32c6";
      else if (configContent.includes("esp32s2")) chip = "esp32s2";
      else if (configContent.includes("esp32s3")) chip = "esp32s3";
      else if (configContent.includes("esp32h2")) chip = "esp32h2";
      else if (configContent.includes("esp32")) chip = "esp32";
    } catch { /* ignore */ }

    const defaultConfig = this.buildDefaultConfig(projectName, chip);
    const ferrous32Path = path.join(rootPath, "ferrous32.toml");
    await fs.promises.writeFile(ferrous32Path, this.serializeToml(defaultConfig), "utf8");
    await this.loadProject(rootPath, ferrous32Path);
    vscode.window.showInformationMessage(`Project "${projectName}" adopted by ESP Forge!`);
  }

  async reloadProject(): Promise<void> {
    if (!this.activeProject) {
      return;
    }
    await this.loadProject(this.activeProject.rootPath, this.activeProject.configPath);
  }

  getActiveProject(): EspProject | undefined {
    return this.activeProject;
  }

  hasActiveProject(): boolean {
    return this.activeProject !== undefined;
  }

  getTargetTriple(): string {
    const chip = this.activeProject?.config.project.chip ?? "esp32s3";
    return CHIP_TARGET_MAP[chip];
  }

  async setActivePort(port: string): Promise<void> {
    if (!this.activeProject) {
      return;
    }
    this.activeProject.activePort = port;
    this.activeProject.config.flash.port = port;
    await this.saveConfig();
  }

  async toggleProfile(): Promise<void> {
    if (!this.activeProject) {
      return;
    }
    const current = this.activeProject.config.build.profile;
    this.activeProject.config.build.profile = current === "debug" ? "release" : "debug";
    await this.saveConfig();
    vscode.window.showInformationMessage(
      `Build profile switched to ${this.activeProject.config.build.profile.toUpperCase()}`
    );
  }

  async promptSelectChip(): Promise<ChipId | undefined> {
    const items = (Object.keys(CHIP_TARGET_MAP) as ChipId[]).map((chip) => ({
      label: chip.toUpperCase(),
      description: CHIP_DESCRIPTIONS[chip],
      chip
    }));

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: "Select ESP32 chip variant"
    });

    if (!selected || !this.activeProject) {
      return undefined;
    }

    this.activeProject.config.project.chip = selected.chip;
    await this.saveConfig();
    await this.updateRustAnalyzerSettings();
    vscode.window.showInformationMessage(`Chip set to ${selected.chip.toUpperCase()}`);
    return selected.chip;
  }

  async updateRustAnalyzerSettings(): Promise<void> {
    if (!this.activeProject) {
      return;
    }

    const target = this.getTargetTriple();
    const features = this.activeProject.config.build.features;

    // Read env.json for extra env vars
    let extraEnv: Record<string, string> = {};
    try {
      const envPath = path.join(
        require("os").homedir(),
        ".espforge",
        "env.json"
      );
      if (fs.existsSync(envPath)) {
        extraEnv = JSON.parse(fs.readFileSync(envPath, "utf8")) as Record<string, string>;
      }
    } catch { /* ignore */ }

    const settings = {
      "rust-analyzer.cargo.target": target,
      "rust-analyzer.cargo.features": features,
      "rust-analyzer.check.allTargets": false,
      "rust-analyzer.check.extraArgs": ["--target", target],
      "rust-analyzer.server.extraEnv": {
        ESP_IDF_VERSION: this.activeProject.config.idf.version,
        ...(extraEnv["LIBCLANG_PATH"] ? { LIBCLANG_PATH: extraEnv["LIBCLANG_PATH"] } : {}),
        ...(extraEnv["IDF_PATH"] ? { IDF_PATH: extraEnv["IDF_PATH"] } : {})
      }
    };

    const vscodePath = path.join(this.activeProject.rootPath, ".vscode");
    await fs.promises.mkdir(vscodePath, { recursive: true });

    const settingsPath = path.join(vscodePath, "settings.json");
    let existing: Record<string, unknown> = {};

    try {
      const content = fs.readFileSync(settingsPath, "utf8");
      existing = JSON.parse(content) as Record<string, unknown>;
    } catch { /* ignore */ }

    const merged = { ...existing, ...settings };
    await fs.promises.writeFile(settingsPath, JSON.stringify(merged, null, 2), "utf8");
    this.output.appendLine("[ProjectManager] rust-analyzer settings updated.");
  }

  async editPartitions(
    context: vscode.ExtensionContext,
    project: EspProject
  ): Promise<void> {
    PartitionEditorPanel.createOrShow(context, project);
  }

  async profileMemory(
    context: vscode.ExtensionContext,
    project: EspProject
  ): Promise<void> {
    const target = CHIP_TARGET_MAP[project.config.project.chip];
    const profile = project.config.build.profile;
    const mapFile = path.join(
      project.rootPath,
      "target",
      target,
      profile,
      `${project.config.project.name}.map`
    );

    if (!fs.existsSync(mapFile)) {
      const build = await vscode.window.showWarningMessage(
        "No .map file found. Build the project first.",
        "Build Now"
      );
      if (build === "Build Now") {
        vscode.commands.executeCommand("espforge.build");
      }
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "espforge.memoryProfiler",
      "ESP Forge: Memory Profile",
      vscode.ViewColumn.Two,
      { enableScripts: true }
    );

    const sections = await this.parseMapFile(mapFile);
    panel.webview.html = this.buildMemoryProfileHtml(sections, project.config.project.chip);
  }

  private async parseMapFile(mapFile: string): Promise<MemorySection[]> {
    const content = await fs.promises.readFile(mapFile, "utf8");
    const sections: MemorySection[] = [];
    const sectionRegex = /^(\.\w+)\s+0x([0-9a-fA-F]+)\s+0x([0-9a-fA-F]+)/gm;
    let match: RegExpExecArray | null;

    while ((match = sectionRegex.exec(content)) !== null) {
      const name = match[1] ?? "";
      const size = parseInt(match[3] ?? "0", 16);
      if (size > 0 && [".text", ".rodata", ".data", ".bss", ".iram0", ".dram0"].some(s => name.startsWith(s))) {
        sections.push({ name, size });
      }
    }

    return sections;
  }

  private buildMemoryProfileHtml(sections: MemorySection[], chip: ChipId): string {
    const flashTotal = chip === "esp32s3" ? 8 * 1024 * 1024 : 4 * 1024 * 1024;
    const ramTotal = chip === "esp32s3" ? 512 * 1024 : 320 * 1024;

    const flashSections = sections.filter(s => s.name.startsWith(".text") || s.name.startsWith(".rodata"));
    const ramSections = sections.filter(s => s.name.startsWith(".data") || s.name.startsWith(".bss") || s.name.startsWith(".iram"));

    const flashUsed = flashSections.reduce((a, s) => a + s.size, 0);
    const ramUsed = ramSections.reduce((a, s) => a + s.size, 0);

    const flashPct = Math.round((flashUsed / flashTotal) * 100);
    const ramPct = Math.round((ramUsed / ramTotal) * 100);

    const barColor = (pct: number) =>
      pct > 90 ? "#ef4444" : pct > 70 ? "#f59e0b" : "#22c55e";

    const sectionRows = sections
      .map(
        s => `<tr>
          <td>${s.name}</td>
          <td>${(s.size / 1024).toFixed(2)} KB</td>
          <td><div style="background:${barColor(Math.round(s.size / flashTotal * 100))};height:8px;width:${Math.min(100, Math.round(s.size / flashTotal * 100))}%;border-radius:4px"></div></td>
        </tr>`
      )
      .join("\n");

    return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<title>Memory Profile</title>
<style>
  body { font-family: 'Segoe UI', sans-serif; background: #1e1e2e; color: #cdd6f4; padding: 24px; }
  h1 { color: #89b4fa; margin-bottom: 8px; }
  .stat-card { background: #313244; border-radius: 12px; padding: 16px; margin: 12px 0; }
  .stat-label { font-size: 13px; color: #a6adc8; margin-bottom: 8px; }
  .bar-bg { background: #45475a; border-radius: 8px; height: 20px; }
  .bar-fill { border-radius: 8px; height: 20px; transition: width 0.5s; }
  .stat-value { font-size: 22px; font-weight: 700; margin: 4px 0; }
  table { width: 100%; border-collapse: collapse; margin-top: 16px; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #45475a; font-size: 13px; }
  th { color: #89b4fa; }
</style></head><body>
<h1>🔍 Memory Profile</h1>
<div class="stat-card">
  <div class="stat-label">Flash Usage</div>
  <div class="stat-value" style="color:${barColor(flashPct)}">${(flashUsed / 1024).toFixed(1)} KB / ${(flashTotal / 1024).toFixed(0)} KB (${flashPct}%)</div>
  <div class="bar-bg"><div class="bar-fill" style="width:${flashPct}%;background:${barColor(flashPct)}"></div></div>
</div>
<div class="stat-card">
  <div class="stat-label">RAM Usage</div>
  <div class="stat-value" style="color:${barColor(ramPct)}">${(ramUsed / 1024).toFixed(1)} KB / ${(ramTotal / 1024).toFixed(0)} KB (${ramPct}%)</div>
  <div class="bar-bg"><div class="bar-fill" style="width:${ramPct}%;background:${barColor(ramPct)}"></div></div>
</div>
<h2 style="color:#89b4fa;margin-top:24px">Sections</h2>
<table>
  <thead><tr><th>Section</th><th>Size</th><th>Visual</th></tr></thead>
  <tbody>${sectionRows}</tbody>
</table>
</body></html>`;
  }

  async generateCIConfig(project: EspProject): Promise<void> {
    const target = CHIP_TARGET_MAP[project.config.project.chip];
    const ciContent = `name: ESP Forge Build

on:
  push:
    branches: [main, master]
  pull_request:
    branches: [main, master]

jobs:
  build:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        profile: [debug, release]

    steps:
      - uses: actions/checkout@v4

      - name: Install system dependencies
        run: |
          sudo apt-get update
          sudo apt-get install -y libusb-1.0-0-dev libudev-dev gcc

      - name: Install Rust
        uses: dtolnay/rust-toolchain@stable

      - name: Install espup
        run: cargo install espup

      - name: Install ESP Rust toolchain
        run: espup install

      - name: Cache ESP-IDF
        uses: actions/cache@v4
        with:
          path: |
            ~/.rustup/toolchains/esp
            ~/.espressif
          key: \${{ runner.os }}-esp-idf-${project.config.idf.version}

      - name: Cache Cargo registry
        uses: actions/cache@v4
        with:
          path: |
            ~/.cargo/registry
            ~/.cargo/git
            target
          key: \${{ runner.os }}-cargo-\${{ hashFiles('**/Cargo.lock') }}

      - name: Build (\${{ matrix.profile }})
        run: |
          . ~/export-esp.sh
          cargo build --target ${target} \${{ matrix.profile == 'release' && '--release' || '' }}
        env:
          ESP_IDF_VERSION: ${project.config.idf.version}
`;

    const ciDir = path.join(project.rootPath, ".github", "workflows");
    await fs.promises.mkdir(ciDir, { recursive: true });
    const ciPath = path.join(ciDir, "build.yml");
    await fs.promises.writeFile(ciPath, ciContent, "utf8");

    const open = await vscode.window.showInformationMessage(
      "CI configuration generated at .github/workflows/build.yml",
      "Open File"
    );
    if (open === "Open File") {
      const doc = await vscode.workspace.openTextDocument(ciPath);
      await vscode.window.showTextDocument(doc);
    }
  }

  private buildDefaultConfig(name: string, chip: ChipId): Ferrous32Config {
    return {
      project: { name, chip },
      build: { profile: "debug", features: [], toolchain: "esp" },
      flash: { port: "auto", speed: 921600, before: "default_reset", after: "hard_reset", format: "esp-bootloader" },
      monitor: { baud: 115200, filters: [], timestamps: true },
      idf: { version: "v5.2", sdkconfig: "sdkconfig.defaults" },
      debug: { probe: "auto", openocd_args: [] }
    };
  }

  private serializeToml(config: Ferrous32Config): string {
    return `[project]
name = "${config.project.name}"
chip = "${config.project.chip}"

[build]
profile = "${config.build.profile}"
features = [${config.build.features.map(f => `"${f}"`).join(", ")}]
toolchain = "${config.build.toolchain}"

[flash]
port = "${config.flash.port}"
speed = ${config.flash.speed}
before = "${config.flash.before}"
after = "${config.flash.after}"
format = "${config.flash.format}"

[monitor]
baud = ${config.monitor.baud}
filters = [${config.monitor.filters.map(f => `"${f}"`).join(", ")}]
timestamps = ${config.monitor.timestamps}

[idf]
version = "${config.idf.version}"
sdkconfig = "${config.idf.sdkconfig}"

[debug]
probe = "${config.debug.probe}"
openocd_args = [${config.debug.openocd_args.map(a => `"${a}"`).join(", ")}]
`;
  }

  private async saveConfig(): Promise<void> {
    if (!this.activeProject) {
      return;
    }
    const toml = this.serializeToml(this.activeProject.config);
    await fs.promises.writeFile(this.activeProject.configPath, toml, "utf8");
  }
}

interface MemorySection {
  name: string;
  size: number;
}
