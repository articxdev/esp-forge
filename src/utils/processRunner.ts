import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
}

export class ProcessRunner {
  constructor(private readonly output: vscode.OutputChannel) {}

  /**
   * Run a process silently and return its output.
   * Throws on non-zero exit code.
   */
  async runSilent(cmd: string, args: string[], opts?: RunOptions): Promise<RunResult> {
    const { execa } = await import("execa");
    const env = await this.buildEnv(opts?.env);

    try {
      const result = await execa(cmd, args, {
        cwd: opts?.cwd,
        env,
        reject: false,
        all: true
      });

      if (result.exitCode !== 0) {
        throw new Error(
          `${cmd} exited with code ${result.exitCode}: ${result.stderr ?? result.stdout}`
        );
      }

      return {
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        exitCode: result.exitCode ?? 0
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(
          `Command not found: "${cmd}". Make sure it is installed and on your PATH.`
        );
      }
      throw err;
    }
  }

  /**
   * Run a process and stream output line by line to a callback.
   * Also writes to the output channel.
   */
  async runStreaming(
    cmd: string,
    args: string[],
    opts: RunOptions,
    onLine: (line: string) => void,
    token?: vscode.CancellationToken
  ): Promise<void> {
    const { execa } = await import("execa");
    const env = await this.buildEnv(opts.env);

    this.output.appendLine(`> ${cmd} ${args.join(" ")}`);

    const child = execa(cmd, args, {
      cwd: opts.cwd,
      env,
      all: true,
      reject: false
    });

    // Handle cancellation
    if (token) {
      const disposable = token.onCancellationRequested(() => {
        child.kill("SIGTERM");
      });

      child.then(() => disposable.dispose()).catch(() => disposable.dispose());
    }

    // Stream stdout
    if (child.stdout) {
      child.stdout.on("data", (chunk: Buffer) => {
        const lines = chunk.toString().split(/\r?\n/);
        for (const line of lines) {
          if (line.trim()) {
            this.output.appendLine(line);
            onLine(line);
          }
        }
      });
    }

    // Stream stderr
    if (child.stderr) {
      child.stderr.on("data", (chunk: Buffer) => {
        const lines = chunk.toString().split(/\r?\n/);
        for (const line of lines) {
          if (line.trim()) {
            this.output.appendLine(`[stderr] ${line}`);
            onLine(line);
          }
        }
      });
    }

    const result = await child;

    if (token?.isCancellationRequested) {
      throw new vscode.CancellationError();
    }

    if (result.exitCode !== 0) {
      const errMsg = `${cmd} failed with exit code ${result.exitCode}`;
      this.output.appendLine(`[ProcessRunner] ERROR: ${errMsg}`);
      throw new Error(errMsg);
    }

    this.output.appendLine(`[ProcessRunner] ${cmd} completed successfully.`);
  }

  private async buildEnv(
    additionalEnv?: Record<string, string>
  ): Promise<Record<string, string>> {
    const base: Record<string, string> = {};

    // Copy current process env
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) {
        base[k] = v;
      }
    }

    // Load ~/.espforge/env.json
    const envJsonPath = path.join(os.homedir(), ".espforge", "env.json");
    if (fs.existsSync(envJsonPath)) {
      try {
        const stored = JSON.parse(
          await fs.promises.readFile(envJsonPath, "utf8")
        ) as Record<string, string>;
        Object.assign(base, stored);
      } catch { /* ignore */ }
    }

    // Ensure cargo bin is on PATH
    const cargoBin = path.join(os.homedir(), ".cargo", "bin");
    const currentPath = base["PATH"] ?? "";
    if (!currentPath.includes(cargoBin)) {
      base["PATH"] = `${cargoBin}${path.delimiter}${currentPath}`;
    }

    // Apply caller-provided env last
    if (additionalEnv) {
      Object.assign(base, additionalEnv);
    }

    return base;
  }
}
