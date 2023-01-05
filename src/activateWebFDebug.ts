'ust strict';

import * as vscode from 'vscode';
import { QuickJSDebugSession } from './quickjsDebug';

class WebFConfigurationProvider implements vscode.DebugConfigurationProvider {
  resolveDebugConfiguration(folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration, token?: vscode.CancellationToken | undefined): vscode.ProviderResult<vscode.DebugConfiguration> {
    return config;
  }
}

class InlineDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {
	createDebugAdapterDescriptor(_session: vscode.DebugSession): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
		return new vscode.DebugAdapterInlineImplementation(new QuickJSDebugSession());
	}
}

export function activateWebFDebug(context: vscode.ExtensionContext, factory?: vscode.DebugAdapterDescriptorFactory) {
  // register a configuration provider for 'webf' debug type
	const provider = new WebFConfigurationProvider();
	context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('webf', provider));

  if (!factory) {
		factory = new InlineDebugAdapterFactory();
	}
	context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory('webf', factory));
}