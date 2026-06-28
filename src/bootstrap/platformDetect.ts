import * as os from "os";
import * as fs from "fs";
import * as path from "path";

export interface PlatformInfo {
  isWindows: boolean;
  isMacOS: boolean;
  isLinux: boolean;
  platform: NodeJS.Platform;
  arch: string;
  homedir: string;
  /** Only set on Linux — detected from /etc/os-release */
  linuxDistro?: string;
  /** Shell to use for sourcing env files */
  shell: string;
  /** Path separator character */
  sep: string;
  /** Newline character sequence */
  newline: string;
  /** Extension for executable files */
  exeExt: string;
  /** Prefix for environment variable expansion in shell */
  envVarPrefix: string;
}

export function getPlatformInfo(): PlatformInfo {
  const platform = os.platform();
  const isWindows = platform === "win32";
  const isMacOS = platform === "darwin";
  const isLinux = platform === "linux";

  return {
    isWindows,
    isMacOS,
    isLinux,
    platform,
    arch: os.arch(),
    homedir: os.homedir(),
    linuxDistro: isLinux ? detectLinuxDistro() : undefined,
    shell: isWindows ? "powershell.exe" : (process.env["SHELL"] ?? "/bin/bash"),
    sep: path.sep,
    newline: isWindows ? "\r\n" : "\n",
    exeExt: isWindows ? ".exe" : "",
    envVarPrefix: isWindows ? "$env:" : "$"
  };
}

function detectLinuxDistro(): string {
  const osReleasePath = "/etc/os-release";
  if (!fs.existsSync(osReleasePath)) {
    return "unknown";
  }

  try {
    const content = fs.readFileSync(osReleasePath, "utf8");
    const idLine = content
      .split("\n")
      .find((l) => l.startsWith("ID=") || l.startsWith("ID_LIKE="));
    if (!idLine) {
      return "unknown";
    }
    return idLine.split("=")[1]?.toLowerCase().replace(/"/g, "") ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** Returns the platform-appropriate espup export file path */
export function getEspupExportPath(): string {
  const platform = getPlatformInfo();
  if (platform.isWindows) {
    return path.join(os.homedir(), "export-esp.ps1");
  }
  return path.join(os.homedir(), "export-esp.sh");
}

/** Returns environment variables that should be injected for ESP32 builds */
export function getEspEnvironment(): Record<string, string> {
  const platform = getPlatformInfo();
  const env: Record<string, string> = {};

  // Forward all current env vars
  Object.assign(env, process.env);

  // Find the actual PATH key (Windows may use "Path" instead of "PATH")
  let pathKey = "PATH";
  if (platform.isWindows) {
    for (const key of Object.keys(env)) {
      if (key.toUpperCase() === "PATH") {
        pathKey = key;
        break;
      }
    }
  }

  // Ensure cargo bin is on PATH
  const cargoBin = path.join(os.homedir(), ".cargo", "bin");
  const currentPath = env[pathKey] ?? "";
  if (!currentPath.includes(cargoBin)) {
    env[pathKey] = `${cargoBin}${path.delimiter}${currentPath}`;
  }

  // Windows: also add rustup toolchains
  if (platform.isWindows) {
    const rustupToolchains = path.join(
      os.homedir(),
      ".rustup",
      "toolchains",
      "esp",
      "bin"
    );
    if (!(env[pathKey] ?? "").includes(rustupToolchains)) {
      env[pathKey] = `${rustupToolchains}${path.delimiter}${env[pathKey] ?? ""}`;
    }
  }

  return env;
}
