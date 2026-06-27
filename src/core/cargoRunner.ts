import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { ProcessRunner } from "../utils/processRunner";
import { CHIP_TARGET_MAP, type EspProject } from "./projectManager";

interface CargoDiagnostic {
  message: {
    message: string;
    level: "error" | "warning" | "note" | "help" | "failure-note";
    spans: Array<{
      file_name: string;
      line_start: number;
      line_end: number;
      column_start: number;
      column_end: number;
      label?: string;
      is_primary: boolean;
    }>;
    children: Array<{
      message: string;
      level: string;
      spans: Array<{
        file_name: string;
        line_start: number;
        line_end: number;
        column_start: number;
        column_end: number;
      }>;
      suggestion_applicability?: string;
    }>;
    code?: { code: string; explanation?: string };
    rendered?: string;
  };
  reason: "compiler-message";
  package_id: string;
  target: { name: string; src_path: string };
}

interface CargoBuildArtifact {
  reason: "compiler-artifact";
  package_id: string;
  target: { name: string; kind: string[] };
  profile: { opt_level: string; debug_info: number };
  filenames: string[];
}

interface CargoBuildScript {
  reason: "build-script-executed";
  package_id: string;
  out_dir: string;
}

type CargoJsonLine = CargoDiagnostic | CargoBuildArtifact | CargoBuildScript | { reason: string };

export class CargoRunner {
  private readonly diagnosticCollection: vscode.DiagnosticCollection;
  private readonly runner: ProcessRunner;
  private checkDebounceTimer: ReturnType<typeof setTimeout> | undefined;
  private cancelToken: vscode.CancellationTokenSource | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel
  ) {
    this.diagnosticCollection = vscode.languages.createDiagnosticCollection("espforge");
    context.subscriptions.push(this.diagnosticCollection);
    this.runner = new ProcessRunner(output);
  }

  async build(project: EspProject): Promise<void> {
    const target = CHIP_TARGET_MAP[project.config.project.chip];
    const args = [
      "build",
      "--target",
      target,
      "--message-format=json"
    ];

    if (project.config.build.profile === "release") {
      args.push("--release");
    }

    if (project.config.build.features.length > 0) {
      args.push("--features", project.config.build.features.join(","));
    }

    const env = await this.buildEnv(project);

    this.diagnosticCollection.clear();

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `ESP Forge: Building ${project.config.project.name}...`,
        cancellable: true
      },
      async (progress, token) => {
        let artifactCount = 0;

        await this.runner.runStreaming(
          "cargo",
          args,
          { cwd: project.rootPath, env },
          (line) => {
            if (!line.startsWith("{")) {
              return;
            }
            try {
              const json = JSON.parse(line) as CargoJsonLine;
              this.handleCargoLine(json, project, progress);
              if (json.reason === "compiler-artifact") {
                artifactCount++;
                progress.report({ message: `Compiled ${artifactCount} crate(s)` });
              }
            } catch {
              // Not JSON, skip
            }
          },
          token
        );
      }
    );
  }

  async check(project: EspProject): Promise<void> {
    const target = CHIP_TARGET_MAP[project.config.project.chip];
    const args = [
      "check",
      "--target",
      target,
      "--message-format=json"
    ];

    if (project.config.build.features.length > 0) {
      args.push("--features", project.config.build.features.join(","));
    }

    const env = await this.buildEnv(project);
    this.diagnosticCollection.clear();

    await this.runner.runStreaming(
      "cargo",
      args,
      { cwd: project.rootPath, env },
      (line) => {
        if (!line.startsWith("{")) {
          return;
        }
        try {
          const json = JSON.parse(line) as CargoJsonLine;
          this.handleCargoLine(json, project, undefined);
        } catch { /* skip */ }
      }
    );
  }

  checkDebounced(project: EspProject): void {
    if (this.checkDebounceTimer) {
      clearTimeout(this.checkDebounceTimer);
    }

    const debounceMs = vscode.workspace
      .getConfiguration("espforge")
      .get<number>("checkDebounceMs", 500);

    this.checkDebounceTimer = setTimeout(() => {
      // Cancel any previous check
      this.cancelToken?.cancel();
      this.cancelToken = new vscode.CancellationTokenSource();
      this.check(project).catch((err) => {
        this.output.appendLine(`[CargoRunner] Check failed: ${String(err)}`);
      });
    }, debounceMs);
  }

  async clean(project: EspProject): Promise<void> {
    const env = await this.buildEnv(project);
    await this.runner.runStreaming(
      "cargo",
      ["clean"],
      { cwd: project.rootPath, env },
      (line) => this.output.appendLine(line)
    );
    this.diagnosticCollection.clear();
  }

  private handleCargoLine(
    json: CargoJsonLine,
    project: EspProject,
    progress: vscode.Progress<{ message?: string; increment?: number }> | undefined
  ): void {
    if (json.reason === "compiler-message") {
      const diag = json as CargoDiagnostic;
      this.handleCompilerMessage(diag, project);
    } else if (json.reason === "build-script-executed") {
      const script = json as CargoBuildScript;
      const pkgName = script.package_id.split(" ")[0] ?? "unknown";
      progress?.report({ message: `IDF: compiling ${pkgName}...` });
    }
  }

  private handleCompilerMessage(diag: CargoDiagnostic, project: EspProject): void {
    const msg = diag.message;
    if (!msg || !msg.spans || msg.spans.length === 0) {
      return;
    }

    const primarySpan = msg.spans.find((s) => s.is_primary) ?? msg.spans[0];
    if (!primarySpan) {
      return;
    }

    const filePath = path.isAbsolute(primarySpan.file_name)
      ? primarySpan.file_name
      : path.join(project.rootPath, primarySpan.file_name);

    if (!fs.existsSync(filePath)) {
      return;
    }

    const uri = vscode.Uri.file(filePath);
    const range = new vscode.Range(
      new vscode.Position(primarySpan.line_start - 1, primarySpan.column_start - 1),
      new vscode.Position(primarySpan.line_end - 1, primarySpan.column_end - 1)
    );

    const severity = this.mapSeverity(msg.level);
    const diagnostic = new vscode.Diagnostic(range, msg.message, severity);
    diagnostic.source = "ESP Forge (cargo)";

    if (msg.code) {
      diagnostic.code = {
        value: msg.code.code,
        target: vscode.Uri.parse(
          `https://doc.rust-lang.org/error_codes/${msg.code.code}.html`
        )
      };
    }

    // Related information from spans
    const relatedInfo: vscode.DiagnosticRelatedInformation[] = [];
    for (const span of msg.spans) {
      if (!span.is_primary && span.label) {
        const spanPath = path.isAbsolute(span.file_name)
          ? span.file_name
          : path.join(project.rootPath, span.file_name);
        if (fs.existsSync(spanPath)) {
          relatedInfo.push(
            new vscode.DiagnosticRelatedInformation(
              new vscode.Location(
                vscode.Uri.file(spanPath),
                new vscode.Range(
                  new vscode.Position(span.line_start - 1, span.column_start - 1),
                  new vscode.Position(span.line_end - 1, span.column_end - 1)
                )
              ),
              span.label
            )
          );
        }
      }
    }

    // Children (fixes, notes)
    for (const child of msg.children ?? []) {
      if (child.message && child.spans.length > 0) {
        const childSpan = child.spans[0];
        if (childSpan) {
          const childPath = path.isAbsolute(childSpan.file_name)
            ? childSpan.file_name
            : path.join(project.rootPath, childSpan.file_name);
          if (fs.existsSync(childPath)) {
            relatedInfo.push(
              new vscode.DiagnosticRelatedInformation(
                new vscode.Location(
                  vscode.Uri.file(childPath),
                  new vscode.Range(
                    new vscode.Position(childSpan.line_start - 1, childSpan.column_start - 1),
                    new vscode.Position(childSpan.line_end - 1, childSpan.column_end - 1)
                  )
                ),
                `${child.level}: ${child.message}`
              )
            );
          }
        }
      }
    }

    diagnostic.relatedInformation = relatedInfo;

    const existing = this.diagnosticCollection.get(uri) ?? [];
    this.diagnosticCollection.set(uri, [...existing, diagnostic]);
  }

  private mapSeverity(level: string): vscode.DiagnosticSeverity {
    switch (level) {
      case "error":
        return vscode.DiagnosticSeverity.Error;
      case "warning":
        return vscode.DiagnosticSeverity.Warning;
      case "note":
      case "help":
        return vscode.DiagnosticSeverity.Information;
      default:
        return vscode.DiagnosticSeverity.Hint;
    }
  }

  private async buildEnv(project: EspProject): Promise<Record<string, string>> {
    const baseEnv: Record<string, string> = {};
    Object.entries(process.env).forEach(([k, v]) => {
      if (v !== undefined) baseEnv[k] = v;
    });

    // Merge env.json
    try {
      const envPath = path.join(require("os").homedir(), ".espforge", "env.json");
      if (fs.existsSync(envPath)) {
        const stored = JSON.parse(fs.readFileSync(envPath, "utf8")) as Record<string, string>;
        Object.assign(baseEnv, stored);
      }
    } catch { /* ignore */ }

    baseEnv["ESP_IDF_VERSION"] = project.config.idf.version;

    if (project.config.build.features.length > 0) {
      baseEnv["ESPFORGE_FEATURES"] = project.config.build.features.join(",");
    }

    return baseEnv;
  }
}
