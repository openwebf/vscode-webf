// import * as CP from 'child_process';
import * as WebSocket from 'websocket';
import { basename } from 'path';
import * as vscode from 'vscode';
import { spawn, ChildProcess, execSync } from 'child_process';
import { MappedPosition } from 'source-map';
import { InitializedEvent, Logger, logger, OutputEvent, Scope, Source, StackFrame, StoppedEvent, Thread, ThreadEvent } from 'vscode-debugadapter';
import { DebugProtocol } from 'vscode-debugprotocol';
import { SourcemapArguments } from './sourcemapArguments';
import { SourcemapSession } from "./sourcemapSession";
import { getVSCodeDownloadUrl } from '@vscode/test-electron/out/util';
// const Parser = require('stream-parser');
// const Transform = require('stream').Transform

let _seq = 0;

interface CommonArguments extends SourcemapArguments {
  // program: string;
  // args?: string[];
  // cwd?: string;
  // runtimeExecutable: string;
  // mode: string;
  // address: string;
  // port: number;
  // console?: ConsoleType;
  // trace?: boolean;
}
interface LaunchRequestArguments extends CommonArguments, DebugProtocol.LaunchRequestArguments {
  name: string;
  program?: string;
  url?: string;
}
interface AttachRequestArguments extends CommonArguments, DebugProtocol.AttachRequestArguments {
  name: string;
  port?: number;
  host?: string;
}

// /**
//  * Messages from the qjs binary are in big endian length prefix json payloads.
//  * The protocol is roughly just the JSON stringification of the requests.
//  * Responses are intercepted to translate references into thread scoped references.
//  */
// class MessageParser extends Transform {
//   constructor() {
//     super();
//     this._bytes(9, this.onLength);
//   }

//   private onLength(buffer: Buffer) {
//     let length = parseInt(buffer.toString(), 16);
//     this.emit('length', length);
//     this._bytes(length, this.onMessage);
//   }

//   private onMessage(buffer: Buffer) {
//     let json = JSON.parse(buffer.toString());
//     this.emit('message', json);
//     this._bytes(9, this.onLength);
//   }
// }

// Parser(MessageParser.prototype);

type ConsoleType = 'internalConsole' | 'integratedTerminal' | 'externalTerminal';

interface PendingResponse {
  resolve: Function;
  reject: Function;
}

export class QuickJSDebugSession extends SourcemapSession {
  private static RUNINTERMINAL_TIMEOUT = 5000;
  private static REMOTE_DEBUGGING_PORT = 9222;

  private _webfApp?: ChildProcess;
  private _remoteClient?: WebSocket.client;
  private _wsConnection?: WebSocket.connection;
  private _supportsRunInTerminalRequest = false;
  private _console: ConsoleType = 'internalConsole';
  private _pendingMessages: any[] = [];
  // private _isTerminated: boolean = false;
  private _requests = new Map<number, PendingResponse>();
  // contains a list of real source files and their source mapped breakpoints.
  // ie: file1.ts -> webpack.main.js:59
  //     file2.ts -> webpack.main.js:555
  // when sending breakpoint messages, perform the mapping, note which mapped files changed,
  // then filter the breakpoint values for those touched files.
  // sending only the mapped breakpoints from file1.ts would clobber existing
  // breakpoints from file2.ts, as they both map to webpack.main.js.
  private _breakpoints = new Map<string, DebugProtocol.BreakpointLocation[]>();
  private _stopOnException = false;
  private _variables = new Map<number, number>();
  private _commonArgs?: CommonArguments;

  public constructor() {
    super("quickjs-debug.txt");

    this.setDebuggerLinesStartAt1(true);
    this.setDebuggerColumnsStartAt1(true);
  }

  protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {
    if (typeof args.supportsRunInTerminalRequest === 'boolean') {
      this._supportsRunInTerminalRequest = args.supportsRunInTerminalRequest;
    }

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
    switch (event.event) {
      case 'thread': {
        const body = (event as DebugProtocol.ThreadEvent).body;
        const threadId = body.threadId;
        this.sendEvent(event);
        this.logTrace(`received event (thread ${threadId})`);
        break;
      }
      case 'stopped': {
        const body = (event as DebugProtocol.ThreadEvent).body;
        if (body.reason !== 'entry') {
          this.sendEvent(event);
        }
        break;
      }
    }
  }

  private async newSession() {
    // Collection all setted breakpoints;
    // let files = new Set<string>();
    // for (let bps of this._breakpoints.values()) {
    //   for (let bp of bps) {
    //     files.add(bp);
    //   }
    // }
    // for (let file of files) {
    //   await this.sendBreakpointMessage(file);
    // }
    // this.sendThreadMessage({
    //   type: 'stopOnException',
    //   stopOnException: this._stopOnException,
    // });
    // this.sendThreadMessage({ type: 'continue' });
  }

  protected disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments, request?: DebugProtocol.Request): void {
    this.closeServer();
    this.closeWebFClient();
    this.sendResponse(response);
  }

  protected async attachRequest(response: DebugProtocol.AttachResponse, args: AttachRequestArguments, request?: DebugProtocol.Request) {
    this._commonArgs = args;
    await this.connectToWebF(args.host!, args.port?.toString() ?? '9222');
    this.sendResponse(response);
  }

  protected async launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchRequestArguments) {
    this._commonArgs = args;
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
        for (let message of this._pendingMessages) {
          this.sendThreadMessage(message);
        }
      }
      this.newSession();
    });

    this._remoteClient.connect(`ws://${host}:${port}`);
  }

  async getArguments(): Promise<SourcemapArguments> {
    return this._commonArgs!;
  }

  public async logTrace(message: string) {
    // if (this._commonArgs!.trace) { this.log(message); }
  }

  public log(message: string, category: string = 'console') {
    this.sendEvent(new OutputEvent(message + '\n', category));
  }

  private async lauchWebFClient(args: LaunchRequestArguments) {
    let entryPoint = args.program || args.url;

    if (!entryPoint) {
      vscode.window.showErrorMessage('Please add `url` or `program` property on your debugger launch config.', { modal: true });
      return;
    }

    this._webfApp = spawn('webf', ['run', entryPoint, '--remote-debugging-port', QuickJSDebugSession.REMOTE_DEBUGGING_PORT.toString()]);

    this._webfApp!.stdout!.on('data', (data) => {
      this.log(data.toString(), 'stdout');
    });
  }

  private async closeWebFClient() {
    if (this._webfApp) {
      execSync(`kill -s SIGTERM ${this._webfApp.pid}`, { shell: '/bin/bash' });
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

    this.logTrace(`setBreakPointsRequest: ${JSON.stringify(args)}`);

    if (!args.source.path) {
      this.sendResponse(response);
      return;
    }

    // update the entry for this file
    if (args.breakpoints) {
      this._breakpoints.set(args.source.path, args.breakpoints);
    }
    else {
      this._breakpoints.delete(args.source.path);
    }

    await this.sendThreadRequest({
      type: 'request',
      command: 'setBreakpoints',
      arguments: args,
      seq: _seq++
    });

    this.sendResponse(response);
  }

  protected async setExceptionBreakPointsRequest(response: DebugProtocol.SetExceptionBreakpointsResponse, args: DebugProtocol.SetExceptionBreakpointsArguments, request?: DebugProtocol.Request) {
    await this.sendThreadRequest({
      type: 'request',
      command: 'setExceptionBreakpoints',
      arguments: args,
      seq: _seq++
    });
    this.sendResponse(response);
  }

  protected async threadsRequest(response: DebugProtocol.ThreadsResponse): Promise<void> {
    const threadResponse = await this.sendThreadRequest<DebugProtocol.ThreadsResponse>({
      type: 'request',
      command: 'threads',
      arguments: null,
      seq: _seq++
    });
    response.body = threadResponse.body;
    this.sendResponse(response);
  }

  protected async stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments) {
    const stackTraceResponse = await this.sendThreadRequest<DebugProtocol.StackTraceResponse>({
      type: 'request',
      command: 'stackTrace',
      arguments: args,
      seq: _seq++
    });

    response.body = stackTraceResponse.body;
    this.sendResponse(response);
  }

  protected async scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments) {
    const scopeResponse = await this.sendThreadRequest<DebugProtocol.ScopesResponse>({
      type: 'request',
      command: 'scopes',
      arguments: args,
      seq: _seq++
    });
    response.body = scopeResponse.body;
    this.sendResponse(response);
  }

  protected async variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments, request?: DebugProtocol.Request) {
    // const thread = this._variables.get(args.variablesReference);
    // if (!thread) {
    //   this.sendErrorResponse(response, 2030, 'scopesRequest: thread not found');
    //   return;
    // }
    // args.variablesReference -= thread;
    // const body = await this.sendThreadRequest(thread, response, args);
    // const variables = body.map(({ name, value, type, variablesReference, indexedVariables }) => {
    //   // todo: use counter mapping
    //   variablesReference = variablesReference ? variablesReference + thread : 0;
    //   this._variables.set(variablesReference, thread);
    //   return { name, value, type, variablesReference, indexedVariables };
    // });

    // response.body = {
    //   variables,
    // };
    // this.sendResponse(response);
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

    this.logTrace(`sent: ${JSON.stringify(message)}`);
    let json = JSON.stringify({
      vscode: true,
      data: message
    });
    this._wsConnection?.sendUTF(json);
  }

  private sendThreadRequest<T>(request: DebugProtocol.Request): Promise<T> {
    return new Promise((resolve, reject) => {
      this._requests.set(request.seq, {
        resolve,
        reject
      });

      this.sendThreadMessage(request);
    });
  }

  protected async continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments) {
    const threadResponse = await this.sendThreadRequest<DebugProtocol.ContinueResponse>({
      type: 'request',
      command: 'continue',
      arguments: args,
      seq: _seq++
    });
    response.body = threadResponse.body;
    this.sendResponse(response);
  }

  protected async nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments) {
    const threadResponse = await this.sendThreadRequest<DebugProtocol.ContinueResponse>({
      type: 'request',
      command: 'next',
      arguments: args,
      seq: _seq++
    });
    response.body = threadResponse.body;
    this.sendResponse(response);
  }

  protected async stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments, request?: DebugProtocol.Request) {
    const threadResponse = await this.sendThreadRequest<DebugProtocol.ContinueResponse>({
      type: 'request',
      command: 'stepIn',
      arguments: args,
      seq: _seq++
    });
    response.body = threadResponse.body;
    this.sendResponse(response);
  }

  protected async stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments, request?: DebugProtocol.Request) {
    const threadResponse = await this.sendThreadRequest<DebugProtocol.ContinueResponse>({
      type: 'request',
      command: 'stepOut',
      arguments: args,
      seq: _seq++
    });
    response.body = threadResponse.body;
    this.sendResponse(response);
  }

  protected async evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments) {
    // if (!args.frameId) {
    //   this.sendErrorResponse(response, 2030, 'scopesRequest: frameId not specified');
    //   return;
    // }
    // let thread = this._stackFrames.get(args.frameId);
    // if (!thread) {
    //   this.sendErrorResponse(response, 2030, 'scopesRequest: thread not found');
    //   return;
    // }
    // args.frameId -= thread;

    // const body = await this.sendThreadRequest(thread, response, args);
    // let variablesReference = body.variablesReference;
    // variablesReference = variablesReference ? variablesReference + thread : 0;
    // this._variables.set(variablesReference, thread);
    // body.variablesReference = variablesReference;

    // response.body = body;
    // this.sendResponse(response);
  }

  protected async pauseRequest(response: DebugProtocol.PauseResponse, args: DebugProtocol.PauseArguments, request?: DebugProtocol.Request) {
    const threadResponse = await this.sendThreadRequest<DebugProtocol.ContinueResponse>({
      type: 'request',
      command: 'pause',
      arguments: args,
      seq: _seq++
    });
    response.body = threadResponse.body;
    this.sendResponse(response);
  }

  protected async completionsRequest(response: DebugProtocol.CompletionsResponse, args: DebugProtocol.CompletionsArguments) {
    // if (!args.frameId) {
    //   this.sendErrorResponse(response, 2030, 'completionsRequest: frameId not specified');
    //   return;
    // }
    // let thread = this._stackFrames.get(args.frameId);
    // if (!thread) {
    //   this.sendErrorResponse(response, 2030, 'completionsRequest: thread not found');
    //   return;
    // }
    // args.frameId -= thread;

    // let expression = args.text.substr(0, args.text.length - 1);
    // if (!expression) {
    //   this.sendErrorResponse(response, 2032, "no completion available for empty string");
    //   return;
    // }

    // const evaluateArgs: DebugProtocol.EvaluateArguments = {
    //   frameId: args.frameId,
    //   expression,
    // };
    // response.command = 'evaluate';

    // let body = await this.sendThreadRequest(thread, response, evaluateArgs);
    // if (!body.variablesReference) {
    //   this.sendErrorResponse(response, 2032, "no completion available for expression");
    //   return;
    // }

    // if (body.indexedVariables !== undefined) {
    //   this.sendErrorResponse(response, 2032, "no completion available for arrays");
    //   return;
    // }

    // const variableArgs: DebugProtocol.VariablesArguments = {
    //   variablesReference: body.variablesReference,
    // };
    // response.command = 'variables';
    // body = await this.sendThreadRequest(thread, response, variableArgs);

    // response.command = 'completions';
    // response.body = {
    //   targets: body.map(property => ({
    //     label: property.name,
    //     type: 'field',
    //   }))
    // };

    // this.sendResponse(response);
  }
}
