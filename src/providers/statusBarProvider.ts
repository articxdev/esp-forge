import * as vscode from "vscode";
import { ProjectManager, CHIP_TARGET_MAP } from "../core/projectManager";
import { FlashManager } from "../core/flashManager";

export class StatusBarProvider {
  private readonly chipItem: vscode.StatusBarItem;
  private readonly portItem: vscode.StatusBarItem;
  private readonly profileItem: vscode.StatusBarItem;
  private readonly statusItem: vscode.StatusBarItem;
  private readonly buildFlashItem: vscode.StatusBarItem;
  private readonly flashItem: vscode.StatusBarItem;
  private readonly monitorItem: vscode.StatusBarItem;
  private buildStartTime: number | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly projectManager: ProjectManager,
    private readonly flashManager: FlashManager
  ) {
    const priority = 100;

    this.chipItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, priority + 3);
    this.portItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, priority + 2);
    this.profileItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, priority + 1);
    this.statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, priority);
    this.buildFlashItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, priority - 1);
    this.flashItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, priority - 2);
    this.monitorItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, priority - 3);

    context.subscriptions.push(this.chipItem, this.portItem, this.profileItem, this.statusItem, this.buildFlashItem, this.flashItem, this.monitorItem);
  }

  initialize(): void {
    this.chipItem.command = "espforge.selectChip";
    this.portItem.command = "espforge.selectPort";
    this.profileItem.command = "espforge.toggleProfile";
    this.statusItem.command = "espforge.build";
    this.buildFlashItem.command = "espforge.buildAndFlash";
    this.flashItem.command = "espforge.flash";
    this.monitorItem.command = "espforge.monitor";

    this.refresh();
  }

  refresh(): void {
    const project = this.projectManager.getActiveProject();

    if (!project) {
      this.chipItem.text = "$(circuit-board) ESP Forge";
      this.chipItem.tooltip = "No ESP Forge project. Click to create one.";
      this.chipItem.command = "espforge.newProject";
      this.chipItem.show();

      this.portItem.hide();
      this.profileItem.hide();
      this.statusItem.hide();
      this.buildFlashItem.hide();
      this.flashItem.hide();
      this.monitorItem.hide();
      return;
    }

    const chip = project.config.project.chip.toUpperCase();
    const port = this.flashManager.getActivePort() ?? project.activePort ?? "No Port";
    const profile = project.config.build.profile;
    const target = CHIP_TARGET_MAP[project.config.project.chip];

    this.chipItem.text = `$(circuit-board) ${chip}`;
    this.chipItem.tooltip = `ESP32 Chip: ${chip}\nTarget: ${target}\nClick to change chip`;
    this.chipItem.backgroundColor = undefined;
    this.chipItem.show();

    this.portItem.text = `$(plug) ${port}`;
    this.portItem.tooltip = `Serial Port: ${port}\nClick to change port`;
    this.portItem.show();

    this.profileItem.text = `$(beaker) ${profile}`;
    this.profileItem.tooltip = `Build Profile: ${profile}\nClick to toggle`;
    this.profileItem.show();

    this.statusItem.text = "$(check) Build";
    this.statusItem.tooltip = "ESP Forge: Click to build project.";
    this.statusItem.backgroundColor = undefined;
    this.statusItem.show();

    this.buildFlashItem.text = "$(rocket) Build & Flash";
    this.buildFlashItem.tooltip = "ESP Forge: Build and flash to device";
    this.buildFlashItem.show();

    this.flashItem.text = "$(zap) Flash";
    this.flashItem.tooltip = "ESP Forge: Flash to device";
    this.flashItem.show();

    this.monitorItem.text = "$(terminal) Monitor";
    this.monitorItem.tooltip = "ESP Forge: Open Serial Monitor";
    this.monitorItem.show();
  }

  setBuilding(): void {
    this.buildStartTime = Date.now();
    this.statusItem.text = "$(sync~spin) Building...";
    this.statusItem.tooltip = "ESP Forge: Build in progress...";
    this.statusItem.backgroundColor = undefined;
    this.statusItem.show();
  }

  setBuildOk(): void {
    const elapsed = this.buildStartTime
      ? ((Date.now() - this.buildStartTime) / 1000).toFixed(1)
      : "?";
    this.buildStartTime = undefined;
    this.statusItem.text = `$(check) Build OK (${elapsed}s)`;
    this.statusItem.tooltip = `Build succeeded in ${elapsed}s`;
    this.statusItem.backgroundColor = undefined;
    this.statusItem.show();

    // Reset to Ready after 5 seconds
    setTimeout(() => {
      if (this.statusItem.text.startsWith("$(check) Build OK")) {
        this.statusItem.text = "$(check) Ready";
        this.statusItem.tooltip = "ESP Forge: Ready. Click to build.";
      }
    }, 5000);
  }

  setBuildFailed(errorCount?: number): void {
    this.buildStartTime = undefined;
    const errors = errorCount !== undefined ? ` (${errorCount} errors)` : "";
    this.statusItem.text = `$(error) Build Failed${errors}`;
    this.statusItem.tooltip = "Build failed. Click to see output.";
    this.statusItem.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
    this.statusItem.command = "workbench.actions.view.problems";
    this.statusItem.show();
  }

  setFlashing(): void {
    this.statusItem.text = "$(zap~spin) Flashing...";
    this.statusItem.tooltip = "ESP Forge: Flashing firmware...";
    this.statusItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    this.statusItem.show();
  }

  dispose(): void {
    this.chipItem.dispose();
    this.portItem.dispose();
    this.profileItem.dispose();
    this.statusItem.dispose();
    this.buildFlashItem.dispose();
    this.flashItem.dispose();
    this.monitorItem.dispose();
  }
}
