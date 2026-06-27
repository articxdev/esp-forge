import * as vscode from "vscode";
import { ProjectManager } from "./core/projectManager";
import { CargoRunner } from "./core/cargoRunner";
import { FlashManager } from "./core/flashManager";
import { SerialMonitor } from "./core/serialMonitor";
import { DebugManager } from "./core/debugManager";
import { ToolchainManager } from "./core/toolchainManager";
import { SidebarProvider } from "./providers/sidebarProvider";
import { StatusBarProvider } from "./providers/statusBarProvider";
import { HealthCheck } from "./bootstrap/healthCheck";
import { SetupWizardPanel } from "./webviews/setupWizard/index";
import { NewProjectPanel } from "./webviews/newProject/index";
import { SerialMonitorPanel } from "./webviews/serialMonitor/index";
import { ComponentBrowserPanel } from "./webviews/componentBrowser/index";

let outputChannel: vscode.OutputChannel;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const activationStart = Date.now();

  // Create output channel first
  outputChannel = vscode.window.createOutputChannel("ESP Forge", { log: true });
  context.subscriptions.push(outputChannel);

  outputChannel.appendLine("[ESP Forge] Activating extension...");

  // Initialize core components
  const projectManager = new ProjectManager(context, outputChannel);
  const cargoRunner = new CargoRunner(context, outputChannel);
  const flashManager = new FlashManager(context, outputChannel);
  const serialMonitor = new SerialMonitor(context, outputChannel);
  const debugManager = new DebugManager(context, outputChannel);
  const toolchainManager = new ToolchainManager(context, outputChannel);

  // Initialize UI providers
  const sidebarProvider = new SidebarProvider(
    context,
    projectManager,
    flashManager,
    toolchainManager
  );
  const statusBarProvider = new StatusBarProvider(context, projectManager, flashManager);

  // Register sidebar tree view
  const treeView = vscode.window.createTreeView("espforge.sidebar", {
    treeDataProvider: sidebarProvider,
    showCollapseAll: true
  });
  context.subscriptions.push(treeView);

  // Initialize project detection (fast, non-blocking)
  await projectManager.detectProject();
  statusBarProvider.initialize();
  sidebarProvider.refresh();

  // Set context for keybindings
  vscode.commands.executeCommand(
    "setContext",
    "espforge.projectActive",
    projectManager.hasActiveProject()
  );

  // Register all commands
  registerCommands(
    context,
    projectManager,
    cargoRunner,
    flashManager,
    serialMonitor,
    debugManager,
    toolchainManager,
    sidebarProvider,
    statusBarProvider
  );

  // Set up file watchers
  setupFileWatchers(context, projectManager, sidebarProvider, statusBarProvider, cargoRunner);

  // Set up USB detection
  setupUsbDetection(context, flashManager, sidebarProvider, statusBarProvider);

  // Register disposable managers to clean up on deactivation
  context.subscriptions.push({ dispose: () => debugManager.dispose() });
  context.subscriptions.push({ dispose: () => serialMonitor.dispose() });

  const activationTime = Date.now() - activationStart;
  outputChannel.appendLine(`[ESP Forge] Activated in ${activationTime}ms`);

  // Run health check in background — never blocks activation
  setImmediate(async () => {
    try {
      const healthCheck = new HealthCheck(context, outputChannel);
      const result = await healthCheck.runQuickCheck();
      if (!result.allHealthy) {
        const missing = result.missing.join(", ");
        const action = await vscode.window.showWarningMessage(
          `ESP Forge: Missing tools detected (${missing}). Open setup wizard?`,
          "Open Setup Wizard",
          "Dismiss"
        );
        if (action === "Open Setup Wizard") {
          SetupWizardPanel.createOrShow(context, healthCheck);
        }
      }
    } catch (err) {
      outputChannel.appendLine(`[ESP Forge] Health check error: ${String(err)}`);
    }
  });
}

function registerCommands(
  context: vscode.ExtensionContext,
  projectManager: ProjectManager,
  cargoRunner: CargoRunner,
  flashManager: FlashManager,
  serialMonitor: SerialMonitor,
  debugManager: DebugManager,
  toolchainManager: ToolchainManager,
  sidebarProvider: SidebarProvider,
  statusBarProvider: StatusBarProvider
): void {
  const register = (cmd: string, fn: () => Promise<void> | void) => {
    context.subscriptions.push(vscode.commands.registerCommand(cmd, fn));
  };

  register("espforge.newProject", async () => {
    NewProjectPanel.createOrShow(context, projectManager);
  });

  register("espforge.build", async () => {
    const project = projectManager.getActiveProject();
    if (!project) {
      vscode.window.showErrorMessage("No ESP Forge project found. Create or open a project first.");
      return;
    }
    statusBarProvider.setBuilding();
    try {
      await cargoRunner.build(project);
      statusBarProvider.setBuildOk();
      sidebarProvider.refresh();
    } catch (err) {
      statusBarProvider.setBuildFailed();
      vscode.window.showErrorMessage(`Build failed: ${String(err)}`);
    }
  });

  register("espforge.flash", async () => {
    const project = projectManager.getActiveProject();
    if (!project) {
      vscode.window.showErrorMessage("No ESP Forge project found.");
      return;
    }
    try {
      await flashManager.flash(project);
    } catch (err) {
      vscode.window.showErrorMessage(`Flash failed: ${String(err)}`);
    }
  });

  register("espforge.buildAndFlash", async () => {
    const project = projectManager.getActiveProject();
    if (!project) {
      vscode.window.showErrorMessage("No ESP Forge project found.");
      return;
    }
    statusBarProvider.setBuilding();
    try {
      await cargoRunner.build(project);
      statusBarProvider.setBuildOk();
      await flashManager.flash(project);
    } catch (err) {
      statusBarProvider.setBuildFailed();
      vscode.window.showErrorMessage(`Build & Flash failed: ${String(err)}`);
    }
  });

  register("espforge.monitor", async () => {
    const project = projectManager.getActiveProject();
    if (!project) {
      vscode.window.showErrorMessage("No ESP Forge project found.");
      return;
    }
    const config = vscode.workspace.getConfiguration("espforge");
    if (config.get<string>("serialMonitorMode") === "rich") {
      SerialMonitorPanel.createOrShow(context, project, flashManager);
    } else {
      await serialMonitor.openSimpleMonitor(project);
    }
  });

  register("espforge.flashAndMonitor", async () => {
    const project = projectManager.getActiveProject();
    if (!project) {
      vscode.window.showErrorMessage("No ESP Forge project found.");
      return;
    }
    try {
      await flashManager.flash(project);
      const config = vscode.workspace.getConfiguration("espforge");
      if (config.get<string>("serialMonitorMode") === "rich") {
        SerialMonitorPanel.createOrShow(context, project, flashManager);
      } else {
        await serialMonitor.openSimpleMonitor(project);
      }
    } catch (err) {
      vscode.window.showErrorMessage(`Flash & Monitor failed: ${String(err)}`);
    }
  });

  register("espforge.clean", async () => {
    const project = projectManager.getActiveProject();
    if (!project) {
      vscode.window.showErrorMessage("No ESP Forge project found.");
      return;
    }
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "ESP Forge: Cleaning..." },
      async () => {
        await cargoRunner.clean(project);
      }
    );
    vscode.window.showInformationMessage("Clean complete.");
  });

  register("espforge.check", async () => {
    const project = projectManager.getActiveProject();
    if (!project) {
      vscode.window.showErrorMessage("No ESP Forge project found.");
      return;
    }
    await cargoRunner.check(project);
  });

  register("espforge.selectPort", async () => {
    const port = await flashManager.selectPort();
    if (port) {
      await projectManager.setActivePort(port);
      statusBarProvider.refresh();
      sidebarProvider.refresh();
    }
  });

  register("espforge.selectChip", async () => {
    const chip = await projectManager.promptSelectChip();
    if (chip) {
      statusBarProvider.refresh();
      sidebarProvider.refresh();
    }
  });

  register("espforge.toggleProfile", async () => {
    await projectManager.toggleProfile();
    statusBarProvider.refresh();
    sidebarProvider.refresh();
  });

  register("espforge.setup", async () => {
    const healthCheck = new HealthCheck(context, outputChannel);
    SetupWizardPanel.createOrShow(context, healthCheck);
  });

  register("espforge.manageToolchain", async () => {
    await toolchainManager.showManagementPanel(context);
  });

  register("espforge.startDebug", async () => {
    const project = projectManager.getActiveProject();
    if (!project) {
      vscode.window.showErrorMessage("No ESP Forge project found.");
      return;
    }
    await debugManager.startDebugSession(project);
  });

  register("espforge.analyzeCoreDump", async () => {
    const project = projectManager.getActiveProject();
    if (!project) {
      vscode.window.showErrorMessage("No ESP Forge project found.");
      return;
    }
    await debugManager.analyzeCoreDump(project, context);
  });

  register("espforge.eraseFlash", async () => {
    const project = projectManager.getActiveProject();
    if (!project) {
      vscode.window.showErrorMessage("No ESP Forge project found.");
      return;
    }
    const confirm = await vscode.window.showWarningMessage(
      "This will erase ALL data on the ESP32 flash memory. Are you sure?",
      { modal: true },
      "Erase Flash"
    );
    if (confirm === "Erase Flash") {
      await flashManager.eraseFlash(project);
    }
  });

  register("espforge.flashOTA", async () => {
    const project = projectManager.getActiveProject();
    if (!project) {
      vscode.window.showErrorMessage("No ESP Forge project found.");
      return;
    }
    await flashManager.flashOTA(project);
  });

  register("espforge.browseComponents", async () => {
    ComponentBrowserPanel.createOrShow(context);
  });

  register("espforge.editPartitions", async () => {
    const project = projectManager.getActiveProject();
    if (!project) {
      vscode.window.showErrorMessage("No ESP Forge project found.");
      return;
    }
    await projectManager.editPartitions(context, project);
  });

  register("espforge.showDeviceInfo", async () => {
    await flashManager.showDeviceInfo(outputChannel);
  });

  register("espforge.generateCI", async () => {
    const project = projectManager.getActiveProject();
    if (!project) {
      vscode.window.showErrorMessage("No ESP Forge project found.");
      return;
    }
    await projectManager.generateCIConfig(project);
  });

  register("espforge.profileMemory", async () => {
    const project = projectManager.getActiveProject();
    if (!project) {
      vscode.window.showErrorMessage("No ESP Forge project found.");
      return;
    }
    await projectManager.profileMemory(context, project);
  });

  register("espforge.refreshSidebar", () => {
    sidebarProvider.refresh();
  });
}

function setupFileWatchers(
  context: vscode.ExtensionContext,
  projectManager: ProjectManager,
  sidebarProvider: SidebarProvider,
  statusBarProvider: StatusBarProvider,
  cargoRunner: CargoRunner
): void {
  // Watch ferrous32.toml for changes
  const ferrous32Watcher = vscode.workspace.createFileSystemWatcher("**/ferrous32.toml");

  ferrous32Watcher.onDidChange(async () => {
    await projectManager.reloadProject();
    sidebarProvider.refresh();
    statusBarProvider.refresh();
    await projectManager.updateRustAnalyzerSettings();
  });

  ferrous32Watcher.onDidCreate(async () => {
    await projectManager.detectProject();
    sidebarProvider.refresh();
    statusBarProvider.refresh();
    vscode.commands.executeCommand("setContext", "espforge.projectActive", true);
  });

  ferrous32Watcher.onDidDelete(() => {
    sidebarProvider.refresh();
    statusBarProvider.refresh();
  });

  context.subscriptions.push(ferrous32Watcher);

  // Watch Rust source files for check-on-save
  const rustWatcher = vscode.workspace.onDidSaveTextDocument(async (doc) => {
    if (!doc.fileName.endsWith(".rs")) {
      return;
    }
    const config = vscode.workspace.getConfiguration("espforge");
    if (!config.get<boolean>("checkOnSave", true)) {
      return;
    }
    const project = projectManager.getActiveProject();
    if (!project) {
      return;
    }
    await cargoRunner.checkDebounced(project);
  });

  context.subscriptions.push(rustWatcher);
}

function setupUsbDetection(
  context: vscode.ExtensionContext,
  flashManager: FlashManager,
  sidebarProvider: SidebarProvider,
  statusBarProvider: StatusBarProvider
): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const usbDetection = require("usb-detection");
    usbDetection.startMonitoring();

    usbDetection.on("add", async (_device: { vendorId: number; productId: number; deviceName: string }) => {
      // Debounce slightly for device enumeration
      await new Promise((r) => setTimeout(r, 500));
      const detected = await flashManager.checkNewUsbDevice(_device.vendorId, _device.productId);
      if (detected) {
        sidebarProvider.refresh();
        statusBarProvider.refresh();
        const action = await vscode.window.showInformationMessage(
          `ESP32 device detected: ${detected.name} — Set as active device?`,
          "Set Active",
          "Dismiss"
        );
        if (action === "Set Active") {
          await flashManager.setActivePort(detected.port);
          sidebarProvider.refresh();
          statusBarProvider.refresh();
        }
      }
    });

    usbDetection.on("remove", () => {
      sidebarProvider.refresh();
      statusBarProvider.refresh();
    });

    context.subscriptions.push({
      dispose: () => {
        usbDetection.stopMonitoring();
      }
    });
  } catch {
    // usb-detection may not be available on all platforms
    outputChannel.appendLine("[ESP Forge] USB detection not available on this platform.");
  }
}

export function deactivate(): void {
  outputChannel?.appendLine("[ESP Forge] Deactivating...");
}
