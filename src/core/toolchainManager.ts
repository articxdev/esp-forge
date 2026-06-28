import * as vscode from "vscode";
import * as os from "os";
import * as path from "path";
import { ProcessRunner } from "../utils/processRunner";
import { getEspEnvironment, getPlatformInfo } from "../bootstrap/platformDetect";

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

    // git
    let gitInfo = await this.getToolVersionFallback(["git", "git.exe"], ["--version"]);
    tools.push({ name: "Git", ...gitInfo });

    // python
    let pythonInfo = await this.getToolVersionFallback(["python3", "python", "py"], ["--version"]);
    tools.push({ name: "Python", ...pythonInfo });

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
          { env: getEspEnvironment() },
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
          { env: getEspEnvironment() },
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
        case "install-tool": {
          const toolName = msg.tool;
          if (toolName) {
            try {
              await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: `ESP Forge: Installing ${toolName}...`, cancellable: false },
                async (progress) => {
                  progress.report({ message: "Starting installation..." });
                  const platformInfo = getPlatformInfo();
                  const espEnv = getEspEnvironment();
                  const onLine = (line: string) => {
                    this.output.appendLine(line);
                    progress.report({ message: line.slice(0, 60) });
                  };

                  if (toolName === "rustup" || toolName === "cargo") {
                    if (platformInfo.isWindows) {
                      const tmpPath = path.join(os.tmpdir(), "rustup-init.exe");
                      await this.runner.runStreaming(
                        "powershell",
                        [
                          "-NoProfile",
                          "-ExecutionPolicy", "Bypass",
                          "-Command", 
                          `$ErrorActionPreference = 'Stop'; $settingsPath = Join-Path $env:USERPROFILE '.rustup' 'settings.toml'; if (Test-Path $settingsPath) { Rename-Item $settingsPath settings.toml.bak -Force }; [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -UseBasicParsing -Uri 'https://win.rustup.rs/x86_64' -OutFile '${tmpPath}'; & '${tmpPath}' -y -q --default-host x86_64-pc-windows-msvc; exit $LASTEXITCODE`
                        ],
                        { env: espEnv },
                        onLine
                      );
                    } else {
                      await this.runner.runStreaming(
                        "sh",
                        ["-c", "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y"],
                        { env: espEnv },
                        onLine
                      );
                    }
                  } else {
                    // Ensure a Rust toolchain is configured (rustup may exist without a default)
                    await this.ensureRustToolchain(espEnv, onLine);

                    // Try cargo binstall first (fast precompiled binary), fall back to cargo install
                    let installed = false;
                    try {
                      await this.runner.runStreaming("cargo", ["binstall", toolName, "-y"], { env: espEnv }, onLine);
                      installed = true;
                    } catch {
                      onLine("cargo binstall unavailable or failed, falling back to cargo install...");
                    }

                    if (!installed) {
                      onLine(`Compiling ${toolName} from source (this may take several minutes)...`);
                      await this.runner.runStreaming("cargo", ["install", toolName], { env: espEnv }, onLine);
                    }
                  }
                  vscode.window.showInformationMessage(`${toolName} installed.`);
                  // Refresh panel
                  const newTools = await this.getToolInfo();
                  const newTargets = await this.getInstalledTargets();
                  panel.webview.html = this.buildManagementHtml(newTools, newTargets);
                }
              );
            } catch (err: any) {
              const errMsg = err?.message ?? String(err);
              this.output.appendLine(`[ToolchainManager] Install failed for ${toolName}: ${errMsg}`);
              vscode.window.showErrorMessage(
                `Failed to install ${toolName}: ${errMsg}. Check "ESP Forge" output channel for details.`
              );
            }
          }
          break;
        }
      }
    });
  }

  /**
   * Ensure a default Rust toolchain is configured.
   * Rustup may be installed but without a default toolchain, causing cargo to fail.
   */
  private async ensureRustToolchain(
    env: Record<string, string>,
    onLine: (line: string) => void
  ): Promise<void> {
    try {
      // Quick check: does cargo work?
      await this.runner.runSilent("cargo", ["--version"], { env });
    } catch (err: any) {
      const msg = String(err.message ?? err);
      if (msg.includes("no default") || msg.includes("rustup could not choose")) {
        onLine("No default Rust toolchain found. Setting up 'stable'...");
        await this.runner.runStreaming("rustup", ["default", "stable"], { env }, onLine);
        onLine("Rust stable toolchain configured.");
      } else if (msg.includes("not found") || msg.includes("ENOENT")) {
        throw new Error(
          "Cargo is not installed. Please install Rust first by clicking the 'Install' button next to rustup/Cargo in the toolchain panel."
        );
      }
      // For other errors, let the caller handle them
    }
  }

  private async getToolVersion(cmd: string, args: string[]): Promise<{ installed: boolean; version?: string }> {
    try {
      const result = await this.runner.runSilent(cmd, args, { env: getEspEnvironment() });
      const version = result.stdout.trim().split("\n")[0] ?? "unknown";
      return { installed: true, version };
    } catch {
      return { installed: false };
    }
  }

  private async getToolVersionFallback(cmds: string[], args: string[]): Promise<{ installed: boolean; version?: string; command: string }> {
    for (const cmd of cmds) {
      try {
        const result = await this.runner.runSilent(cmd, args, { env: getEspEnvironment() });
        const version = result.stdout.trim().split("\n")[0] ?? "unknown";
        return { installed: true, version, command: cmd };
      } catch {
        // Continue to next fallback
      }
    }
    return { installed: false, command: cmds[0] };
  }

  private buildManagementHtml(tools: ToolInfo[], targets: string[]): string {
    const toolRows = tools
      .map(
        (t) => {
          const isSystem = t.name === 'Git' || t.name === 'Python';
          const icon = t.installed 
            ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:8px; vertical-align:text-bottom"><polyline points="20 6 9 17 4 12"></polyline></svg>` 
            : `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:8px; vertical-align:text-bottom"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;
          
          let buttonHtml = '';
          if (!isSystem) {
             buttonHtml = t.installed 
               ? `<button class="btn btn-sm btn-secondary" onclick="updateTool('${t.command}')">Update</button>` 
               : `<button class="btn btn-sm btn-primary" onclick="installTool('${t.command}')">Install</button>`;
          } else if (!t.installed) {
             buttonHtml = `<span style="font-size:12px; color:var(--subtext)">Please install manually</span>`;
          }

          return `
          <div class="tool-row">
            <div class="tool-name">${t.name}</div>
            <div class="tool-version ${t.installed ? "ok" : "missing"}">
              ${icon}${t.installed ? t.version ?? "Installed" : "Not installed"}
            </div>
            ${buttonHtml}
          </div>`;
        }
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
    :root {
      --bg: #000000;
      --surface: #0a0a0a;
      --border: #222222;
      --border-hover: #444444;
      --text: #ffffff;
      --subtext: #888888;
      --accent: #ffffff;
      --accent-fg: #000000;
      --danger: #ff4444;
      --success: #a6e3a1;
      --warning: #f9e2af;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; padding: 40px; line-height: 1.5; -webkit-font-smoothing: antialiased; max-width: 800px; margin: 0 auto; }
    h1 { font-size: 24px; font-weight: 400; color: var(--text); letter-spacing: -0.5px; margin-bottom: 32px; }
    h2 { font-size: 13px; font-weight: 500; color: var(--subtext); text-transform: uppercase; letter-spacing: 0.5px; margin: 32px 0 16px; }
    
    .tools-grid { display: flex; flex-direction: column; gap: 1px; background: var(--border); border: 1px solid var(--border); margin-bottom: 32px; }
    .tool-row { display: flex; align-items: center; gap: 16px; padding: 16px 20px; background: var(--bg); transition: background 0.2s; }
    .tool-row:hover { background: var(--surface); }
    .tool-name { font-weight: 500; font-size: 14px; color: var(--text); width: 120px; }
    .tool-version { font-family: monospace; font-size: 13px; flex: 1; }
    .tool-version.ok { color: var(--success); }
    .tool-version.missing { color: var(--danger); }
    
    .targets-container { display: flex; flex-wrap: wrap; gap: 8px; }
    .target-chip { display: inline-block; background: transparent; border: 1px solid var(--border); padding: 6px 12px; font-family: monospace; font-size: 12px; color: var(--text); }
    
    .btn { padding: 8px 16px; border: none; cursor: pointer; font-size: 13px; font-weight: 500; transition: all 0.2s; white-space: nowrap; }
    .btn.btn-sm { padding: 6px 12px; }
    .btn-secondary { background: transparent; color: var(--text); border: 1px solid var(--border); }
    .btn-secondary:hover { border-color: var(--text); }
    .btn-primary { background: var(--accent); color: var(--accent-fg); }
    .btn-primary:hover { opacity: 0.8; }
    
    .action-bar { display: flex; gap: 16px; margin-top: 40px; padding-top: 32px; border-top: 1px solid var(--border); }
    .btn-large { padding: 10px 24px; }
  </style>
</head>
<body>
  <h1>ESP Toolchain Manager</h1>

  <h2>Installed Tools</h2>
  <div class="tools-grid">
  ${toolRows}
  </div>

  <h2>ESP Rust Targets</h2>
  <div class="targets-container">${targetList || '<p style="color:var(--subtext);font-size:13px">No ESP targets installed. Run update ESP toolchain.</p>'}</div>

  <div class="action-bar">
    <button class="btn btn-large btn-primary" onclick="updateEspup()">Update ESP Toolchain</button>
    <button class="btn btn-large btn-secondary" onclick="repair()">Repair Installation</button>
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
