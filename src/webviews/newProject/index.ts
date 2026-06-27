import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import TOML from "toml";
import { ProjectManager, type Ferrous32Config, type ChipId, CHIP_TARGET_MAP } from "../../core/projectManager";

export class NewProjectPanel {
  public static currentPanel: NewProjectPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  public static createOrShow(
    context: vscode.ExtensionContext,
    projectManager: ProjectManager
  ): void {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

    if (NewProjectPanel.currentPanel) {
      NewProjectPanel.currentPanel.panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "espforge.newProject",
      "ESP Forge: New Project",
      column,
      {
        enableScripts: true,
        localResourceRoots: [context.extensionUri],
        retainContextWhenHidden: true
      }
    );

    NewProjectPanel.currentPanel = new NewProjectPanel(panel, context, projectManager);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly projectManager: ProjectManager
  ) {
    this.panel = panel;

    const htmlPath = path.join(context.extensionPath, "src", "webviews", "newProject", "ui.html");
    try {
      this.panel.webview.html = fs.readFileSync(htmlPath, "utf8");
    } catch {
      this.panel.webview.html = "<h1>New Project</h1><p>UI file not found</p>";
    }

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.panel.webview.onDidReceiveMessage(
      async (msg: NewProjectMessage) => {
        switch (msg.command) {
          case "pick-location":
            await this.pickLocation();
            break;
          case "create-project":
            await this.createProject(msg.data!);
            break;
          case "cancel":
            this.dispose();
            break;
        }
      },
      null,
      this.disposables
    );
  }

  private async pickLocation(): Promise<void> {
    const result = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: "Select Project Location",
      defaultUri: vscode.Uri.file(os.homedir())
    });

    if (result && result.length > 0) {
      this.panel.webview.postMessage({
        command: "location-selected",
        path: result[0]!.fsPath
      });
    }
  }

  private async createProject(data: NewProjectData): Promise<void> {
    const { name, location, chip, template, features } = data;

    if (!name || !location) {
      this.panel.webview.postMessage({ command: "error", message: "Project name and location are required." });
      return;
    }

    const projectPath = path.join(location, name);

    try {
      this.panel.webview.postMessage({ command: "creating", message: "Creating project..." });

      // Create directory
      await fs.promises.mkdir(projectPath, { recursive: true });

      // Copy template files
      const templateDir = path.join(this.context.extensionPath, "templates", template);
      if (fs.existsSync(templateDir)) {
        await this.copyTemplate(templateDir, projectPath, { name, chip, features });
      } else {
        await this.scaffoldProject(projectPath, { name, location, chip, template, features });
      }

      // Write ferrous32.toml
      await this.writeFerrous32Toml(projectPath, name, chip as ChipId, features);

      // Write .vscode/settings.json for rust-analyzer
      await this.writeVscodeSettings(projectPath, chip as ChipId, features);

      this.panel.webview.postMessage({ command: "success", path: projectPath });

      // Open the project
      await vscode.commands.executeCommand(
        "vscode.openFolder",
        vscode.Uri.file(projectPath),
        true
      );

      this.dispose();
    } catch (err) {
      this.panel.webview.postMessage({ command: "error", message: String(err) });
    }
  }

  private async copyTemplate(src: string, dest: string, vars: TemplateVars): Promise<void> {
    const entries = fs.readdirSync(src, { withFileTypes: true });

    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);

      if (entry.isDirectory()) {
        await fs.promises.mkdir(destPath, { recursive: true });
        await this.copyTemplate(srcPath, destPath, vars);
      } else {
        let content = fs.readFileSync(srcPath, "utf8");
        // Replace template variables
        content = content
          .replace(/\{\{project_name\}\}/g, vars.name)
          .replace(/\{\{chip\}\}/g, vars.chip)
          .replace(/\{\{features\}\}/g, vars.features.join(", "));
        await fs.promises.writeFile(destPath, content, "utf8");
      }
    }
  }

  private async scaffoldProject(
    projectPath: string,
    data: NewProjectData
  ): Promise<void> {
    const { name, chip, template, features } = data;
    const target = CHIP_TARGET_MAP[chip as ChipId] ?? "xtensa-esp32s3-espidf";
    const isXtensa = target.includes("xtensa");

    // src/main.rs
    const srcDir = path.join(projectPath, "src");
    await fs.promises.mkdir(srcDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(srcDir, "main.rs"),
      this.getMainRs(template, features),
      "utf8"
    );

    // Cargo.toml
    await fs.promises.writeFile(
      path.join(projectPath, "Cargo.toml"),
      this.getCargoToml(name, chip as ChipId, template, features),
      "utf8"
    );

    // .cargo/config.toml
    const cargoConfigDir = path.join(projectPath, ".cargo");
    await fs.promises.mkdir(cargoConfigDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(cargoConfigDir, "config.toml"),
      this.getCargoConfig(target, isXtensa),
      "utf8"
    );

    // sdkconfig.defaults for IDF projects
    if (template === "esp-idf-std") {
      await fs.promises.writeFile(
        path.join(projectPath, "sdkconfig.defaults"),
        this.getSdkconfig(chip as ChipId, features),
        "utf8"
      );
    }
  }

  private getMainRs(template: string, features: string[]): string {
    const hasWifi = features.includes("wifi");

    switch (template) {
      case "embassy-async":
        return `#![no_std]
#![no_main]

use embassy_executor::Spawner;
use embassy_time::{Duration, Timer};
use esp_hal::{clock::ClockControl, peripherals::Peripherals, system::SystemControl};
use esp_backtrace as _;

#[esp_hal_embassy::main]
async fn main(_spawner: Spawner) {
    let peripherals = Peripherals::take();
    let system = SystemControl::new(peripherals.SYSTEM);
    let _clocks = ClockControl::max(system.clock_control).freeze();

    esp_println::println!("ESP Forge: Embassy async starting...");

    loop {
        esp_println::println!("Tick!");
        Timer::after(Duration::from_millis(1000)).await;
    }
}
`;
      case "bare-metal":
      case "no-std-minimal":
        // Fallback or deprecated options map to embassy
        return this.getMainRs("embassy-async", features);
      default: // esp-idf-std
        return `use esp_idf_svc::sys::EspError;

fn main() -> Result<(), EspError> {
    esp_idf_svc::sys::link_patches();
    esp_idf_svc::log::EspLogger::initialize_default();

    log::info!("ESP Forge: ESP-IDF std project starting...");
${hasWifi ? `
    // WiFi initialization example
    // let nvs = EspDefaultNvsPartition::take()?;
    // let sysloop = EspSystemEventLoop::take()?;
    // let wifi = EspWifi::new(peripherals.modem, sysloop, Some(nvs))?;
` : ""}
    loop {
        log::info!("Running...");
        std::thread::sleep(std::time::Duration::from_millis(1000));
    }
}
`;
    }
  }

  private getCargoToml(
    name: string,
    chip: ChipId,
    template: string,
    features: string[]
  ): string {
    if (template === "embassy-async") {
      return `[package]
name = "${name}"
version = "0.1.0"
edition = "2021"

[dependencies]
embassy-executor = { version = "0.5", features = ["task-arena-size-20480", "arch-xtensa", "executor-thread", "integrated-timers"] }
embassy-time = { version = "0.3", features = ["generic-queue-8"] }
esp-hal = { version = "0.18", features = ["${chip}"] }
esp-hal-embassy = { version = "0.2", features = ["${chip}"] }
esp-backtrace = { version = "0.13", features = ["${chip}", "exception-handler", "panic-handler", "println"] }
esp-println = { version = "0.10", features = ["${chip}", "log"] }

[[bin]]
name = "${name}"
test = false
bench = false
`;
    }

    if (template === "bare-metal" || template === "no-std-minimal") {
      // Fallback or deprecated options map to embassy
      return this.getCargoToml("embassy-async", name, chip, features);
    }


    // esp-idf-std
    const svcFeatures = features.includes("wifi") ? `, features = ["wifi"]` : "";

    return `[package]
name = "${name}"
version = "0.1.0"
edition = "2021"

[dependencies]
esp-idf-svc = { version = "0.48"${svcFeatures} }
log = "0.4"

[build-dependencies]
embuild = "0.31"

[[bin]]
name = "${name}"
test = false
bench = false
`;
  }

  private getCargoConfig(target: string, isXtensa: boolean): string {
    const linker = isXtensa
      ? `\nlinker = "xtensa-esp-elf-gcc"`
      : `\nlinker = "riscv32-esp-elf-gcc"`;

    return `[build]
target = "${target}"

[target.${target}]
rustflags = [
  "-C", "link-arg=-Tlinkall.x",
]${linker}

[env]
# ESP-IDF managed by esp-idf-sys build crate
ESP_IDF_VERSION = "v5.2"
`;
  }

  private getSdkconfig(chip: ChipId, features: string[]): string {
    const lines = [
      "# ESP-IDF SDK configuration",
      `# Generated by ESP Forge for ${chip.toUpperCase()}`,
      ""
    ];

    if (features.includes("wifi")) {
      lines.push("CONFIG_ESP_WIFI_ENABLED=y");
      lines.push("CONFIG_ESP_WIFI_STATIC_RX_BUFFER_NUM=10");
      lines.push("CONFIG_ESP_WIFI_DYNAMIC_RX_BUFFER_NUM=32");
    }

    if (features.includes("bluetooth")) {
      lines.push("CONFIG_BT_ENABLED=y");
      lines.push("CONFIG_BT_BLE_ENABLED=y");
    }

    if (features.includes("nvs")) {
      lines.push("CONFIG_NVS_ENCRYPTION=n");
    }

    lines.push("CONFIG_ESPTOOLPY_FLASHSIZE_4MB=y");
    lines.push("CONFIG_PARTITION_TABLE_SINGLE_APP=y");

    return lines.join("\n") + "\n";
  }

  private async writeFerrous32Toml(
    projectPath: string,
    name: string,
    chip: ChipId,
    features: string[]
  ): Promise<void> {
    const content = `[project]
name = "${name}"
chip = "${chip}"

[build]
profile = "debug"
features = [${features.map(f => `"${f}"`).join(", ")}]
toolchain = "esp"

[flash]
port = "auto"
speed = 921600
before = "default_reset"
after = "hard_reset"
format = "esp-bootloader"

[monitor]
baud = 115200
filters = []
timestamps = true

[idf]
version = "v5.2"
sdkconfig = "sdkconfig.defaults"

[debug]
probe = "auto"
openocd_args = []
`;
    await fs.promises.writeFile(path.join(projectPath, "ferrous32.toml"), content, "utf8");
  }

  private async writeVscodeSettings(
    projectPath: string,
    chip: ChipId,
    features: string[]
  ): Promise<void> {
    const target = CHIP_TARGET_MAP[chip];
    const vscodePath = path.join(projectPath, ".vscode");
    await fs.promises.mkdir(vscodePath, { recursive: true });

    const settings = {
      "rust-analyzer.cargo.target": target,
      "rust-analyzer.cargo.features": features,
      "rust-analyzer.check.allTargets": false,
      "rust-analyzer.check.extraArgs": ["--target", target],
      "rust-analyzer.server.extraEnv": {
        ESP_IDF_VERSION: "v5.2"
      },
      "editor.formatOnSave": true,
      "[rust]": {
        "editor.defaultFormatter": "rust-lang.rust-analyzer"
      }
    };

    await fs.promises.writeFile(
      path.join(vscodePath, "settings.json"),
      JSON.stringify(settings, null, 2),
      "utf8"
    );
  }

  private dispose(): void {
    NewProjectPanel.currentPanel = undefined;
    this.panel.dispose();
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
  }
}

interface NewProjectData {
  name: string;
  location: string;
  chip: string;
  template: string;
  features: string[];
}

interface TemplateVars {
  name: string;
  chip: string;
  features: string[];
}

interface NewProjectMessage {
  command: "pick-location" | "create-project" | "cancel";
  data?: NewProjectData;
}
