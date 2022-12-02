// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { CancellationToken, DebugConfiguration, ProviderResult, WorkspaceFolder } from 'vscode';

class WebFConfigurationProvider implements vscode.DebugConfigurationProvider {
	/**
	 * Massage a debug configuration just before a debug session is being launched,
	 * e.g. add all missing attributes to the debug configuration.
	 */
	resolveDebugConfiguration(folder: WorkspaceFolder | undefined, config: DebugConfiguration, token?: CancellationToken): ProviderResult<DebugConfiguration> {
		return config;
	}
}


// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
	context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider("WebF", new WebFConfigurationProvider()));
}

// This method is called when your extension is deactivated
export function deactivate() {}
