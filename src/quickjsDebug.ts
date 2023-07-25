// import * as CP from 'child_process';
import * as WebSocket from 'websocket';
import * as vscode from 'vscode';
import * as path from 'path';
import { spawn, ChildProcess, execSync } from 'child_process';
import { InitializedEvent, Logger, logger, OutputEvent, Scope, Source, StackFrame, StoppedEvent, Thread, ThreadEvent } from 'vscode-debugadapter';
import { DebugProtocol } from 'vscode-debugprotocol';
import { LoggingDebugSession } from 'vscode-debugadapter';
// const Parser = require('stream-parser');
// const Transform = require('stream').Transform

let _seq = 0;

interface LaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
  name: string;
  program?: string;
  url?: string;
}
interface AttachRequestArguments extends DebugProtocol.AttachRequestArguments {
  name: string;
  port?: number;
  host?: string;
}

interface PendingResponse {
  resolve: Function;
  reject: Function;
}

function replacePath(oldPath: string) {
  return oldPath.replace('webpack://app', vscode.workspace.rootPath ?? '').replace(/\?\w+/, '');
}

export class QuickJSDebugSession extends LoggingDebugSession {
  private static RUNINTERMINAL_TIMEOUT = 5000;
  private static REMOTE_DEBUGGING_PORT = 9222;

  private _webfApp?: ChildProcess;
  private _remoteClient?: WebSocket.client;
  private _wsConnection?: WebSocket.connection;
  private _pendingMessages: any[] = [];
  private _requests = new Map<number, PendingResponse>();
  private _breakpoints = new Map<string, DebugProtocol.BreakpointLocation[]>();

  public constructor() {
    super("quickjs-debug.txt");

    this.setDebuggerLinesStartAt1(true);
    this.setDebuggerColumnsStartAt1(true);
  }

  protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {
    // build and return the capabilities of this debug adapter:
    response.body = response.body || {};

    // make VS Code to use 'evaluate' when hovering over source
    response.body.supportsEvaluateForHovers = true;
    response.body.exceptionBreakpointFilters = [{
      label: "All Exceptions",
      filter: "exceptions",
    }];

    // make VS Code to support data breakpoints
    // response.body.supportsDataBreakpoints = true;

    // make VS Code to support completion in REPL
    response.body.supportsCompletionsRequest = true;
    response.body.completionTriggerCharacters = [".", "["];

    // make VS Code to send cancelRequests
    // response.body.supportsCancelRequest = true;

    // make VS Code send the breakpointLocations request
    // response.body.supportsBreakpointLocationsRequest = true;

    response.body.supportsConfigurationDoneRequest = true;

    response.body.supportsTerminateRequest = true;

    this.sendResponse(response);

    this.sendEvent(new InitializedEvent());
  }

  private handleResponse(response: DebugProtocol.Response) {
    let seq = response.request_seq;
    let pending = this._requests.get(seq);
    if (!pending) {
      this.logTrace(`request not found: ${seq}`);
      return;
    }
    this._requests.delete(seq);
    pending.resolve(response);
  }

  private handleEvent(event: DebugProtocol.Event) {
    switch(event.event) {
      case 'thread': {
        const body  = (event as DebugProtocol.ThreadEvent).body;
        const threadId = body.threadId;
        this.sendEvent(event);
        this.logTrace(`received event (thread ${threadId})`);
        break;
      }
      case 'stopped': {
        const body  = (event as DebugProtocol.ThreadEvent).body;
        if (body.reason !== 'entry') {
          this.sendEvent(event);
        }
        break;
      }
      case 'output': {
        const e = (event as DebugProtocol.OutputEvent);
        const source = e.body.source;
        if (source) {
          source.path = replacePath(source.path ?? '');
        }
        
        this.sendEvent(e);
        break;
      }
    }
  }

  protected disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments, request?: DebugProtocol.Request): void {
    this.closeServer();
    this.closeWebFClient();
    this.sendResponse(response);
  }

  protected async attachRequest(response: DebugProtocol.AttachResponse, args: AttachRequestArguments, request?: DebugProtocol.Request) {
    await this.connectToWebF(args.host!, args.port?.toString() ?? '9222');
    this.sendResponse(response);
  }

  protected async launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchRequestArguments) {
    this.closeServer();
    // this.lauchWebFClient(args);

    try {
      await this.connectToWebF('localhost', QuickJSDebugSession.REMOTE_DEBUGGING_PORT.toString());
    }
    catch (e) {
      this.sendErrorResponse(response, 17, e.message);
      return;
    }

    this.sendResponse(response);
  }

  private connectToWebF(host: string, port: string) {
    // make sure to 'Stop' the buffered logging if 'trace' is not set
    logger.setup(Logger.LogLevel.Verbose);

    // const address = this._commonArgs!.address || 'localhost';
    this._remoteClient = new WebSocket.client();
    this._remoteClient.on('connectFailed', () => {
    });

    const self = this;
    this._remoteClient.on('connect', connection => {
      console.log('WebSocket Client Connected');
      connection.on('error', function (error) {
        console.log("Connection Error: " + error.toString());
      });
      connection.on('close', function () {
        console.log('echo-protocol Connection Closed');
      });
      connection.on('message', function (message) {
        if (message.type === 'utf8') {
          console.log("Received: '" + message.utf8Data + "'");
          const json = JSON.parse(message.utf8Data);
          if (json.type === 'event') {
            self.handleEvent(json);
          } else if (json.type === 'response') {
            self.handleResponse(json);
          } else {
            self.logTrace(`unknown message ${json}`);
          }
        }
      });
      this._wsConnection = connection;
      if (this._pendingMessages.length > 0) {
        for(let message of this._pendingMessages) {
          this.sendThreadMessage(message);
        }
      }
    });

    this._remoteClient.connect(`ws://${host}:${port}`);
  }

  public async logTrace(message: string) {
    // if (this._commonArgs!.trace) { this.log(message); }
    this.log(message);
  }

  public log(message: string, category: string = 'console') {
    this.sendEvent(new OutputEvent(message + '\n', category));
  }

  private async lauchWebFClient(args: LaunchRequestArguments) {
    let entryPoint = args.program || args.url;

    if (!entryPoint) {
      vscode.window.showErrorMessage('Please add `url` or `program` property on your debugger launch config.', {modal: true});
      return;
    }

    this._webfApp = spawn('webf', ['run', entryPoint, '--remote-debugging-port', QuickJSDebugSession.REMOTE_DEBUGGING_PORT.toString()]);
  }

  private async closeWebFClient() {
    if (this._webfApp) {
      execSync(`kill -s SIGTERM ${this._webfApp.pid}`, {shell: '/bin/bash'});
    }
  }

  private async closeServer() {
    if (this._remoteClient) {
      this._remoteClient.abort();
      this._remoteClient = undefined;
    }
  }

  protected async terminateRequest(response: DebugProtocol.TerminateResponse, args: DebugProtocol.TerminateArguments, request?: DebugProtocol.Request) {
    this.closeServer();
    this.sendResponse(response);
  }

  protected async setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments) {
    response.body = {
      breakpoints: []
    };

    if (!args.source.path) {
      this.sendResponse(response);
      return;
    }

    // Replace source path relative to current project root.
    // args.source.path = `app://${args.source.path.replace(vscode.workspace.rootPath ?? '', '')}`;

    // update the entry for this file
    if (args.breakpoints) {
      this._breakpoints.set(args.source.path, args.breakpoints);
    }
    else {
      this._breakpoints.delete(args.source.path);
    }

    await this.sendRequestToDebugger({
      type: 'request',
      command: 'setBreakpoints',
      arguments: args,
      seq: _seq++
    });

    this.sendResponse(response);
  }

  protected async setExceptionBreakPointsRequest(response: DebugProtocol.SetExceptionBreakpointsResponse, args: DebugProtocol.SetExceptionBreakpointsArguments, request?: DebugProtocol.Request) {
    await this.sendRequestToDebugger({
      type: 'request',
      command: 'setExceptionBreakpoints',
      arguments: args,
      seq: _seq++
    });
    this.sendResponse(response);
  }

  protected async threadsRequest(response: DebugProtocol.ThreadsResponse): Promise<void> {
    const threadResponse = await this.sendRequestToDebugger<DebugProtocol.ThreadsResponse>({
      type: 'request',
      command: 'threads',
      arguments: null,
      seq: _seq++
    });
    response.body = threadResponse.body;
    this.sendResponse(response);
  }

  protected async stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments) {
    console.log(args);
    const stackTraceResponse = await this.sendRequestToDebugger<DebugProtocol.StackTraceResponse>({
      type: 'request',
      command: 'stackTrace',
      arguments: args,
      seq: _seq++
    });

    response.body = stackTraceResponse.body;
    this.sendResponse(response);
  }

  protected async configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments, request?: DebugProtocol.Request | undefined) {
    await this.sendRequestToDebugger<DebugProtocol.ConfigurationDoneResponse>({
      type: 'request',
      command: 'configurationDone',
      arguments: args,
      seq: _seq++
    });
    this.sendResponse(response);
  }

  protected async scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments) {
    const scopeResponse = await this.sendRequestToDebugger<DebugProtocol.ScopesResponse>({
      type: 'request',
      command: 'scopes',
      arguments: args,
      seq: _seq++
    });
    response.body = scopeResponse.body;
    this.sendResponse(response);
  }

  protected async variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments, request?: DebugProtocol.Request) {
    const variableResponse = await this.sendRequestToDebugger<DebugProtocol.VariablesResponse>({
      type: 'request',
      command: 'variables',
      arguments: args,
      seq: _seq++
    });

    response.body = variableResponse.body;
    this.sendResponse(response);
  }

  private sendThreadMessage(message: any) {
    if (!this._remoteClient) {
      this.logTrace(`debug server not avaiable`);
      return;
    }

    if (!this._wsConnection) {
      this._pendingMessages.push(message);
      return;
    }

    let json = JSON.stringify({
      vscode: true,
      data: message
    });
    this._wsConnection?.sendUTF(json);
  }

  private sendRequestToDebugger<T>(request: DebugProtocol.Request): Promise<T> {
    return new Promise((resolve, reject) => {
      this._requests.set(request.seq, {
        resolve,
        reject
      });
      console.log(`Send Request ${request.command}: ${request.seq}`);
      this.sendThreadMessage(request);
    });
  }

  protected async continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments) {
    const debuggerResponse = await this.sendRequestToDebugger<DebugProtocol.ContinueResponse>({
      type: 'request',
      command: 'continue',
      arguments: args,
      seq: _seq++
    });
    response.body = debuggerResponse.body;
    this.sendResponse(response);
  }

  protected async nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments) {
    const debuggerResponse = await this.sendRequestToDebugger<DebugProtocol.ContinueResponse>({
      type: 'request',
      command: 'next',
      arguments: args,
      seq: _seq++
    });
    response.body = debuggerResponse.body;
    this.sendResponse(response);
  }

  protected async stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments, request?: DebugProtocol.Request) {
    const debuggerResponse = await this.sendRequestToDebugger<DebugProtocol.ContinueResponse>({
      type: 'request',
      command: 'stepIn',
      arguments: args,
      seq: _seq++
    });
    response.body = debuggerResponse.body;
    this.sendResponse(response);
  }

  protected async stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments, request?: DebugProtocol.Request) {
    const debuggerResponse = await this.sendRequestToDebugger<DebugProtocol.ContinueResponse>({
      type: 'request',
      command: 'stepOut',
      arguments: args,
      seq: _seq++
    });
    response.body = debuggerResponse.body;
    this.sendResponse(response);
  }

  protected async evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments) {
    if (args.expression.length === 0) {
      return;
    }

    const debuggerResponse = await this.sendRequestToDebugger<DebugProtocol.EvaluateResponse>({
      type: 'request',
      command: 'evaluate',
      arguments: args,
      seq: _seq++
    });
    response.body = debuggerResponse.body;
    this.sendResponse(response);
  }

  protected async pauseRequest(response: DebugProtocol.PauseResponse, args: DebugProtocol.PauseArguments, request?: DebugProtocol.Request) {
    const debuggerResponse = await this.sendRequestToDebugger<DebugProtocol.ContinueResponse>({
      type: 'request',
      command: 'pause',
      arguments: args,
      seq: _seq++
    });
    response.body = debuggerResponse.body;
    this.sendResponse(response);
  }

  protected async completionsRequest(response: DebugProtocol.CompletionsResponse, args: DebugProtocol.CompletionsArguments) {
    const debuggerResponse = await this.sendRequestToDebugger<DebugProtocol.CompletionsResponse>({
      type: 'request',
      command: 'completions',
      arguments: args,
      seq: _seq++
    });
    response.body = debuggerResponse.body;
    this.sendResponse(response);
  }
}
