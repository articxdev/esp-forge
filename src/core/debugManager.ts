import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { ProcessRunner } from "../utils/processRunner";
import { CHIP_TARGET_MAP, type EspProject, type ChipId } from "./projectManager";

// USB VID/PIDs for debug probes
const PROBE_IDS = {
  usbJtag: { vid: 0x303a, pid: 0x1001 },   // ESP32-S3/C3/C6 built-in
  espProg: { vid: 0x0403, pid: 0x6010 },    // ESP-Prog (FT2232H)
  jlink: { vid: 0x1366, pid: 0x0101 }       // J-Link
};

const OPENOCD_CONFIGS: Record<ChipId, Record<string, string>> = {
  esp32s3: {
    builtin: "board/esp32s3-builtin.cfg",
    "esp-prog": "board/esp32s3-bridge.cfg",
    ftdi: "board/esp32s3-ftdi.cfg",
    jlink: "board/esp32s3-jlink.cfg"
  },
  esp32c3: {
    builtin: "board/esp32c3-builtin.cfg",
    "esp-prog": "board/esp32c3-bridge.cfg",
    ftdi: "board/esp32c3-ftdi.cfg"
  },
  esp32: {
    "esp-prog": "board/esp32-bridge.cfg",
    ftdi: "board/esp32-ftdi.cfg",
    jlink: "board/esp32-jlink.cfg"
  },
  esp32s2: {
    "esp-prog": "board/esp32s2-bridge.cfg",
    ftdi: "board/esp32s2-ftdi.cfg"
  },
  esp32c6: {
    builtin: "board/esp32c6-builtin.cfg",
    "esp-prog": "board/esp32c6-bridge.cfg"
  },
  esp32h2: {
    builtin: "board/esp32h2-builtin.cfg",
    "esp-prog": "board/esp32h2-bridge.cfg"
  }
};

export class DebugManager {
  private readonly runner: ProcessRunner;
  private openocdProcess: ReturnType<typeof import("child_process").spawn> | undefined;
  private readonly openocdChannel: vscode.OutputChannel;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel
  ) {
    this.runner = new ProcessRunner(output);
    this.openocdChannel = vscode.window.createOutputChannel("ESP Forge: OpenOCD");
    context.subscriptions.push(this.openocdChannel);
  }

  async startDebugSession(project: EspProject): Promise<void> {
    const launchJsonPath = path.join(project.rootPath, ".vscode", "launch.json");

    // Generate launch.json if missing
    if (!fs.existsSync(launchJsonPath)) {
      await this.generateLaunchJson(project, launchJsonPath);
    }

    // Start OpenOCD
    await this.startOpenOCD(project);

    // Start VS Code debug session
    await vscode.debug.startDebugging(
      vscode.workspace.workspaceFolders?.[0],
      "ESP Forge Debug"
    );
  }

  private async generateLaunchJson(project: EspProject, launchJsonPath: string): Promise<void> {
    const chip = project.config.project.chip;
    const target = CHIP_TARGET_MAP[chip];
    const isXtensa = target.includes("xtensa");

    const gdbPath = isXtensa
      ? path.join(os.homedir(), ".rustup", "toolchains", "esp", "bin", `xtensa-esp-elf-gdb${os.platform() === "win32" ? ".exe" : ""}`)
      : "riscv32-esp-elf-gdb";

    const executable = path.join(
      project.rootPath,
      "target",
      target,
      project.config.build.profile,
      project.config.project.name
    );

    const launchJson = {
      version: "0.2.0",
      configurations: [
        {
          name: "ESP Forge Debug",
          type: "gdb",
          request: "attach",
          executable,
          target: "extended-remote :3333",
          remote: true,
          cwd: project.rootPath,
          gdbPath,
          autorun: [
            "monitor reset halt",
            "thb app_main",
            "continue"
          ],
          stopAtEntry: false,
          showDevDebugOutput: "raw"
        }
      ]
    };

    const vscodePath = path.dirname(launchJsonPath);
    await fs.promises.mkdir(vscodePath, { recursive: true });
    await fs.promises.writeFile(
      launchJsonPath,
      JSON.stringify(launchJson, null, 2),
      "utf8"
    );

    this.output.appendLine(`[DebugManager] Generated launch.json at ${launchJsonPath}`);
    vscode.window.showInformationMessage("launch.json generated. Install the 'webfreak.debug' or 'cortex-debug' extension for GDB support.");
  }

  private async startOpenOCD(project: EspProject): Promise<void> {
    const chip = project.config.project.chip;
    const probeType = await this.detectProbeType();
    const configFile = OPENOCD_CONFIGS[chip]?.[probeType] ?? OPENOCD_CONFIGS[chip]?.["esp-prog"];

    if (!configFile) {
      throw new Error(`No OpenOCD configuration found for chip ${chip} with probe ${probeType}`);
    }

    // Extra args from ferrous32.toml
    const extraArgs = project.config.debug.openocd_args;

    const args = ["-f", configFile, ...extraArgs];

    this.openocdChannel.show();
    this.openocdChannel.appendLine(`[OpenOCD] Starting with config: ${configFile}`);
    this.openocdChannel.appendLine(`[OpenOCD] Command: openocd ${args.join(" ")}`);

    // Kill existing OpenOCD if running
    if (this.openocdProcess) {
      this.openocdProcess.kill();
      this.openocdProcess = undefined;
    }

    const { spawn } = require("child_process") as typeof import("child_process");
    const env = { ...process.env };

    this.openocdProcess = spawn("openocd", args, { env, cwd: project.rootPath });

    this.openocdProcess?.stdout?.on("data", (data: Buffer) => {
      this.openocdChannel.append(data.toString());
    });

    this.openocdProcess?.stderr?.on("data", (data: Buffer) => {
      this.openocdChannel.append(data.toString());
    });

    this.openocdProcess?.on("error", (err: Error) => {
      vscode.window.showErrorMessage(
        `OpenOCD failed to start: ${err.message}. Make sure OpenOCD is installed.`
      );
    });

    // Wait a moment for OpenOCD to initialize
    await new Promise((r) => setTimeout(r, 2000));
  }

  private async detectProbeType(): Promise<string> {
    try {
      const usbDetection = require("usb-detection") as {
        find: (vid: number, pid: number, cb: (err: Error | null, devices: unknown[]) => void) => void
      };

      return new Promise((resolve) => {
        // Check for built-in USB-JTAG first (ESP32-S3/C3/C6)
        usbDetection.find(PROBE_IDS.usbJtag.vid, PROBE_IDS.usbJtag.pid, (_err, devices) => {
          if (devices.length > 0) {
            resolve("builtin");
            return;
          }
          // Check for ESP-Prog
          usbDetection.find(PROBE_IDS.espProg.vid, PROBE_IDS.espProg.pid, (_err2, devices2) => {
            if (devices2.length > 0) {
              resolve("esp-prog");
              return;
            }
            // Check for J-Link
            usbDetection.find(PROBE_IDS.jlink.vid, PROBE_IDS.jlink.pid, (_err3, devices3) => {
              resolve(devices3.length > 0 ? "jlink" : "esp-prog");
            });
          });
        });
      });
    } catch {
      return "esp-prog";
    }
  }

  async analyzeCoreDump(project: EspProject, context: vscode.ExtensionContext): Promise<void> {
    const chip = project.config.project.chip;
    const target = CHIP_TARGET_MAP[chip];
    const port = project.activePort ?? project.config.flash.port;

    if (!port || port === "auto") {
      vscode.window.showErrorMessage("Select a port before analyzing core dump.");
      return;
    }

    const executable = path.join(
      project.rootPath,
      "target",
      target,
      project.config.build.profile,
      project.config.project.name
    );

    const coreDumpPath = path.join(os.tmpdir(), "esp32_core_dump.bin");

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "ESP Forge: Reading core dump from flash..."
      },
      async (progress) => {
        progress.report({ message: "Extracting core dump..." });
        await this.runner.runStreaming(
          "espflash",
          ["core-dump", "--port", port, "--output-file", coreDumpPath],
          {},
          (line) => this.output.appendLine(line)
        );

        progress.report({ message: "Analyzing crash..." });
        await this.showCoreDumpAnalysis(context, coreDumpPath, executable, chip);
      }
    );
  }

  private async showCoreDumpAnalysis(
    context: vscode.ExtensionContext,
    coreDumpPath: string,
    executable: string,
    chip: ChipId
  ): Promise<void> {
    const isXtensa = !chip.startsWith("esp32c") && !chip.startsWith("esp32h");
    const gdbBinary = isXtensa
      ? path.join(os.homedir(), ".rustup", "toolchains", "esp", "bin", "xtensa-esp-elf-gdb")
      : "riscv32-esp-elf-gdb";

    let gdbOutput = "";
    try {
      await this.runner.runStreaming(
        gdbBinary,
        [executable, coreDumpPath, "--batch", "-ex", "bt", "-ex", "info registers", "-ex", "quit"],
        {},
        (line) => {
          gdbOutput += line + "\n";
          this.output.appendLine(line);
        }
      );
    } catch {
      gdbOutput = "GDB analysis failed. Make sure the Xtensa GDB toolchain is installed.";
    }

    const panel = vscode.window.createWebviewPanel(
      "espforge.coreDump",
      "ESP Forge: Core Dump Analysis",
      vscode.ViewColumn.Two,
      { enableScripts: true, localResourceRoots: [context.extensionUri] }
    );

    panel.webview.html = this.buildCoreDumpHtml(gdbOutput);
  }

  private buildCoreDumpHtml(gdbOutput: string): string {
    const escaped = gdbOutput
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Core Dump Analysis</title>
  <style>
    body { background: #1e1e2e; color: #cdd6f4; font-family: 'Cascadia Code', 'Fira Code', monospace; padding: 24px; }
    h1 { color: #f38ba8; }
    pre { background: #181825; border-radius: 8px; padding: 16px; overflow-x: auto; font-size: 13px; line-height: 1.6; }
    .frame { color: #cba6f7; }
    .addr { color: #89b4fa; }
    .fn-name { color: #a6e3a1; }
  </style>
</head>
<body>
  <h1>💥 Core Dump Analysis</h1>
  <p style="color:#a6adc8">Stack trace and register state from the crash:</p>
  <pre>${escaped}</pre>
</body>
</html>`;
  }

  dispose(): void {
    this.openocdProcess?.kill();
  }
}
