import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";

export class ComponentBrowserPanel {
  public static currentPanel: ComponentBrowserPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  public static createOrShow(context: vscode.ExtensionContext): void {
    const column = vscode.ViewColumn.One;
    if (ComponentBrowserPanel.currentPanel) {
      ComponentBrowserPanel.currentPanel.panel.reveal(column);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "espforge.componentBrowser",
      "ESP Forge: Component Browser",
      column,
      { enableScripts: true, localResourceRoots: [context.extensionUri], retainContextWhenHidden: true }
    );
    ComponentBrowserPanel.currentPanel = new ComponentBrowserPanel(panel, context);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext
  ) {
    this.panel = panel;
    const htmlPath = path.join(context.extensionPath, "src", "webviews", "componentBrowser", "ui.html");
    try {
      this.panel.webview.html = fs.readFileSync(htmlPath, "utf8");
    } catch {
      this.panel.webview.html = "<h1>Component Browser</h1>";
    }

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.panel.webview.onDidReceiveMessage(
      async (msg: ComponentMessage) => {
        switch (msg.command) {
          case "search-idf":
            await this.searchIdfComponents(msg.query ?? "");
            break;
          case "search-crates":
            await this.searchCrates(msg.query ?? "");
            break;
          case "add-to-cargo":
            await this.addToCargo(msg.name ?? "", msg.version ?? "");
            break;
          case "add-to-idf":
            await this.addToIdfComponents(msg.name ?? "", msg.version ?? "");
            break;
        }
      },
      null,
      this.disposables
    );
  }

  private async searchIdfComponents(query: string): Promise<void> {
    try {
      const url = `https://components.espressif.com/api/search/?q=${encodeURIComponent(query)}&page=1&per_page=20`;
      const { default: fetch } = await import("node-fetch");
      const response = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(10000)
      });
      if (response.ok) {
        const data = await response.json() as IdfSearchResult;
        this.panel.webview.postMessage({ command: "idf-results", results: data.results ?? [] });
      } else {
        this.panel.webview.postMessage({ command: "idf-error", message: "Search failed" });
      }
    } catch (err) {
      this.panel.webview.postMessage({ command: "idf-error", message: String(err) });
    }
  }

  private async searchCrates(query: string): Promise<void> {
    try {
      const url = `https://crates.io/api/v1/crates?q=${encodeURIComponent(query + " esp")}&per_page=20&sort=downloads`;
      const { default: fetch } = await import("node-fetch");
      const response = await fetch(url, {
        headers: {
          Accept: "application/json",
          "User-Agent": "ESP Forge VS Code Extension (github.com/esp-forge)"
        },
        signal: AbortSignal.timeout(10000)
      });
      if (response.ok) {
        const data = await response.json() as CratesSearchResult;
        this.panel.webview.postMessage({ command: "crates-results", results: data.crates ?? [] });
      } else {
        this.panel.webview.postMessage({ command: "crates-error", message: "Search failed" });
      }
    } catch (err) {
      this.panel.webview.postMessage({ command: "crates-error", message: String(err) });
    }
  }

  private async addToCargo(name: string, version: string): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
      vscode.window.showErrorMessage("No workspace folder open.");
      return;
    }

    const cargoPath = path.join(workspaceFolders[0]!.uri.fsPath, "Cargo.toml");
    if (!fs.existsSync(cargoPath)) {
      vscode.window.showErrorMessage("No Cargo.toml found in workspace root.");
      return;
    }

    let content = fs.readFileSync(cargoPath, "utf8");
    const dep = `${name} = "${version}"`;

    if (content.includes(`[dependencies]`)) {
      content = content.replace("[dependencies]", `[dependencies]\n${dep}`);
    } else {
      content += `\n[dependencies]\n${dep}\n`;
    }

    fs.writeFileSync(cargoPath, content, "utf8");
    vscode.window.showInformationMessage(`Added ${name} = "${version}" to Cargo.toml`);
    this.panel.webview.postMessage({ command: "added", name });
  }

  private async addToIdfComponents(name: string, version: string): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
      vscode.window.showErrorMessage("No workspace folder open.");
      return;
    }

    const compPath = path.join(workspaceFolders[0]!.uri.fsPath, "idf_component.yml");
    let content = "";

    if (fs.existsSync(compPath)) {
      content = fs.readFileSync(compPath, "utf8");
    } else {
      content = "dependencies:\n";
    }

    const dep = `  ${name}:\n    version: "${version}"\n`;
    if (!content.includes(name)) {
      content += dep;
      fs.writeFileSync(compPath, content, "utf8");
      vscode.window.showInformationMessage(`Added ${name} to idf_component.yml`);
    } else {
      vscode.window.showInformationMessage(`${name} is already in idf_component.yml`);
    }
    this.panel.webview.postMessage({ command: "added", name });
  }

  private dispose(): void {
    ComponentBrowserPanel.currentPanel = undefined;
    this.panel.dispose();
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
  }
}

export class PartitionEditorPanel {
  public static createOrShow(
    context: vscode.ExtensionContext,
    project: { rootPath: string }
  ): void {
    const panel = vscode.window.createWebviewPanel(
      "espforge.partitionEditor",
      "ESP Forge: Partition Table",
      vscode.ViewColumn.One,
      { enableScripts: true }
    );

    const csvPath = path.join(project.rootPath, "partitions.csv");
    let partitions: Partition[] = [];

    if (fs.existsSync(csvPath)) {
      partitions = parsePartitionsCsv(csvPath);
    } else {
      partitions = getDefaultPartitions();
    }

    panel.webview.html = buildPartitionEditorHtml(partitions);

    panel.webview.onDidReceiveMessage(async (msg: PartitionEditorMessage) => {
      if (msg.command === "save") {
        const csv = serializePartitions(msg.partitions ?? []);
        await fs.promises.writeFile(csvPath, csv, "utf8");
        vscode.window.showInformationMessage("partitions.csv saved.");
      }
    });
  }
}

function parsePartitionsCsv(csvPath: string): Partition[] {
  const lines = fs.readFileSync(csvPath, "utf8").split("\n");
  return lines
    .filter((l) => l.trim() && !l.startsWith("#"))
    .map((l) => {
      const parts = l.split(",").map((p) => p.trim());
      return {
        name: parts[0] ?? "",
        type: parts[1] ?? "app",
        subtype: parts[2] ?? "factory",
        offset: parts[3] ?? "",
        size: parts[4] ?? ""
      };
    });
}

function getDefaultPartitions(): Partition[] {
  return [
    { name: "nvs", type: "data", subtype: "nvs", offset: "0x9000", size: "0x6000" },
    { name: "phy_init", type: "data", subtype: "phy", offset: "0xF000", size: "0x1000" },
    { name: "factory", type: "app", subtype: "factory", offset: "0x10000", size: "1M" },
    { name: "storage", type: "data", subtype: "spiffs", offset: "0x110000", size: "1M" }
  ];
}

function serializePartitions(partitions: Partition[]): string {
  const header = "# ESP-IDF Partition Table\n# Name, Type, SubType, Offset, Size\n";
  const rows = partitions
    .map((p) => `${p.name}, ${p.type}, ${p.subtype}, ${p.offset}, ${p.size}`)
    .join("\n");
  return header + rows + "\n";
}

function buildPartitionEditorHtml(partitions: Partition[]): string {
  const rows = partitions
    .map(
      (p, i) => `<tr>
      <td><input class="cell-input" value="${p.name}" onchange="updatePartition(${i}, 'name', this.value)"></td>
      <td><select class="cell-select" onchange="updatePartition(${i}, 'type', this.value)">
        <option ${p.type === "app" ? "selected" : ""}>app</option>
        <option ${p.type === "data" ? "selected" : ""}>data</option>
      </select></td>
      <td><input class="cell-input" value="${p.subtype}" onchange="updatePartition(${i}, 'subtype', this.value)"></td>
      <td><input class="cell-input" value="${p.offset}" onchange="updatePartition(${i}, 'offset', this.value)"></td>
      <td><input class="cell-input" value="${p.size}" onchange="updatePartition(${i}, 'size', this.value)"></td>
      <td><button class="btn-del" onclick="deleteRow(${i})">✕</button></td>
    </tr>`
    )
    .join("\n");

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Partition Editor</title>
<style>
  body { background:#1e1e2e; color:#cdd6f4; font-family:'Segoe UI',sans-serif; padding:24px; }
  h1 { color:#89b4fa; margin-bottom:16px; }
  table { width:100%; border-collapse:collapse; }
  th { text-align:left; padding:8px 10px; border-bottom:1px solid #45475a; color:#89b4fa; font-size:13px; }
  td { padding:6px 8px; border-bottom:1px solid #313244; }
  .cell-input { background:#313244; border:1px solid #45475a; border-radius:4px; color:#cdd6f4; padding:5px 8px; width:100%; font-size:13px; }
  .cell-select { background:#313244; border:1px solid #45475a; border-radius:4px; color:#cdd6f4; padding:5px 8px; font-size:13px; }
  .btn-del { background:rgba(243,139,168,0.15); border:1px solid #f38ba8; color:#f38ba8; border-radius:4px; cursor:pointer; padding:4px 8px; }
  .btn { padding:8px 18px; border:none; border-radius:6px; cursor:pointer; font-size:13px; font-weight:600; margin-top:16px; margin-right:8px; }
  .btn-primary { background:#89b4fa; color:#1e1e2e; }
  .btn-secondary { background:#313244; color:#cdd6f4; }
</style></head>
<body>
<h1>📋 Partition Table Editor</h1>
<table id="partTable">
  <thead><tr><th>Name</th><th>Type</th><th>SubType</th><th>Offset</th><th>Size</th><th></th></tr></thead>
  <tbody id="tbody">${rows}</tbody>
</table>
<button class="btn btn-secondary" onclick="addRow()">+ Add Partition</button>
<button class="btn btn-primary" onclick="save()">💾 Save partitions.csv</button>
<script>
  const vscode = acquireVsCodeApi();
  let partitions = ${JSON.stringify(partitions)};
  function updatePartition(i, key, val) { partitions[i][key] = val; }
  function deleteRow(i) { partitions.splice(i,1); location.reload(); }
  function addRow() { partitions.push({ name:'new_part', type:'data', subtype:'fat', offset:'', size:'1M' }); location.reload(); }
  function save() { vscode.postMessage({ command:'save', partitions }); }
</script>
</body></html>`;
}

interface Partition {
  name: string;
  type: string;
  subtype: string;
  offset: string;
  size: string;
}

interface ComponentMessage {
  command: "search-idf" | "search-crates" | "add-to-cargo" | "add-to-idf";
  query?: string;
  name?: string;
  version?: string;
}

interface PartitionEditorMessage {
  command: "save";
  partitions?: Partition[];
}

interface IdfSearchResult {
  results?: Array<{ name: string; version: string; description: string }>;
}

interface CratesSearchResult {
  crates?: Array<{ name: string; newest_version: string; description: string; downloads: number }>;
}
