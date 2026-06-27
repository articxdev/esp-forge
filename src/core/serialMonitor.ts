import * as vscode from "vscode";
import * as path from "path";
import { ProcessRunner } from "../utils/processRunner";
import type { EspProject } from "./projectManager";

export class SerialMonitor {
  private readonly runner: ProcessRunner;
  private activeTerminal: vscode.Terminal | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel
  ) {
    this.runner = new ProcessRunner(output);

    // Clean up terminal on dispose
    context.subscriptions.push(
      vscode.window.onDidCloseTerminal((terminal) => {
        if (this.activeTerminal === terminal) {
          this.activeTerminal = undefined;
        }
      })
    );
  }

  async openSimpleMonitor(project: EspProject): Promise<void> {
    const port = project.activePort ?? project.config.flash.port;
    if (!port || port === "auto") {
      vscode.window.showErrorMessage(
        "No port selected for serial monitor. Use ESPForge: Select Port first.",
        "Select Port"
      ).then((action) => {
        if (action === "Select Port") {
          vscode.commands.executeCommand("espforge.selectPort");
        }
      });
      return;
    }

    // Close existing terminal if open
    if (this.activeTerminal) {
      this.activeTerminal.dispose();
    }

    const terminalName = `ESP Forge: Monitor (${port})`;
    this.activeTerminal = vscode.window.createTerminal({
      name: terminalName,
      iconPath: new vscode.ThemeIcon("terminal")
    });

    const cmd = [
      "espflash",
      "monitor",
      "--port",
      port,
      "--baud",
      String(project.config.monitor.baud)
    ].join(" ");

    this.activeTerminal.show();
    this.activeTerminal.sendText(cmd);
    this.output.appendLine(`[SerialMonitor] Opened simple monitor on ${port} at ${project.config.monitor.baud} baud`);
  }

  dispose(): void {
    this.activeTerminal?.dispose();
  }
}
