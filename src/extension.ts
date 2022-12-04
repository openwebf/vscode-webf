// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { activateWebFDebug } from './activateWebFDebug';

let debugStatusItem: vscode.StatusBarItem;
// let isDebuggering = false;

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
	activateWebFDebug(context);

  // register a command that is invoked when the status bar
	// item is selected
	const myCommandId = 'webf.runDebug';
	context.subscriptions.push(vscode.commands.registerCommand(myCommandId, () => {
    console.log('run debug..');
    // isDebuggering = true;
	}));

  // create a new status bar item that we can now manage
	debugStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
	debugStatusItem.command = myCommandId;
  debugStatusItem.text = 'Debug WebF';
	context.subscriptions.push(debugStatusItem);

  // register some listener that make sure the status bar 
	// item always up-to-date
	context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(updateStatusBarItem));
	context.subscriptions.push(vscode.window.onDidChangeTextEditorSelection(updateStatusBarItem));

  debugStatusItem.show();
}

function updateStatusBarItem(): void {
	// isDebuggering = true;
  debugStatusItem.text = 'debugging..';
}


// This method is called when your extension is deactivated
export function deactivate() {}
