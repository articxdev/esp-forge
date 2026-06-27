import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { FlashManager } from "../../core/flashManager";
import { PortScanner } from "../../utils/portScanner";
import { DefmtDecoder } from "../../utils/defmtDecoder";
import { CHIP_TARGET_MAP, type EspProject } from "../../core/projectManager";

export class SerialMonitorPanel {
  public static currentPanel: SerialMonitorPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private serialPort: import("serialport").SerialPort | undefined;
  private defmtDecoder: DefmtDecoder | undefined;
  private defmtPipe: { write: (data: Buffer) => void; stop: () => void } | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private currentPort: string | undefined;
  private currentBaud: number;
  private isConnected = false;

  public static createOrShow(
    context: vscode.ExtensionContext,
    project: EspProject,
    flashManager: FlashManager
  ): void {
    const column = vscode.ViewColumn.Two;

    if (SerialMonitorPanel.currentPanel) {
      SerialMonitorPanel.currentPanel.panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "espforge.serialMonitor",
      "ESP Forge: Serial Monitor",
      column,
      {
        enableScripts: true,
        localResourceRoots: [context.extensionUri],
        retainContextWhenHidden: true
      }
    );

    SerialMonitorPanel.currentPanel = new SerialMonitorPanel(
      panel,
      context,
      project,
      flashManager
    );
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly project: EspProject,
    private readonly flashManager: FlashManager
  ) {
    this.panel = panel;
    this.currentBaud = project.config.monitor.baud;
    this.currentPort = flashManager.getActivePort() ?? project.activePort;

    const htmlPath = path.join(
      context.extensionPath,
      "src",
      "webviews",
      "serialMonitor",
      "ui.html"
    );
    try {
      this.panel.webview.html = fs.readFileSync(htmlPath, "utf8");
    } catch {
      this.panel.webview.html = this.getFallbackHtml();
    }

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.panel.webview.onDidReceiveMessage(
      async (msg: SerialMessage) => {
        switch (msg.command) {
          case "connect":
            await this.connect(msg.port ?? this.currentPort ?? "", msg.baud ?? this.currentBaud);
            break;
          case "disconnect":
            await this.disconnect();
            break;
          case "send":
            await this.send(msg.data ?? "");
            break;
          case "change-baud":
            if (msg.baud) {
              await this.changeBaud(msg.baud);
            }
            break;
          case "scan-ports":
            await this.scanPorts();
            break;
          case "open-file":
            if (msg.file && msg.line !== undefined) {
              await this.openFile(msg.file, msg.line);
            }
            break;
          case "save-log":
            await this.saveLog(msg.data ?? "");
            break;
        }
      },
      null,
      this.disposables
    );

    // Auto-connect if port is known
    if (this.currentPort) {
      setTimeout(() => {
        this.connect(this.currentPort!, this.currentBaud);
      }, 500);
    } else {
      this.scanPorts();
    }
  }

  private async connect(port: string, baud: number): Promise<void> {
    await this.disconnect();

    this.currentPort = port;
    this.currentBaud = baud;

    try {
      const { SerialPort } = await import("serialport");
      const { ReadlineParser } = await import("@serialport/parser-readline");

      this.serialPort = new SerialPort({ path: port, baudRate: baud });

      const parser = this.serialPort.pipe(new ReadlineParser({ delimiter: "\n" }));

      // Check if project uses defmt
      const cargoTomlPath = path.join(this.project.rootPath, "Cargo.toml");
      let usesDefmt = false;
      try {
        const cargoContent = fs.readFileSync(cargoTomlPath, "utf8");
        usesDefmt = DefmtDecoder.projectUsesDefmt(cargoContent);
      } catch { /* ignore */ }

      if (usesDefmt && this.project.config.monitor.filters.includes("defmt")) {
        const target = CHIP_TARGET_MAP[this.project.config.project.chip];
        const elfPath = path.join(
          this.project.rootPath,
          "target",
          target,
          this.project.config.build.profile,
          this.project.config.project.name
        );

        this.defmtDecoder = new DefmtDecoder(vscode.window.createOutputChannel("defmt"));
        this.defmtPipe = this.defmtDecoder.startDecoding(elfPath, (frame) => {
          const html = DefmtDecoder.frameToHtml(frame);
          this.panel.webview.postMessage({ command: "append-html", html });
        });

        this.serialPort.on("data", (data: Buffer) => {
          this.defmtPipe?.write(data);
        });
      } else {
        // Raw text mode - batch updates for high baud rates
        let buffer = "";
        let flushTimer: ReturnType<typeof setTimeout> | undefined;

        parser.on("data", (line: string) => {
          const timestamp = this.project.config.monitor.timestamps
            ? new Date().toISOString().slice(11, 23)
            : undefined;

          buffer += JSON.stringify({ line: line.trimEnd(), timestamp }) + "\n";

          if (!flushTimer) {
            flushTimer = setTimeout(() => {
              if (buffer) {
                this.panel.webview.postMessage({ command: "batch-lines", batch: buffer });
                buffer = "";
              }
              flushTimer = undefined;
            }, 16); // ~60fps
          }
        });
      }

      this.serialPort.on("open", () => {
        this.isConnected = true;
        this.panel.webview.postMessage({
          command: "connected",
          port,
          baud
        });
      });

      this.serialPort.on("close", () => {
        this.isConnected = false;
        this.panel.webview.postMessage({ command: "disconnected" });
        // Auto-reconnect after device reset
        this.scheduleReconnect(port, baud);
      });

      this.serialPort.on("error", (err: Error) => {
        this.panel.webview.postMessage({ command: "error", message: err.message });
        this.scheduleReconnect(port, baud);
      });
    } catch (err) {
      this.panel.webview.postMessage({
        command: "error",
        message: `Failed to open ${port}: ${String(err)}`
      });
    }
  }

  private async disconnect(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    this.defmtPipe?.stop();
    this.defmtPipe = undefined;
    this.defmtDecoder?.stop();
    this.defmtDecoder = undefined;

    if (this.serialPort?.isOpen) {
      await new Promise<void>((resolve) => {
        this.serialPort!.close(() => resolve());
      });
    }
    this.serialPort = undefined;
    this.isConnected = false;
  }

  private async send(data: string): Promise<void> {
    if (!this.serialPort?.isOpen) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      this.serialPort!.write(data + "\r\n", (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  private async changeBaud(baud: number): Promise<void> {
    if (this.serialPort?.isOpen) {
      await new Promise<void>((resolve) => {
        this.serialPort!.update({ baudRate: baud }, () => resolve());
      });
      this.currentBaud = baud;
      this.panel.webview.postMessage({ command: "baud-changed", baud });
    }
  }

  private async scanPorts(): Promise<void> {
    const scanner = new PortScanner(vscode.window.createOutputChannel("ESP Forge"));
    const ports = await scanner.scan();
    this.panel.webview.postMessage({ command: "ports-scanned", ports });
  }

  private async openFile(file: string, line: number): Promise<void> {
    const filePath = path.isAbsolute(file)
      ? file
      : path.join(this.project.rootPath, file);

    if (fs.existsSync(filePath)) {
      const doc = await vscode.workspace.openTextDocument(filePath);
      await vscode.window.showTextDocument(doc, {
        selection: new vscode.Range(line - 1, 0, line - 1, 0)
      });
    }
  }

  private async saveLog(content: string): Promise<void> {
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file("serial-log.txt"),
      filters: { "Log Files": ["txt", "log"], "All Files": ["*"] }
    });
    if (uri) {
      await fs.promises.writeFile(uri.fsPath, content, "utf8");
      vscode.window.showInformationMessage(`Log saved to ${uri.fsPath}`);
    }
  }

  private scheduleReconnect(port: string, baud: number): void {
    if (this.reconnectTimer) {
      return;
    }
    this.panel.webview.postMessage({ command: "reconnecting" });
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = undefined;
      await this.connect(port, baud);
    }, 2000);
  }

  private getFallbackHtml(): string {
    return `<!DOCTYPE html><html><body style="background:#1e1e2e;color:#cdd6f4;padding:24px">
      <h2>Serial Monitor</h2><p>UI file not found. Please rebuild the extension.</p>
    </body></html>`;
  }

  private dispose(): void {
    SerialMonitorPanel.currentPanel = undefined;
    this.disconnect();
    this.panel.dispose();
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
  }
}

interface SerialMessage {
  command: "connect" | "disconnect" | "send" | "change-baud" | "scan-ports" | "open-file" | "save-log";
  port?: string;
  baud?: number;
  data?: string;
  file?: string;
  line?: number;
}
