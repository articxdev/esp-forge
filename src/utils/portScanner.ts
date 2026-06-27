import * as vscode from "vscode";

export interface SerialPortInfo {
  path: string;
  manufacturer?: string;
  serialNumber?: string;
  vendorId?: string;
  productId?: string;
}

export class PortScanner {
  constructor(private readonly output: vscode.OutputChannel) {}

  async scan(): Promise<SerialPortInfo[]> {
    try {
      const { SerialPort } = await import("serialport");
      const ports = await SerialPort.list();

      this.output.appendLine(`[PortScanner] Found ${ports.length} serial port(s)`);

      return ports.map((p) => ({
        path: p.path,
        manufacturer: p.manufacturer,
        serialNumber: p.serialNumber,
        vendorId: p.vendorId,
        productId: p.productId
      }));
    } catch (err) {
      this.output.appendLine(`[PortScanner] Error listing ports: ${String(err)}`);
      return [];
    }
  }

  /** Filter ports to only those matching known ESP32 VIDs */
  async scanESP32Only(): Promise<SerialPortInfo[]> {
    const ESP32_VIDS = ["303a", "1a86", "10c4", "0403"];
    const all = await this.scan();
    return all.filter((p) => {
      const vid = (p.vendorId ?? "").toLowerCase().replace(/^0x/, "");
      return ESP32_VIDS.includes(vid);
    });
  }
}
