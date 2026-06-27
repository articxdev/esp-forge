import * as vscode from "vscode";
import * as path from "path";
import * as os from "os";
import { ProcessRunner } from "../utils/processRunner";

export interface ToolInfo {
  name: string;
  command: string;
  version?: string;
  installed: boolean;
  updateAvailable?: boolean;
  latestVersion?: string;
}

export class ToolchainManager {
  private readonly runner: ProcessRunner;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel
  ) {
    this.runner = new ProcessRunner(output);
  }

  async getToolInfo(): Promise<ToolInfo[]> {
    const tools: ToolInfo[] = [];

    // espup
    const espupInfo = await this.getToolVersion("espup", ["--version"]);
    tools.push({ name: "espup", command: "espup", ...espupInfo });

    // espflash
    const espflashInfo = await this.getToolVersion("espflash", ["--version"]);
    tools.push({ name: "espflash", command: "espflash", ...espflashInfo });

    // cargo
    const cargoInfo = await this.getToolVersion("cargo", ["--version"]);
    tools.push({ name: "Cargo", command: "cargo", ...cargoInfo });

    // rustup
    const rustupInfo = await this.getToolVersion("rustup", ["--version"]);
    tools.push({ name: "rustup", command: "rustup", ...rustupInfo });

    return tools;
  }

  async getInstalledTargets(): Promise<string[]> {
    try {
      const result = await this.runner.runSilent("rustup", ["target", "list", "--installed"]);
      return result.stdout
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.includes("esp") || l.includes("xtensa") || l.includes("riscv32"));
    } catch {
      return [];
    }
  }

  async runEspupUpdate(): Promise<void> {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "ESP Forge: Updating ESP toolchain..." },
      async (progress) => {
        progress.report({ message: "Running espup update..." });
        await this.runner.runStreaming(
          "espup",
          ["update"],
          {},
          (line) => {
            this.output.appendLine(line);
            progress.report({ message: line.slice(0, 60) });
          }
        );
      }
    );
    vscode.window.showInformationMessage("ESP toolchain updated successfully.");
  }

  async repairInstallation(): Promise<void> {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "ESP Forge: Repairing ESP toolchain..." },
      async (progress) => {
        progress.report({ message: "Running espup install..." });
        await this.runner.runStreaming(
          "espup",
          ["install"],
          {},
          (line) => {
            this.output.appendLine(line);
            progress.report({ message: line.slice(0, 60) });
          }
        );
      }
    );
    vscode.window.showInformationMessage("ESP toolchain repaired.");
  }

  async showManagementPanel(context: vscode.ExtensionContext): Promise<void> {
    const panel = vscode.window.createWebviewPanel(
      "espforge.toolchain",
      "ESP Forge: Toolchain Manager",
      vscode.ViewColumn.One,
      { enableScripts: true, localResourceRoots: [context.extensionUri] }
    );

    const tools = await this.getToolInfo();
    const targets = await this.getInstalledTargets();

    panel.webview.html = this.buildManagementHtml(tools, targets);

    panel.webview.onDidReceiveMessage(async (msg: { command: string; tool?: string }) => {
      switch (msg.command) {
        case "update-espup":
          await this.runEspupUpdate();
          break;
        case "repair":
          await this.repairInstallation();
          break;
        case "install-tool":
          if (msg.tool) {
            await this.runner.runStreaming(
              "cargo",
              ["install", msg.tool],
              {},
              (line) => this.output.appendLine(line)
            );
            vscode.window.showInformationMessage(`${msg.tool} installed.`);
          }
          break;
      }
    });
  }

  private async getToolVersion(
    cmd: string,
    args: string[]
  ): Promise<{ installed: boolean; version?: string }> {
    try {
      const result = await this.runner.runSilent(cmd, args);
      return { installed: true, version: result.stdout.trim().split("\n")[0] };
    } catch {
      return { installed: false };
    }
  }

  private buildManagementHtml(tools: ToolInfo[], targets: string[]): string {
    const toolRows = tools
      .map(
        (t) => `
        <div class="tool-row">
          <div class="tool-name">${t.name}</div>
          <div class="tool-version ${t.installed ? "ok" : "missing"}">
            ${t.installed ? t.version ?? "installed" : "⚠ Not installed"}
          </div>
          ${t.installed ? `<button class="btn btn-sm" onclick="updateTool('${t.command}')">Update</button>` : `<button class="btn btn-sm btn-primary" onclick="installTool('${t.command}')">Install</button>`}
        </div>`
      )
      .join("\n");

    const targetList = targets
      .map((t) => `<div class="target-chip">${t}</div>`)
      .join("\n");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Toolchain Manager</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #1e1e2e; color: #cdd6f4; font-family: 'Segoe UI', sans-serif; padding: 24px; }
    h1 { color: #89b4fa; font-size: 22px; margin-bottom: 24px; display: flex; align-items: center; gap: 8px; }
    h2 { color: #cba6f7; font-size: 16px; margin: 24px 0 12px; }
    .tool-row { display: flex; align-items: center; gap: 16px; padding: 12px 16px; background: #313244; border-radius: 8px; margin-bottom: 8px; }
    .tool-name { font-weight: 600; width: 120px; }
    .tool-version { font-family: monospace; font-size: 13px; flex: 1; }
    .tool-version.ok { color: #a6e3a1; }
    .tool-version.missing { color: #f38ba8; }
    .target-chip { display: inline-block; background: #45475a; border-radius: 6px; padding: 4px 10px; margin: 4px; font-family: monospace; font-size: 12px; color: #89b4fa; }
    .btn { padding: 6px 14px; border: none; border-radius: 6px; cursor: pointer; font-size: 13px; background: #585b70; color: #cdd6f4; transition: background 0.2s; }
    .btn:hover { background: #6c7086; }
    .btn-primary { background: #89b4fa; color: #1e1e2e; }
    .btn-primary:hover { background: #74c7ec; }
    .action-bar { display: flex; gap: 12px; margin-top: 24px; }
    .btn-large { padding: 10px 20px; font-size: 14px; }
  </style>
</head>
<body>
  <h1>🔧 ESP Toolchain Manager</h1>

  <h2>Installed Tools</h2>
  ${toolRows}

  <h2>ESP Rust Targets</h2>
  <div>${targetList || '<p style="color:#6c7086;font-size:13px">No ESP targets installed. Run espup install.</p>'}</div>

  <div class="action-bar">
    <button class="btn btn-large btn-primary" onclick="updateEspup()">⬆ Update ESP Toolchain</button>
    <button class="btn btn-large" onclick="repair()">🔁 Repair Installation</button>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    function updateEspup() { vscode.postMessage({ command: 'update-espup' }); }
    function repair() { vscode.postMessage({ command: 'repair' }); }
    function updateTool(tool) { vscode.postMessage({ command: 'install-tool', tool }); }
    function installTool(tool) { vscode.postMessage({ command: 'install-tool', tool }); }
  </script>
</body>
</html>`;
  }
}
