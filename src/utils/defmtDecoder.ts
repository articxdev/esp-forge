import * as vscode from "vscode";
import * as cp from "child_process";

export type DefmtLevel = "ERROR" | "WARN" | "INFO" | "DEBUG" | "TRACE";

export interface DefmtFrame {
  level: DefmtLevel;
  message: string;
  file?: string;
  line?: number;
  timestamp?: number;
}

const LEVEL_COLORS: Record<DefmtLevel, string> = {
  ERROR: "#f38ba8",
  WARN: "#f9e2af",
  INFO: "#89dceb",
  DEBUG: "#a6adc8",
  TRACE: "#585b70"
};

export class DefmtDecoder {
  private defmtProcess: cp.ChildProcess | undefined;
  private readonly output: vscode.OutputChannel;

  constructor(output: vscode.OutputChannel) {
    this.output = output;
  }

  /** Check if the project uses defmt */
  static projectUsesDefmt(cargoTomlContent: string): boolean {
    return cargoTomlContent.includes("defmt");
  }

  /** Start defmt-print subprocess and pipe raw bytes into it */
  startDecoding(
    elfPath: string,
    onFrame: (frame: DefmtFrame) => void
  ): { write: (data: Buffer) => void; stop: () => void } {
    try {
      this.defmtProcess = cp.spawn("defmt-print", ["-e", elfPath], {
        stdio: ["pipe", "pipe", "pipe"]
      });

      this.defmtProcess.stdout?.on("data", (chunk: Buffer) => {
        const lines = chunk.toString().split("\n");
        for (const line of lines) {
          const frame = this.parseLine(line);
          if (frame) {
            onFrame(frame);
          }
        }
      });

      this.defmtProcess.stderr?.on("data", (chunk: Buffer) => {
        this.output.appendLine(`[defmt] ${chunk.toString()}`);
      });

      this.defmtProcess.on("error", (err) => {
        this.output.appendLine(`[defmt] Process error: ${err.message}`);
      });

      return {
        write: (data: Buffer) => {
          this.defmtProcess?.stdin?.write(data);
        },
        stop: () => this.stop()
      };
    } catch (err) {
      this.output.appendLine(`[defmt] Failed to start defmt-print: ${String(err)}`);
      return {
        write: () => { /* noop */ },
        stop: () => { /* noop */ }
      };
    }
  }

  stop(): void {
    if (this.defmtProcess) {
      this.defmtProcess.kill();
      this.defmtProcess = undefined;
    }
  }

  private parseLine(line: string): DefmtFrame | undefined {
    if (!line.trim()) {
      return undefined;
    }

    // defmt-print output format: "ERROR|WARN|INFO|DEBUG|TRACE timestamp message @ file:line"
    const levelMatch = /^(ERROR|WARN|INFO|DEBUG|TRACE)\s+(.+)/.exec(line);
    if (!levelMatch) {
      return undefined;
    }

    const level = levelMatch[1] as DefmtLevel;
    let rest = levelMatch[2] ?? "";

    // Parse location hint "@ file.rs:42"
    let file: string | undefined;
    let lineNum: number | undefined;
    const locationMatch = /@\s+(\S+):(\d+)$/.exec(rest);
    if (locationMatch) {
      file = locationMatch[1];
      lineNum = parseInt(locationMatch[2] ?? "0", 10);
      rest = rest.slice(0, locationMatch.index).trim();
    }

    return { level, message: rest, file, line: lineNum };
  }

  /** Convert a DefmtFrame to HTML for webview display */
  static frameToHtml(frame: DefmtFrame): string {
    const color = LEVEL_COLORS[frame.level];
    const level = frame.level.padEnd(5);
    let locationHtml = "";

    if (frame.file && frame.line) {
      locationHtml = `<span class="defmt-location" data-file="${frame.file}" data-line="${frame.line}" 
        style="cursor:pointer;text-decoration:underline;color:#89b4fa;font-size:11px;margin-left:8px"
        onclick="openFile('${frame.file}', ${frame.line})">
        ${frame.file}:${frame.line}
      </span>`;
    }

    return `<div class="defmt-line" style="display:flex;align-items:baseline;gap:8px;margin:2px 0">
      <span style="color:${color};font-weight:700;font-family:monospace;font-size:12px;min-width:45px">${level}</span>
      <span style="color:#cdd6f4;font-family:monospace;font-size:13px;flex:1">${escapeHtml(frame.message)}</span>
      ${locationHtml}
    </div>`;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
