import * as vscode from "vscode";
import { ProjectManager, CHIP_TARGET_MAP } from "../core/projectManager";
import { FlashManager } from "../core/flashManager";
import { ToolchainManager, type ToolInfo } from "../core/toolchainManager";

type SidebarSection = "PROJECT" | "ACTIONS" | "DEVICE" | "TOOLCHAIN";

class SidebarItem extends vscode.TreeItem {
  constructor(
    label: string,
    public readonly section: SidebarSection | undefined,
    collapsibleState: vscode.TreeItemCollapsibleState,
    options?: {
      description?: string;
      tooltip?: string;
      command?: vscode.Command;
      iconPath?: vscode.ThemeIcon | vscode.Uri;
      contextValue?: string;
    }
  ) {
    super(label, collapsibleState);
    if (options) {
      this.description = options.description;
      this.tooltip = options.tooltip ?? label;
      this.command = options.command;
      this.iconPath = options.iconPath;
      this.contextValue = options.contextValue;
    }
  }
}

export class SidebarProvider implements vscode.TreeDataProvider<SidebarItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<SidebarItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly projectManager: ProjectManager,
    private readonly flashManager: FlashManager,
    private readonly toolchainManager: ToolchainManager
  ) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: SidebarItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: SidebarItem): Promise<SidebarItem[]> {
    if (!element) {
      return this.getTopLevelSections();
    }

    switch (element.section) {
      case "PROJECT":
        return this.getProjectItems();
      case "ACTIONS":
        return this.getActionItems();
      case "DEVICE":
        return this.getDeviceItems();
      case "TOOLCHAIN":
        return this.getToolchainItems();
      default:
        return [];
    }
  }

  private getTopLevelSections(): SidebarItem[] {
    return [
      new SidebarItem("PROJECT", "PROJECT", vscode.TreeItemCollapsibleState.Expanded, {
        iconPath: new vscode.ThemeIcon("folder"),
        contextValue: "section"
      }),
      new SidebarItem("ACTIONS", "ACTIONS", vscode.TreeItemCollapsibleState.Expanded, {
        iconPath: new vscode.ThemeIcon("zap"),
        contextValue: "section"
      }),
      new SidebarItem("DEVICE", "DEVICE", vscode.TreeItemCollapsibleState.Expanded, {
        iconPath: new vscode.ThemeIcon("plug"),
        contextValue: "section"
      }),
      new SidebarItem("TOOLCHAIN", "TOOLCHAIN", vscode.TreeItemCollapsibleState.Collapsed, {
        iconPath: new vscode.ThemeIcon("tools"),
        contextValue: "section"
      })
    ];
  }

  private getProjectItems(): SidebarItem[] {
    const project = this.projectManager.getActiveProject();
    if (!project) {
      return [
        new SidebarItem("No project found", undefined, vscode.TreeItemCollapsibleState.None, {
          description: "Create or open a project",
          iconPath: new vscode.ThemeIcon("warning"),
          command: {
            command: "espforge.newProject",
            title: "New Project"
          }
        })
      ];
    }

    return [
      new SidebarItem(project.config.project.name, undefined, vscode.TreeItemCollapsibleState.None, {
        description: "Project",
        iconPath: new vscode.ThemeIcon("package"),
        tooltip: project.rootPath
      }),
      new SidebarItem(project.config.project.chip.toUpperCase(), undefined, vscode.TreeItemCollapsibleState.None, {
        description: "Chip",
        iconPath: new vscode.ThemeIcon("circuit-board"),
        command: { command: "espforge.selectChip", title: "Select Chip" },
        tooltip: `Target: ${CHIP_TARGET_MAP[project.config.project.chip]}`
      }),
      new SidebarItem(project.config.build.profile, undefined, vscode.TreeItemCollapsibleState.None, {
        description: "Profile",
        iconPath: new vscode.ThemeIcon(project.config.build.profile === "release" ? "rocket" : "beaker"),
        command: { command: "espforge.toggleProfile", title: "Toggle Profile" }
      }),
      new SidebarItem(project.config.idf.version, undefined, vscode.TreeItemCollapsibleState.None, {
        description: "ESP-IDF",
        iconPath: new vscode.ThemeIcon("versions")
      })
    ];
  }

  private getActionItems(): SidebarItem[] {
    const hasProject = this.projectManager.hasActiveProject();

    const makeAction = (
      label: string,
      command: string,
      icon: string,
      description?: string
    ): SidebarItem =>
      new SidebarItem(label, undefined, vscode.TreeItemCollapsibleState.None, {
        description,
        iconPath: new vscode.ThemeIcon(icon),
        command: hasProject
          ? { command, title: label }
          : undefined,
        contextValue: hasProject ? "action" : "action-disabled"
      });

    return [
      makeAction("Build", "espforge.build", "play", "Ctrl+Shift+B"),
      makeAction("Flash", "espforge.flash", "zap", "Ctrl+Shift+U"),
      makeAction("Build & Flash", "espforge.buildAndFlash", "rocket", "Ctrl+Shift+F"),
      makeAction("Monitor", "espforge.monitor", "terminal", "Ctrl+Shift+M"),
      makeAction("Flash & Monitor", "espforge.flashAndMonitor", "debug-console", "Ctrl+Shift+D"),
      makeAction("Clean", "espforge.clean", "trash"),
      makeAction("Check", "espforge.check", "search")
    ];
  }

  private async getDeviceItems(): Promise<SidebarItem[]> {
    const port = this.flashManager.getActivePort();
    const items: SidebarItem[] = [];

    if (port) {
      items.push(
        new SidebarItem(port, undefined, vscode.TreeItemCollapsibleState.None, {
          description: "Active Port",
          iconPath: new vscode.ThemeIcon("plug"),
          command: { command: "espforge.selectPort", title: "Select Port" }
        })
      );
      items.push(
        new SidebarItem("Show Device Info", undefined, vscode.TreeItemCollapsibleState.None, {
          iconPath: new vscode.ThemeIcon("info"),
          command: { command: "espforge.showDeviceInfo", title: "Show Device Info" }
        })
      );
    } else {
      items.push(
        new SidebarItem("No device connected", undefined, vscode.TreeItemCollapsibleState.None, {
          description: "Plug in ESP32",
          iconPath: new vscode.ThemeIcon("debug-disconnect")
        })
      );
    }

    items.push(
      new SidebarItem("Select Port", undefined, vscode.TreeItemCollapsibleState.None, {
        iconPath: new vscode.ThemeIcon("list-selection"),
        command: { command: "espforge.selectPort", title: "Select Port" }
      }),
      new SidebarItem("Refresh", undefined, vscode.TreeItemCollapsibleState.None, {
        iconPath: new vscode.ThemeIcon("refresh"),
        command: { command: "espforge.refreshSidebar", title: "Refresh" }
      })
    );

    return items;
  }

  private async getToolchainItems(): Promise<SidebarItem[]> {
    const tools: ToolInfo[] = await this.toolchainManager.getToolInfo();
    const targets = await this.toolchainManager.getInstalledTargets();

    const toolItems = tools.map(
      (t) =>
        new SidebarItem(t.name, undefined, vscode.TreeItemCollapsibleState.None, {
          description: t.installed ? t.version : "Not installed",
          iconPath: new vscode.ThemeIcon(t.installed ? "check" : "warning"),
          tooltip: t.installed ? `${t.name} ${t.version}` : `${t.name} is not installed`
        })
    );

    const targetItems = targets.map(
      (target) =>
        new SidebarItem(target, undefined, vscode.TreeItemCollapsibleState.None, {
          iconPath: new vscode.ThemeIcon("chip"),
          description: "target"
        })
    );

    const manageItem = new SidebarItem(
      "Manage Toolchain",
      undefined,
      vscode.TreeItemCollapsibleState.None,
      {
        iconPath: new vscode.ThemeIcon("settings-gear"),
        command: { command: "espforge.manageToolchain", title: "Manage Toolchain" }
      }
    );

    return [...toolItems, ...targetItems, manageItem];
  }
}
