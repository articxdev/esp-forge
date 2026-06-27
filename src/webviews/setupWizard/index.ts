import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { Installer } from "../../bootstrap/installer";
import type { HealthCheck } from "../../bootstrap/healthCheck";

export class SetupWizardPanel {
  public static currentPanel: SetupWizardPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  public static createOrShow(
    context: vscode.ExtensionContext,
    healthCheck: HealthCheck
  ): void {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (SetupWizardPanel.currentPanel) {
      SetupWizardPanel.currentPanel.panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "espforge.setupWizard",
      "ESP Forge Setup",
      column ?? vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [context.extensionUri],
        retainContextWhenHidden: true
      }
    );

    SetupWizardPanel.currentPanel = new SetupWizardPanel(panel, context, healthCheck);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly healthCheck: HealthCheck
  ) {
    this.panel = panel;
    this.update();
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.panel.webview.onDidReceiveMessage(
      async (message: { command: string; items?: string[] }) => {
        switch (message.command) {
          case "run-check":
            await this.runCheck();
            break;
          case "install-all":
            await this.installAll();
            break;
          case "install-selected":
            await this.installSelected(message.items ?? []);
            break;
          case "open-zadig":
            vscode.env.openExternal(vscode.Uri.parse("https://zadig.akeo.ie"));
            break;
        }
      },
      null,
      this.disposables
    );
  }

  private async runCheck(): Promise<void> {
    const result = await this.healthCheck.runFullCheck();
    this.panel.webview.postMessage({ command: "check-result", result });
  }

  private async installAll(): Promise<void> {
    const result = await this.healthCheck.runFullCheck();
    const installer = new Installer(
      this.context,
      vscode.window.createOutputChannel("ESP Forge: Install"),
      this.healthCheck,
      (progress) => {
        this.panel.webview.postMessage({ command: "install-progress", progress });
      }
    );
    await installer.installAll(result.items);
    // Re-run check after install
    await this.runCheck();
  }

  private async installSelected(itemIds: string[]): Promise<void> {
    const result = await this.healthCheck.runFullCheck();
    const selected = result.items.filter((i) => itemIds.includes(i.id));
    const installer = new Installer(
      this.context,
      vscode.window.createOutputChannel("ESP Forge: Install"),
      this.healthCheck,
      (progress) => {
        this.panel.webview.postMessage({ command: "install-progress", progress });
      }
    );
    for (const item of selected) {
      await installer.installItem(item);
    }
    await this.runCheck();
  }

  private update(): void {
    const htmlPath = path.join(this.context.extensionPath, "src", "webviews", "setupWizard", "ui.html");
    let html: string;
    try {
      html = fs.readFileSync(htmlPath, "utf8");
    } catch {
      html = this.getFallbackHtml();
    }
    this.panel.webview.html = html;

    // Immediately run check
    this.runCheck();
  }

  private getFallbackHtml(): string {
    return getSetupWizardHtml();
  }

  private dispose(): void {
    SetupWizardPanel.currentPanel = undefined;
    this.panel.dispose();
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
  }
}

function getSetupWizardHtml(): string {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>ESP Forge Setup</title>
<style>body{background:#000;color:#fff;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:40px;}</style>
</head><body><h1>ESP Forge Setup</h1><p>UI file not found. Please rebuild the extension.</p></body></html>`;
}
