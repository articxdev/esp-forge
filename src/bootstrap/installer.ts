import * as vscode from "vscode";
import * as os from "os";
import * as path from "path";
import { getPlatformInfo } from "./platformDetect";
import { ProcessRunner } from "../utils/processRunner";
import type { HealthCheck, HealthItem } from "./healthCheck";

export interface InstallProgress {
  step: string;
  percent: number;
  log: string;
}

export class Installer {
  private readonly platform = getPlatformInfo();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
    private readonly healthCheck: HealthCheck,
    private readonly onProgress: (progress: InstallProgress) => void
  ) {}

  async installAll(items: HealthItem[]): Promise<void> {
    const missing = items.filter((i) => i.status === "missing");
    let stepIndex = 0;

    for (const item of missing) {
      stepIndex++;
      const percent = Math.round((stepIndex / missing.length) * 100);
      this.onProgress({ step: `Installing ${item.label}...`, percent, log: "" });
      await this.installItem(item);
    }

    // Write env.json after all installs
    await this.writeEnvironment();
    this.onProgress({ step: "All installations complete!", percent: 100, log: "" });
  }

  async installItem(item: HealthItem): Promise<void> {
    const runner = new ProcessRunner(this.output);

    switch (item.id) {
      case "rustup":
        await this.installRustup(runner);
        break;
      case "espup":
        await this.installEspup(runner);
        break;
      case "espflash":
        await this.installEspflash(runner);
        break;
      case "xtensa-target":
      case "riscv-target":
        await this.installTargets(runner);
        break;
      case "libusb":
        await this.installLibusb(runner);
        break;
      case "xcode-cli":
        await this.installXcodeCLI(runner);
        break;
      case "winusb":
        vscode.env.openExternal(vscode.Uri.parse("https://zadig.akeo.ie"));
        this.log(
          "Opening Zadig in browser. Install the WinUSB driver for your ESP32 device. Then click Refresh in the setup wizard."
        );
        break;
      default:
        this.log(`No automatic installer for ${item.label}. Please install manually.`);
    }
  }

  private async installRustup(runner: ProcessRunner): Promise<void> {
    this.log("Installing Rust via rustup...");

    if (this.platform.isWindows) {
      // Download and run rustup-init.exe
      const tmpPath = path.join(os.tmpdir(), "rustup-init.exe");
      await runner.runStreaming(
        "powershell",
        [
          "-Command",
          `Invoke-WebRequest -Uri 'https://win.rustup.rs/x86_64' -OutFile '${tmpPath}'; Start-Process -FilePath '${tmpPath}' -ArgumentList '-y' -Wait`
        ],
        {},
        (line) => this.log(line)
      );
    } else {
      // Unix: download rustup-init script and run non-interactively
      await runner.runStreaming(
        "sh",
        ["-c", "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y"],
        {},
        (line) => this.log(line)
      );
    }

    this.log("Rust installed successfully.");
  }

  private async installEspup(runner: ProcessRunner): Promise<void> {
    this.log("Installing espup via cargo...");
    await runner.runStreaming(
      "cargo",
      ["install", "espup"],
      {},
      (line) => this.log(line)
    );
    this.log("Running espup install (this downloads the ESP Rust toolchain)...");
    await runner.runStreaming(
      "espup",
      ["install"],
      {},
      (line) => this.log(line)
    );
    this.log("ESP Rust toolchain installed.");
  }

  private async installEspflash(runner: ProcessRunner): Promise<void> {
    this.log("Installing espflash via cargo...");
    await runner.runStreaming(
      "cargo",
      ["install", "espflash"],
      {},
      (line) => this.log(line)
    );
    this.log("espflash installed.");
  }

  private async installTargets(runner: ProcessRunner): Promise<void> {
    this.log("Installing Rust targets for ESP32...");
    const targets = [
      "xtensa-esp32-espidf",
      "xtensa-esp32s2-espidf",
      "xtensa-esp32s3-espidf",
      "riscv32imc-esp-espidf",
      "riscv32imac-esp-espidf"
    ];

    for (const target of targets) {
      this.log(`Adding target: ${target}`);
      try {
        await runner.runStreaming(
          "rustup",
          ["target", "add", target],
          {},
          (line) => this.log(line)
        );
      } catch {
        this.log(`Note: ${target} may require espup toolchain. Skipping standard rustup add.`);
      }
    }
  }

  private async installLibusb(runner: ProcessRunner): Promise<void> {
    const distro = this.platform.linuxDistro ?? "unknown";
    this.log(`Detected Linux distro: ${distro}`);

    if (distro.includes("ubuntu") || distro.includes("debian") || distro.includes("pop")) {
      await runner.runStreaming(
        "sudo",
        ["apt-get", "install", "-y", "libusb-1.0-0-dev", "libudev-dev", "gcc"],
        {},
        (line) => this.log(line)
      );
    } else if (distro.includes("fedora") || distro.includes("rhel") || distro.includes("centos")) {
      await runner.runStreaming(
        "sudo",
        ["dnf", "install", "-y", "libusb1-devel", "systemd-devel", "gcc"],
        {},
        (line) => this.log(line)
      );
    } else if (distro.includes("arch") || distro.includes("manjaro")) {
      await runner.runStreaming(
        "sudo",
        ["pacman", "-S", "--noconfirm", "libusb", "systemd", "gcc"],
        {},
        (line) => this.log(line)
      );
    } else {
      this.log("Unknown distro. Please install libusb-1.0-dev and libudev-dev manually.");
    }
  }

  private async installXcodeCLI(runner: ProcessRunner): Promise<void> {
    this.log("Installing Xcode Command Line Tools...");
    await runner.runStreaming(
      "xcode-select",
      ["--install"],
      {},
      (line) => this.log(line)
    );
  }

  private async writeEnvironment(): Promise<void> {
    const runner = new ProcessRunner(this.output);
    const env: Record<string, string> = {};

    // Resolve cargo home
    try {
      const cargoHome = process.env["CARGO_HOME"] ?? path.join(os.homedir(), ".cargo");
      env["CARGO_HOME"] = cargoHome;
      env["CARGO_BIN"] = path.join(cargoHome, "bin");
    } catch { /* ignore */ }

    // Resolve rustup home
    try {
      env["RUSTUP_HOME"] = process.env["RUSTUP_HOME"] ?? path.join(os.homedir(), ".rustup");
    } catch { /* ignore */ }

    // Resolve espup export file
    const espupExport = path.join(os.homedir(), "export-esp.sh");
    env["ESPUP_EXPORT"] = espupExport;

    // Try to get LIBCLANG_PATH from espup
    try {
      const result = await runner.runSilent("espup", ["--version"]);
      if (result.stdout) {
        // espup sets up LIBCLANG_PATH — look for it in the toolchain dir
        const toolchainBase = path.join(os.homedir(), ".rustup", "toolchains");
        env["LIBCLANG_PATH"] = path.join(toolchainBase, "esp", "lib", "rustlib");
      }
    } catch { /* ignore */ }

    // IDF_PATH from environment if set
    if (process.env["IDF_PATH"]) {
      env["IDF_PATH"] = process.env["IDF_PATH"];
    }

    await this.healthCheck.writeEnvJson(env);
    this.log("Environment configuration saved to ~/.espforge/env.json");
  }

  private log(message: string): void {
    this.output.appendLine(`[Installer] ${message}`);
    this.onProgress({
      step: message,
      percent: -1, // -1 means don't update percentage
      log: message
    });
  }
}
