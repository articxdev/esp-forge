import * as vscode from "vscode";

// Minimal stub for board and task providers
export class BoardProvider {
  // Board data from espflash board-info
}

export class TaskProvider implements vscode.TaskProvider {
  static TaskType = "espforge";

  provideTasks(): vscode.Task[] {
    const buildTask = new vscode.Task(
      { type: TaskProvider.TaskType, task: "build" },
      vscode.TaskScope.Workspace,
      "Build",
      "ESP Forge",
      new vscode.ShellExecution("cargo build --message-format=json"),
      ["$espflash"]
    );

    const flashTask = new vscode.Task(
      { type: TaskProvider.TaskType, task: "flash" },
      vscode.TaskScope.Workspace,
      "Flash",
      "ESP Forge",
      new vscode.ShellExecution("cargo espflash flash"),
      ["$espflash"]
    );

    return [buildTask, flashTask];
  }

  resolveTask(task: vscode.Task): vscode.Task {
    return task;
  }
}
