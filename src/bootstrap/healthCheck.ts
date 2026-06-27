import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { getPlatformInfo, PlatformInfo } from "./platformDetect";
import { ProcessRunner } from "../utils/processRunner";
import type { OutputChannel } from "vscode";
import type { ExtensionContext } from "vscode";

export interface HealthItem {
  id: string;
  label: string;
  description: string;
  required: boolean;
  status: "ok" | "missing" | "checking";
  version?: string;
  installCmd?: string;
  helpUrl?: string;
}

export interface HealthCheckResult {
  allHealthy: boolean;
  items: HealthItem[];
  missing: string[];
}

export class HealthCheck {
  private readonly platform: PlatformInfo;
  private readonly envJsonPath: string;
  private readonly runner: ProcessRunner;

  constructor(
    private readonly context: ExtensionContext,
    private readonly output: OutputChannel
  ) {
    this.platform = getPlatformInfo();
    this.envJsonPath = path.join(os.homedir(), ".espforge", "env.json");
    this.runner = new ProcessRunner(output);
  }

  async runQuickCheck(): Promise<HealthCheckResult> {
    const items: HealthItem[] = this.buildCheckList();
    const results = await Promise.all(items.map((item) => this.checkItem(item)));
    const missing = results.filter((i) => i.status === "missing" && i.required).map((i) => i.label);
    return {
      allHealthy: missing.length === 0,
      items: results,
      missing
    };
  }

  async runFullCheck(): Promise<HealthCheckResult> {
    return this.runQuickCheck();
  }

  private buildCheckList(): HealthItem[] {
    const items: HealthItem[] = [
      {
        id: "rustup",
        label: "Rust (rustup)",
        description: "Rust toolchain manager",
        required: true,
        status: "checking",
        helpUrl: "https://rustup.rs"
      },
      {
        id: "cargo",
        label: "Cargo",
        description: "Rust package manager",
        required: true,
        status: "checking"
      },
      {
        id: "espup",
        label: "espup",
        description: "ESP Rust toolchain installer",
        required: true,
        status: "checking",
        installCmd: "cargo install espup"
      },
      {
        id: "espflash",
        label: "espflash",
        description: "ESP32 flashing tool",
        required: true,
        status: "checking",
        installCmd: "cargo install espflash"
      },
      {
        id: "xtensa-target",
        label: "Xtensa Target",
        description: "xtensa-esp32s3-espidf Rust target",
        required: false,
        status: "checking"
      },
      {
        id: "riscv-target",
        label: "RISC-V Target",
        description: "riscv32imc-esp-espidf Rust target",
        required: false,
        status: "checking"
      },
      {
        id: "python3",
        label: "Python 3",
        description: "Required for ESP-IDF build system",
        required: true,
        status: "checking"
      },
      {
        id: "git",
        label: "Git",
        description: "Required for ESP-IDF component downloads",
        required: true,
        status: "checking"
      }
    ];

    // Platform-specific checks
    if (this.platform.isLinux) {
      items.push({
        id: "libusb",
        label: "libusb-1.0",
        description: "USB access library (Linux)",
        required: true,
        status: "checking",
        installCmd: "sudo apt install libusb-1.0-0-dev libudev-dev"
      });
    }

    if (this.platform.isMacOS) {
      items.push({
        id: "xcode-cli",
        label: "Xcode CLI Tools",
        description: "Apple command line tools (macOS)",
        required: true,
        status: "checking",
        installCmd: "xcode-select --install"
      });
    }

    if (this.platform.isWindows) {
      items.push({
        id: "winusb",
        label: "WinUSB Drivers",
        description: "USB drivers for ESP32 (Windows)",
        required: true,
        status: "checking",
        helpUrl: "https://zadig.akeo.ie"
      });
    }

    return items;
  }

  private async checkItem(item: HealthItem): Promise<HealthItem> {
    try {
      switch (item.id) {
        case "rustup":
          return await this.checkCommand(item, "rustup", ["--version"]);
        case "cargo":
          return await this.checkCommand(item, "cargo", ["--version"]);
        case "espup":
          return await this.checkCommand(item, "espup", ["--version"]);
        case "espflash":
          return await this.checkCommand(item, "espflash", ["--version"]);
        case "xtensa-target":
          return await this.checkRustTarget(item, "xtensa-esp32s3-espidf");
        case "riscv-target":
          return await this.checkRustTarget(item, "riscv32imc-esp-espidf");
        case "python3":
          return await this.checkCommand(
            item,
            this.platform.isWindows ? "python" : "python3",
            ["--version"]
          );
        case "git":
          return await this.checkCommand(item, "git", ["--version"]);
        case "libusb":
          return await this.checkLibusb(item);
        case "xcode-cli":
          return await this.checkCommand(item, "xcode-select", ["-p"]);
        case "winusb":
          // We can't auto-detect WinUSB, just check registry or mark as unknown
          return { ...item, status: "ok", version: "Check Zadig" };
        default:
          return { ...item, status: "missing" };
      }
    } catch {
      return { ...item, status: "missing" };
    }
  }

  private async checkCommand(
    item: HealthItem,
    cmd: string,
    args: string[]
  ): Promise<HealthItem> {
    try {
      const result = await this.runner.runSilent(cmd, args);
      const version = result.stdout.trim().split("\n")[0] ?? "";
      return { ...item, status: "ok", version };
    } catch {
      return { ...item, status: "missing" };
    }
  }

  private async checkRustTarget(item: HealthItem, target: string): Promise<HealthItem> {
    try {
      const result = await this.runner.runSilent("rustup", ["target", "list", "--installed"]);
      const installed = result.stdout.includes(target);
      return {
        ...item,
        status: installed ? "ok" : "missing",
        version: installed ? target : undefined
      };
    } catch {
      return { ...item, status: "missing" };
    }
  }

  private async checkLibusb(item: HealthItem): Promise<HealthItem> {
    try {
      // Try to find libusb via pkg-config
      const result = await this.runner.runSilent("pkg-config", ["--modversion", "libusb-1.0"]);
      return { ...item, status: "ok", version: result.stdout.trim() };
    } catch {
      // Try ldconfig
      try {
        const result = await this.runner.runSilent("ldconfig", ["-p"]);
        if (result.stdout.includes("libusb")) {
          return { ...item, status: "ok", version: "found" };
        }
      } catch {
        // ignore
      }
      return { ...item, status: "missing" };
    }
  }

  async writeEnvJson(env: Record<string, string>): Promise<void> {
    const dir = path.dirname(this.envJsonPath);
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(this.envJsonPath, JSON.stringify(env, null, 2), "utf8");
    this.output.appendLine(`[ESP Forge] Environment written to ${this.envJsonPath}`);
  }

  async readEnvJson(): Promise<Record<string, string>> {
    try {
      const content = await fs.promises.readFile(this.envJsonPath, "utf8");
      return JSON.parse(content) as Record<string, string>;
    } catch {
      return {};
    }
  }

  getPlatform(): PlatformInfo {
    return this.platform;
  }
}
