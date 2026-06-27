import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as http from "http";
import { ProcessRunner } from "../utils/processRunner";
import { PortScanner } from "../utils/portScanner";
import { CHIP_TARGET_MAP, type EspProject } from "./projectManager";

// Known ESP32 USB VID/PID pairs
const ESP32_USB_DEVICES: Array<{ vid: number; pid: number; name: string }> = [
  { vid: 0x303a, pid: 0x1001, name: "ESP32-S3/C3/C6 USB-JTAG" },
  { vid: 0x303a, pid: 0x0002, name: "ESP32-S2 USB CDC" },
  { vid: 0x303a, pid: 0x4001, name: "ESP32-C3 USB CDC" },
  { vid: 0x1a86, pid: 0x7523, name: "CH340G (ESP32)" },
  { vid: 0x1a86, pid: 0x55d4, name: "CH9102F (ESP32)" },
  { vid: 0x10c4, pid: 0xea60, name: "CP2102 (ESP32)" },
  { vid: 0x10c4, pid: 0xea70, name: "CP2104 (ESP32)" },
  { vid: 0x0403, pid: 0x6001, name: "FT232R (ESP-Prog)" },
  { vid: 0x0403, pid: 0x6010, name: "FT2232H (ESP-Prog)" }
];

export interface FlashProgress {
  percent: number;
  message: string;
}

export interface DetectedDevice {
  name: string;
  port: string;
  vid: number;
  pid: number;
}

export class FlashManager {
  private readonly runner: ProcessRunner;
  private readonly portScanner: PortScanner;
  private _activePort: string | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel
  ) {
    this.runner = new ProcessRunner(output);
    this.portScanner = new PortScanner(output);
  }

  async flash(project: EspProject): Promise<void> {
    const port = await this.resolvePort(project);
    if (!port) {
      return;
    }

    const target = CHIP_TARGET_MAP[project.config.project.chip];
    const args = [
      "espflash",
      "flash",
      "--target",
      target,
      "--port",
      port,
      "--speed",
      String(project.config.flash.speed),
      "--before",
      project.config.flash.before,
      "--after",
      project.config.flash.after
    ];

    if (project.config.build.profile === "release") {
      args.push("--release");
    }

    const env = await this.buildEnv();

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `ESP Forge: Flashing ${project.config.project.name}...`,
        cancellable: true
      },
      async (progress, token) => {
        await this.runner.runStreaming(
          "cargo",
          args,
          { cwd: project.rootPath, env },
          (line) => {
            // Parse espflash progress lines like "[=======>   ] 45%"
            const pctMatch = /(\d+)%/.exec(line);
            if (pctMatch) {
              const pct = parseInt(pctMatch[1] ?? "0", 10);
              progress.report({ message: `${pct}% complete`, increment: 0 });
            }
            this.output.appendLine(line);
            this.checkFlashError(line);
          },
          token
        );
      }
    );

    const config = vscode.workspace.getConfiguration("espforge");
    if (config.get<boolean>("autoOpenMonitorAfterFlash", false)) {
      vscode.commands.executeCommand("espforge.monitor");
    }
  }

  async eraseFlash(project: EspProject): Promise<void> {
    const port = await this.resolvePort(project);
    if (!port) {
      return;
    }

    const env = await this.buildEnv();
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "ESP Forge: Erasing flash..."
      },
      async () => {
        await this.runner.runStreaming(
          "espflash",
          ["erase-flash", "--port", port],
          { env },
          (line) => this.output.appendLine(line)
        );
      }
    );
    vscode.window.showInformationMessage("Flash erased successfully.");
  }

  async flashOTA(project: EspProject): Promise<void> {
    // Build release binary first
    await vscode.commands.executeCommand("espforge.build");

    // Get device IP
    const ip = await vscode.window.showInputBox({
      prompt: "Enter device IP address for OTA update",
      placeHolder: "192.168.1.100",
      validateInput: (v) => {
        const ipRegex = /^(\d{1,3}\.){3}\d{1,3}$/;
        return ipRegex.test(v) ? null : "Enter a valid IP address";
      }
    });

    if (!ip) {
      return;
    }

    const target = CHIP_TARGET_MAP[project.config.project.chip];
    const binaryPath = path.join(
      project.rootPath,
      "target",
      target,
      "release",
      project.config.project.name
    );

    if (!fs.existsSync(binaryPath)) {
      vscode.window.showErrorMessage(
        `Binary not found at ${binaryPath}. Please build in release mode first.`
      );
      return;
    }

    const firmware = await fs.promises.readFile(binaryPath);

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `ESP Forge: OTA flashing to ${ip}...`,
        cancellable: false
      },
      async (progress) => {
        await this.sendOtaUpdate(ip, firmware, progress);
      }
    );
  }

  private async sendOtaUpdate(
    ip: string,
    firmware: Buffer,
    progress: vscode.Progress<{ message?: string; increment?: number }>
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const options: http.RequestOptions = {
        hostname: ip,
        port: 80,
        path: "/ota/update",
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": firmware.length
        }
      };

      const req = http.request(options, (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => {
          body += chunk.toString();
          progress.report({ message: `Response: ${body.slice(-50)}` });
        });
        res.on("end", () => {
          if (res.statusCode === 200) {
            vscode.window.showInformationMessage("OTA update complete! Device is rebooting.");
            resolve();
          } else {
            reject(new Error(`OTA failed with status ${res.statusCode}: ${body}`));
          }
        });
      });

      req.on("error", (err) => reject(err));

      // Stream firmware with progress
      let sent = 0;
      const chunkSize = 4096;

      function sendChunk() {
        if (sent >= firmware.length) {
          req.end();
          return;
        }
        const chunk = firmware.slice(sent, sent + chunkSize);
        req.write(chunk);
        sent += chunk.length;
        const pct = Math.round((sent / firmware.length) * 100);
        progress.report({ message: `Uploading firmware: ${pct}%` });
        setImmediate(sendChunk);
      }

      sendChunk();
    });
  }

  async selectPort(): Promise<string | undefined> {
    const ports = await this.portScanner.scan();

    if (ports.length === 0) {
      const action = await vscode.window.showWarningMessage(
        "No serial ports found. Make sure your ESP32 is connected.",
        "Scan Again",
        "Enter Manually"
      );

      if (action === "Scan Again") {
        return this.selectPort();
      } else if (action === "Enter Manually") {
        return vscode.window.showInputBox({
          prompt: "Enter port manually",
          placeHolder: process.platform === "win32" ? "COM3" : "/dev/ttyUSB0"
        });
      }
      return undefined;
    }

    const items = ports.map((p) => ({
      label: p.path,
      description: p.manufacturer ?? "",
      detail: p.vendorId ? `VID: ${p.vendorId} PID: ${p.productId}` : ""
    }));

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: "Select serial port"
    });

    return selected?.label;
  }

  async setActivePort(port: string): Promise<void> {
    this._activePort = port;
  }

  getActivePort(): string | undefined {
    return this._activePort;
  }

  async checkNewUsbDevice(vid: number, pid: number): Promise<DetectedDevice | undefined> {
    const match = ESP32_USB_DEVICES.find((d) => d.vid === vid && d.pid === pid);
    if (!match) {
      return undefined;
    }

    // Wait for device to enumerate
    await new Promise((r) => setTimeout(r, 1000));
    const ports = await this.portScanner.scan();
    const espPort = ports.find((p) => {
      const portVid = parseInt(p.vendorId ?? "0", 16);
      const portPid = parseInt(p.productId ?? "0", 16);
      return portVid === vid && portPid === pid;
    });

    if (!espPort) {
      return undefined;
    }

    return { name: match.name, port: espPort.path, vid, pid };
  }

  async showDeviceInfo(output: vscode.OutputChannel): Promise<void> {
    const port = this._activePort;
    if (!port) {
      vscode.window.showWarningMessage("No active port selected. Use ESPForge: Select Port first.");
      return;
    }

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "ESP Forge: Reading device info..."
      },
      async () => {
        await this.runner.runStreaming(
          "espflash",
          ["board-info", "--port", port],
          {},
          (line) => output.appendLine(line)
        );
      }
    );
    output.show();
  }

  private async resolvePort(project: EspProject): Promise<string | undefined> {
    if (project.activePort) {
      return project.activePort;
    }

    if (this._activePort) {
      return this._activePort;
    }

    if (project.config.flash.port !== "auto") {
      return project.config.flash.port;
    }

    // Auto-detect
    const ports = await this.portScanner.scan();
    const espPorts = ports.filter((p) => {
      const vid = parseInt(p.vendorId ?? "0", 16);
      return ESP32_USB_DEVICES.some((d) => d.vid === vid);
    });

    if (espPorts.length === 1) {
      this._activePort = espPorts[0]!.path;
      return this._activePort;
    }

    if (espPorts.length > 1) {
      return this.selectPort();
    }

    // No ESP32 found, show all ports
    return this.selectPort();
  }

  private checkFlashError(line: string): void {
    if (line.includes("Failed to open serial port")) {
      vscode.window.showErrorMessage(
        "espflash: Failed to open serial port. Check that the device is connected and the port is correct.",
        "Select Port"
      ).then((action) => {
        if (action === "Select Port") {
          vscode.commands.executeCommand("espforge.selectPort");
        }
      });
    } else if (line.includes("Chip not supported")) {
      vscode.window.showErrorMessage(
        "espflash: This chip is not supported by the current espflash version. Update espflash.",
        "Select Chip"
      ).then((action) => {
        if (action === "Select Chip") {
          vscode.commands.executeCommand("espforge.selectChip");
        }
      });
    } else if (line.includes("Flashing failed: timeout")) {
      vscode.window.showErrorMessage(
        "espflash: Flashing timed out. Try reducing flash speed in ferrous32.toml (current: flash.speed).",
        "Open Config"
      ).then((action) => {
        if (action === "Open Config") {
          const project = this.context.workspaceState.get<string>("activeProjectPath");
          if (project) {
            vscode.workspace.openTextDocument(path.join(project, "ferrous32.toml")).then(
              (doc) => vscode.window.showTextDocument(doc)
            );
          }
        }
      });
    }
  }

  private async buildEnv(): Promise<Record<string, string>> {
    const env: Record<string, string> = {};
    Object.entries(process.env).forEach(([k, v]) => {
      if (v !== undefined) env[k] = v;
    });

    try {
      const envPath = path.join(os.homedir(), ".espforge", "env.json");
      if (fs.existsSync(envPath)) {
        const stored = JSON.parse(fs.readFileSync(envPath, "utf8")) as Record<string, string>;
        Object.assign(env, stored);
      }
    } catch { /* ignore */ }

    return env;
  }
}
