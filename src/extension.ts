// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { spawn, spawnSync } from 'child_process';
import { activateWebFDebug } from './activateWebFDebug';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
  activateWebFDebug(context);

  checkWebFCommand();
}

async function checkWebFCommand() {
  let result = spawnSync('type', ['webf'], { encoding: 'utf-8' });
  if (result.status !== 0) {
    const selection = await vscode.window.showWarningMessage('The `webf` command not found on PATH.', 'Install it for me', 'Ignore');
    if (selection === 'Install it for me') {
      vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "Installing..",
        cancellable: true
      }, (progress, token) => {
        const installer = spawn('npm', ['install', '-g', '@openwebf/cli'], { stdio: 'inherit' });
        token.onCancellationRequested(() => {
          installer.kill();
        });

        progress.report({ increment: 0 });

        setTimeout(() => {
          progress.report({ increment: 10});
        }, 1000);

        setTimeout(() => {
          progress.report({ increment: 40});
        }, 2000);

        const p = new Promise<void>(resolve => {
          installer.on('exit', () => {
            resolve();
          });
        });
        return p;
      });
    }
  }
}


// This method is called when your extension is deactivated
export function deactivate() { }
