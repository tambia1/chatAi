import * as vscode from 'vscode';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

interface ChatRequestSettings {
  includeActiveFile: boolean;
  includeTree: boolean;
  includeOpenTabs: boolean;
  includeTools: boolean;
  think: boolean;
  numCtx: number;
  computeMode: 'cpu' | 'auto' | 'layers';
  gpuLayers: number;
}

interface ToolCall {
  function?: {
    name?: string;
    arguments?: Record<string, unknown> | string;
  };
}

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
}

type ToolPermission = 'read' | 'write' | 'delete' | 'git' | 'run';

interface WorkspaceToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    permission: ToolPermission;
    requiresConfirmation: boolean;
    parameters: {
      type: 'object';
      properties: Record<string, { type: string; description: string }>;
      required: string[];
    };
  };
}

interface WorkspaceToolGroup {
  name: string;
  tools: WorkspaceToolDefinition[];
}

const WORKSPACE_TOOL_GROUPS: Record<string, WorkspaceToolGroup> = {
  files: {
    name: 'Files',
    tools: [
      {
        type: 'function',
        function: {
          name: 'read_file',
          description: 'Read a file in the current VS Code workspace.',
          permission: 'read',
          requiresConfirmation: false,
          parameters: {
            type: 'object',
            properties: { path: { type: 'string', description: 'Workspace-relative file path.' } },
            required: ['path'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'edit_file',
          description: 'Replace exactly one occurrence of oldText with newText in a workspace file and save it.',
          permission: 'write',
          requiresConfirmation: false,
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Workspace-relative file path.' },
              oldText: { type: 'string', description: 'Exact existing text to replace.' },
              newText: { type: 'string', description: 'Replacement text.' },
            },
            required: ['path', 'oldText', 'newText'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'create_file',
          description: 'Create a new file in the current VS Code workspace.',
          permission: 'write',
          requiresConfirmation: false,
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Workspace-relative file path for the new file.' },
              content: { type: 'string', description: 'File contents to write.' },
            },
            required: ['path', 'content'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'rename_file',
          description: 'Rename or move a file within the current VS Code workspace.',
          permission: 'write',
          requiresConfirmation: false,
          parameters: {
            type: 'object',
            properties: {
              fromPath: { type: 'string', description: 'Current workspace-relative file path.' },
              toPath: { type: 'string', description: 'New workspace-relative file path.' },
              confirm: { type: 'boolean', description: 'Set to true to confirm the rename.' },
            },
            required: ['fromPath', 'toPath'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'delete_file',
          description: 'Delete a file from the current VS Code workspace.',
          permission: 'delete',
          requiresConfirmation: true,
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Workspace-relative file path to delete.' },
              confirm: { type: 'boolean', description: 'Set to true to confirm the deletion.' },
            },
            required: ['path'],
          },
        },
      },
    ],
  },

  folders: {
    name: 'Folders',
    tools: [
      {
        type: 'function',
        function: {
          name: 'list_dir',
          description: 'List the files and folders inside a workspace directory.',
          permission: 'read',
          requiresConfirmation: false,
          parameters: {
            type: 'object',
            properties: { path: { type: 'string', description: 'Workspace-relative directory path.' } },
            required: ['path'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'create_folder',
          description: 'Create a new folder in the current VS Code workspace.',
          permission: 'write',
          requiresConfirmation: false,
          parameters: {
            type: 'object',
            properties: { path: { type: 'string', description: 'Workspace-relative folder path.' } },
            required: ['path'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'rename_folder',
          description: 'Rename or move a folder within the current VS Code workspace.',
          permission: 'write',
          requiresConfirmation: true,
          parameters: {
            type: 'object',
            properties: {
              fromPath: { type: 'string', description: 'Current workspace-relative folder path.' },
              toPath: { type: 'string', description: 'New workspace-relative folder path.' },
              confirm: { type: 'boolean', description: 'Set to true to confirm the rename.' },
            },
            required: ['fromPath', 'toPath'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'delete_folder',
          description: 'Delete a folder from the current VS Code workspace.',
          permission: 'delete',
          requiresConfirmation: true,
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Workspace-relative folder path to delete.' },
              confirm: { type: 'boolean', description: 'Set to true to confirm the deletion.' },
            },
            required: ['path'],
          },
        },
      },
    ],
  },

  git: {
    name: 'Git',
    tools: [
      {
        type: 'function',
        function: {
          name: 'git_status',
          description: 'Show the current git status for the workspace repository.',
          permission: 'git',
          requiresConfirmation: false,
          parameters: {
            type: 'object',
            properties: { confirm: { type: 'boolean', description: 'Set to true to confirm the git operation.' } },
            required: [],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'git_pull',
          description: 'Pull the current branch from the configured git remote.',
          permission: 'git',
          requiresConfirmation: true,
          parameters: {
            type: 'object',
            properties: {
              confirm: { type: 'boolean', description: 'Set to true to confirm the git pull.' },
              branch: { type: 'string', description: 'Optional branch name to pull.' },
            },
            required: [],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'git_create_branch',
          description: 'Create a new git branch from the current HEAD.',
          permission: 'git',
          requiresConfirmation: true,
          parameters: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Branch name to create.' },
              confirm: { type: 'boolean', description: 'Set to true to confirm the branch creation.' },
            },
            required: ['name'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'git_merge',
          description: 'Merge another branch into the current branch.',
          permission: 'git',
          requiresConfirmation: true,
          parameters: {
            type: 'object',
            properties: {
              branch: { type: 'string', description: 'Branch name to merge into the current branch.' },
              confirm: { type: 'boolean', description: 'Set to true to confirm the merge.' },
            },
            required: ['branch'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'git_switch',
          description: 'Switch the repository to a different branch.',
          permission: 'git',
          requiresConfirmation: true,
          parameters: {
            type: 'object',
            properties: {
              branch: { type: 'string', description: 'Branch to switch to.' },
              confirm: { type: 'boolean', description: 'Set to true to confirm the switch.' },
            },
            required: ['branch'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'git_log',
          description: 'Show the recent git commit history for the repository.',
          permission: 'git',
          requiresConfirmation: false,
          parameters: {
            type: 'object',
            properties: {
              maxCount: { type: 'number', description: 'Maximum number of commits to show.' },
              confirm: { type: 'boolean', description: 'Set to true to confirm the git log request.' },
            },
            required: [],
          },
        },
      },
    ],
  },

  commands: {
    name: 'Commands',
    tools: [
      {
        type: 'function',
        function: {
          name: 'run_command',
          description: 'Run a shell command in the workspace root.',
          permission: 'run',
          requiresConfirmation: true,
          parameters: {
            type: 'object',
            properties: {
              command: { type: 'string', description: 'Shell command to run from the workspace root.' },
              cwd: { type: 'string', description: 'Optional workspace-relative directory to run the command from.' },
              confirm: { type: 'boolean', description: 'Set to true to confirm the command.' },
            },
            required: ['command'],
          },
        },
      },
    ],
  },
};

const WORKSPACE_TOOLS: WorkspaceToolDefinition[] = Object.values(WORKSPACE_TOOL_GROUPS).flatMap((group) => group.tools);

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'chatAi.chat';

  private view?: vscode.WebviewView;
  private history: ChatTurn[] = [];
  private currentAbort?: AbortController;
  private lastEditor?: vscode.TextEditor;
  private sessionAllowlist = new Set<string>();
  private sessionSettings?: ChatRequestSettings;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly extensionVersion: string,
  ) {
    this.lastEditor = vscode.window.activeTextEditor;
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) this.lastEditor = editor;
      this.postContext();
    });
    vscode.window.onDidChangeTextEditorSelection((event) => {
      if (event.textEditor === this.lastEditor || event.textEditor === vscode.window.activeTextEditor) {
        this.postContext();
      }
    });
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message?.type) {
        case 'ready':
          this.postInit();
          break;
        case 'send':
          await this.handleSend(
            String(message.text ?? ''),
            message.model ? String(message.model) : undefined,
            this.normalizeRequestSettings(message.settings),
          );
          break;
        case 'cancel':
          this.currentAbort?.abort();
          break;
        case 'requestSettingsState': {
          this.postSettingsState();
          break;
        }
        case 'saveSettings': {
          const incoming = Array.isArray(message.tools) ? message.tools : [];
          const nextAllowlist = new Set<string>();
          for (const toolName of incoming) {
            if (typeof toolName === 'string' && WORKSPACE_TOOLS.some((tool) => tool.function.name === toolName)) {
              nextAllowlist.add(toolName);
            }
          }
          this.sessionAllowlist = nextAllowlist;
          this.sessionSettings = this.normalizeRequestSettings(message.settings);
          break;
        }
      }
    });
  }

  private postInit(): void {
    if (!this.view) return;
    const config = vscode.workspace.getConfiguration('chatAi');
    const models = config.get<string[]>('models', ['gemma4:12b', 'gemma4:31b', 'qwen3.6:35b']);
    const selected = config.get<string>('model', models[0] ?? 'gemma4:12b');
    const numCtx = config.get<number>('numCtx', 2048);
    this.view.webview.postMessage({ type: 'init', models, selected, numCtx });
    this.postContext();
  }

  private postContext(): void {
    if (!this.view) return;
    const editor = vscode.window.activeTextEditor ?? this.lastEditor;
    if (!editor) {
      this.view.webview.postMessage({ type: 'context', file: null, selection: null });
      return;
    }
    const document = editor.document;
    if (document.uri.scheme !== 'file' && document.uri.scheme !== 'untitled') {
      this.view.webview.postMessage({ type: 'context', file: null, selection: null });
      return;
    }
    const path = vscode.workspace.asRelativePath(document.uri);
    const name = path.split(/[\\/]/).pop() || path;
    const selection = editor.selection;
    const selectionInfo = selection.isEmpty
      ? null
      : { startLine: selection.start.line + 1, endLine: selection.end.line + 1 };
    this.view.webview.postMessage({ type: 'context', file: { name, path }, selection: selectionInfo });
  }

  private postContextSize(
    messages: Array<{ role: string; content: string }>,
    numCtx: number,
    parts: { activeFile: number; tree: number; openTabs: number; conversation: number },
  ): void {
    if (!this.view) return;
    const bytes = messages.reduce((sum, message) => sum + message.content.length, 0);
    const tokens = Math.ceil(bytes / 4);
    let severity: 'ok' | 'warn' | 'over' = 'ok';
    if (tokens > numCtx) severity = 'over';
    else if (tokens > numCtx * 0.8) severity = 'warn';
    this.view.webview.postMessage({ type: 'contextSize', bytes, tokens, numCtx, severity, parts });
  }

  clearChat(): void {
    this.history = [];
    this.currentAbort?.abort();
    this.view?.webview.postMessage({ type: 'clear' });
  }

  private resolveWorkspaceUri(path: string): vscode.Uri | null {
    const root = vscode.workspace.workspaceFolders?.[0];
    if (!root) return null;
    if (!path || path === '.') {
      return root.uri;
    }
    if (path.startsWith('/') || path.split(/[\\/]/).includes('..')) {
      return null;
    }
    return vscode.Uri.joinPath(root.uri, ...path.split(/[\\/]/).filter(Boolean));
  }

  private getToolPermission(name: string): ToolPermission | undefined {
    const tool = WORKSPACE_TOOLS.find((candidate) => candidate.function.name === name);
    return tool?.function.permission;
  }

  private isToolEnabled(name: string): { ok: true } | { ok: false; reason: string } {
    const tool = WORKSPACE_TOOLS.find((candidate) => candidate.function.name === name);
    if (!tool) return { ok: false, reason: `Unknown tool: ${name}` };
    const requiredPermission = tool.function.permission;

    const config = vscode.workspace.getConfiguration('chatAi');
    const permissions = config.get<Record<string, string | boolean>>('toolPermissions', {});
    const configValue = permissions[name];
    if (configValue === false) return { ok: false, reason: `Tool ${name} is disabled by configuration.` };
    if (typeof configValue === 'string') {
      const order: Record<ToolPermission, number> = { read: 1, write: 2, delete: 3, git: 4, run: 5 };
      const normalized = configValue.toLowerCase();
      const allowedPermission = normalized === 'deny' || normalized === 'disabled' ? null : (normalized as ToolPermission);
      if (!allowedPermission) return { ok: false, reason: `Tool ${name} is disabled by configuration.` };
      if (order[allowedPermission] < order[requiredPermission]) {
        return { ok: false, reason: `Tool ${name} requires permission '${requiredPermission}', but configuration only allows '${allowedPermission}'.` };
      }
    }
    return { ok: true };
  }

  private postSettingsState(): void {
    const config = vscode.workspace.getConfiguration('chatAi');
    const settings: ChatRequestSettings = this.sessionSettings ?? {
      includeActiveFile: false,
      includeTree: config.get<boolean>('context.includeTree', false),
      includeOpenTabs: config.get<boolean>('context.includeOpenTabs', false),
      includeTools: false,
      think: false,
      numCtx: config.get<number>('numCtx', 2048),
      computeMode: 'cpu',
      gpuLayers: 0,
    };
    this.view?.webview.postMessage({
      type: 'settingsState',
      tools: WORKSPACE_TOOLS.map((tool) => ({
        name: tool.function.name,
        group: this.getToolGroup(tool.function.name),
        requiresConfirmation: !!tool.function.requiresConfirmation,
        selected: this.sessionAllowlist.has(tool.function.name),
      })),
      settings,
    });
  }

  private normalizeRequestSettings(value: unknown): ChatRequestSettings {
    const config = vscode.workspace.getConfiguration('chatAi');
    const incoming = value && typeof value === 'object' ? value as Partial<ChatRequestSettings> : {};
    const configuredNumCtx = config.get<number>('numCtx', 2048);
    const numCtx = [2048, 4096, 8192, 16384].includes(incoming.numCtx ?? 0)
      ? incoming.numCtx!
      : configuredNumCtx;
    const computeMode = incoming.computeMode === 'auto' || incoming.computeMode === 'layers'
      ? incoming.computeMode
      : 'cpu';
    const gpuLayers = Number.isInteger(incoming.gpuLayers) && incoming.gpuLayers! >= 1 && incoming.gpuLayers! <= 128
      ? incoming.gpuLayers!
      : 1;
    return {
      includeActiveFile: incoming.includeActiveFile === true,
      includeTree: incoming.includeTree === true,
      includeOpenTabs: incoming.includeOpenTabs === true,
      includeTools: incoming.includeTools === true,
      think: incoming.think === true,
      numCtx,
      computeMode,
      gpuLayers,
    };
  }

  private getToolGroup(name: string): string {
    return Object.values(WORKSPACE_TOOL_GROUPS)
      .find((group) => group.tools.some((tool) => tool.function.name === name))?.name ?? 'Other';
  }

  private async handleSend(text: string, requestedModel?: string, requestedSettings?: ChatRequestSettings): Promise<void> {
    if (!text.trim() || !this.view) return;

    const startedAt = Date.now();
    this.history.push({ role: 'user', content: text });
    this.view.webview.postMessage({ type: 'user', text });
    this.view.webview.postMessage({ type: 'assistantStart' });

    const config = vscode.workspace.getConfiguration('chatAi');
    const endpoint = config.get<string>('endpoint', 'http://localhost:11434');
    const model = requestedModel?.trim() || config.get<string>('model', 'gemma4:12b');
    const settings = requestedSettings ?? this.sessionSettings ?? this.normalizeRequestSettings(undefined);
    this.sessionSettings = settings;
    const numCtx = settings.numCtx;
    const editorContext = await this.getEditorContext(
      Math.max(1024, numCtx * 4 - 1024),
      settings.includeActiveFile,
      settings.includeTree,
      settings.includeOpenTabs,
    );
    const messages = this.buildMessages(editorContext.text);
    const conversation = this.history.reduce((sum, turn) => sum + turn.content.length, 0);
    this.postContextSize(messages, numCtx, { ...editorContext.parts, conversation });

    let assistantText = '';
    const controller = new AbortController();
    this.currentAbort = controller;
    let ended = false;

    try {
      const response = await fetch(`${endpoint.replace(/\/$/, '')}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages,
          tools: settings.includeTools ? WORKSPACE_TOOLS : [],
          stream: true,
          think: settings.think,
          options: this.getOllamaOptions(settings),
        }),
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      let toolCalls: ToolCall[] = [];
      let responseMessage: OllamaMessage = { role: 'assistant', content: '' };
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newlineIndex: number;
        while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
          let line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (!line) continue;
          if (line.startsWith('data:')) {
            line = line.replace(/^data:\s*/, '');
          }
          if (!line || line === '[DONE]') continue;
          try {
            const chunk = JSON.parse(line);
            const message = chunk.message ?? { role: 'assistant', content: '' };
            responseMessage.content += typeof message.content === 'string' ? message.content : '';
            if (message.tool_calls) toolCalls.push(...message.tool_calls);
            if (typeof message.thinking === 'string' && message.thinking.length > 0) {
              const thinking = message.thinking.replace(/<unused\d+>/g, '');
              if (thinking) this.view.webview.postMessage({ type: 'thinkingChunk', text: thinking });
            }

            const content =
              (typeof message.content === 'string' ? message.content : '') ||
              (typeof chunk.response === 'string' ? chunk.response : '') ||
              (typeof chunk.text === 'string' ? chunk.text : '');
            if (content.length > 0) {
              assistantText += content;
              this.view.webview.postMessage({ type: 'assistantChunk', text: content });
            }
          } catch {
            // ignore non-JSON / partial lines
          }
        }
      }
      if (responseMessage.content && !assistantText) {
        assistantText += responseMessage.content;
        this.view.webview.postMessage({ type: 'assistantChunk', text: responseMessage.content });
      }
      if (toolCalls.length) {
        messages.push({ ...responseMessage, tool_calls: toolCalls });
        for (const call of toolCalls) {
          const result = await this.executeFileTool(call.function?.name ?? '', call.function?.arguments);
          messages.push({ role: 'tool', content: result });
        }
        assistantText += await this.continueToolConversation(endpoint, model, settings, messages, controller.signal);
      }
      this.view.webview.postMessage({ type: 'assistantEnd', durationMs: Date.now() - startedAt });
      ended = true;
    } catch (caughtError: unknown) {
      const error = caughtError as { name?: string; message?: string };
      if (error?.name === 'AbortError') {
        this.view.webview.postMessage({ type: 'assistantEnd', durationMs: Date.now() - startedAt });
        ended = true;
      } else {
        const message = error?.message ?? String(caughtError);
        this.view.webview.postMessage({
          type: 'error',
          text: `Failed to fetch ${endpoint}: ${message}.\n` +
            'Make sure `ollama serve` is running and the endpoint matches chatAi.endpoint.',
        });
      }
    } finally {
      if (!ended) this.view.webview.postMessage({ type: 'assistantEnd', durationMs: Date.now() - startedAt });
      this.currentAbort = undefined;
      if (assistantText) {
        this.history.push({ role: 'assistant', content: assistantText });
      }
    }
  }

  private buildMessages(liveContext: string): OllamaMessage[] {
    const messages: OllamaMessage[] = [];
    messages.push({
      role: 'system',
      content: 'You are an editor assistant inside VS Code. When the user asks to change a file, use the provided file tools to make and save the change. Do not only describe a patch. Use exact oldText and newText, and reread a file if an edit does not match.',
    });
    if (liveContext) {
      messages.push({ role: 'system', content: liveContext });
    }
    for (const turn of this.history) {
      messages.push({ role: turn.role, content: turn.content });
    }
    return messages;
  }

  private async executeFileTool(name: string, rawArguments: Record<string, unknown> | string | undefined): Promise<string> {
    let args: Record<string, unknown>;
    try {
      args = typeof rawArguments === 'string' ? JSON.parse(rawArguments) : (rawArguments ?? {});
    } catch {
      return JSON.stringify({ error: 'Tool arguments were not valid JSON.' });
    }

    const accessCheck = this.isToolEnabled(name);
    if (!accessCheck.ok) return JSON.stringify({ error: accessCheck.reason });

    const tool = WORKSPACE_TOOLS.find((candidate) => candidate.function.name === name);
    if (tool?.function.requiresConfirmation && !this.sessionAllowlist.has(name) && args.confirm !== true) {
      this.postSettingsState();
      return JSON.stringify({ error: `Tool ${name} is not enabled for this session. Open Chat settings with the settings button and enable it.` });
    }

    const root = vscode.workspace.workspaceFolders?.[0];
    if (!root) return JSON.stringify({ error: 'No workspace folder is open.' });

    try {
      if (name === 'run_command') {
        const command = typeof args.command === 'string' ? args.command.trim() : '';
        const cwdPath = typeof args.cwd === 'string' && args.cwd.trim() ? args.cwd : '.';
        const cwdUri = this.resolveWorkspaceUri(cwdPath) ?? root.uri;
        if (!command) return JSON.stringify({ error: 'A command is required.' });
        const { stdout, stderr } = await execAsync(command, { cwd: cwdUri.fsPath, maxBuffer: 1024 * 1024 });
        return JSON.stringify({ ok: true, command, cwd: cwdPath, output: [stdout, stderr].filter(Boolean).join('\n') || 'Command completed successfully.' });
      }

      if (name === 'git_status') {
        const { stdout, stderr } = await execFileAsync('git', ['status', '--short', '--branch'], { cwd: root.uri.fsPath, maxBuffer: 1024 * 1024 });
        return JSON.stringify({ ok: true, output: [stdout, stderr].filter(Boolean).join('\n') || 'Git status is clean.' });
      }

      if (name === 'git_pull') {
        const branch = typeof args.branch === 'string' && args.branch.trim() ? args.branch.trim() : undefined;
        const argsList = branch ? ['pull', '--ff-only', 'origin', branch] : ['pull', '--ff-only'];
        const { stdout, stderr } = await execFileAsync('git', argsList, { cwd: root.uri.fsPath, maxBuffer: 1024 * 1024 });
        return JSON.stringify({ ok: true, output: [stdout, stderr].filter(Boolean).join('\n') || 'Git pull completed.' });
      }

      if (name === 'git_create_branch') {
        const branchName = typeof args.name === 'string' ? args.name.trim() : '';
        if (!branchName) return JSON.stringify({ error: 'A branch name is required.' });
        const { stdout, stderr } = await execFileAsync('git', ['checkout', '-b', branchName], { cwd: root.uri.fsPath, maxBuffer: 1024 * 1024 });
        return JSON.stringify({ ok: true, output: [stdout, stderr].filter(Boolean).join('\n') || `Branch ${branchName} created.` });
      }

      if (name === 'git_merge') {
        const branchName = typeof args.branch === 'string' ? args.branch.trim() : '';
        if (!branchName) return JSON.stringify({ error: 'A branch name is required.' });
        const { stdout, stderr } = await execFileAsync('git', ['merge', '--no-edit', branchName], { cwd: root.uri.fsPath, maxBuffer: 1024 * 1024 });
        return JSON.stringify({ ok: true, output: [stdout, stderr].filter(Boolean).join('\n') || `Merged ${branchName}.` });
      }

      if (name === 'git_switch') {
        const branchName = typeof args.branch === 'string' ? args.branch.trim() : '';
        if (!branchName) return JSON.stringify({ error: 'A branch name is required.' });
        const { stdout, stderr } = await execFileAsync('git', ['switch', branchName], { cwd: root.uri.fsPath, maxBuffer: 1024 * 1024 });
        return JSON.stringify({ ok: true, output: [stdout, stderr].filter(Boolean).join('\n') || `Switched to ${branchName}.` });
      }

      if (name === 'git_log') {
        const maxCount = typeof args.maxCount === 'number' ? args.maxCount : 20;
        const { stdout, stderr } = await execFileAsync('git', ['log', '--oneline', '-n', String(maxCount)], { cwd: root.uri.fsPath, maxBuffer: 1024 * 1024 });
        return JSON.stringify({ ok: true, output: [stdout, stderr].filter(Boolean).join('\n') || 'No git log output.' });
      }

      const path = typeof args.path === 'string' ? args.path : '';
      if (!path) return JSON.stringify({ error: 'Use a valid workspace-relative path.' });
      const uri = this.resolveWorkspaceUri(path);
      if (!uri) return JSON.stringify({ error: 'Use a valid workspace-relative path.' });

      if (name === 'rename_file' || name === 'rename_folder') {
        const fromPath = typeof args.fromPath === 'string' ? args.fromPath : '';
        const toPath = typeof args.toPath === 'string' ? args.toPath : '';
        if (!fromPath || !toPath) return JSON.stringify({ error: 'Both fromPath and toPath are required.' });
        const fromUri = this.resolveWorkspaceUri(fromPath);
        const toUri = this.resolveWorkspaceUri(toPath);
        if (!fromUri || !toUri) return JSON.stringify({ error: 'Use valid workspace-relative paths.' });
        const parentUri = toUri.with({ path: toUri.path.substring(0, toUri.path.lastIndexOf('/')) || '/' });
        try { await vscode.workspace.fs.stat(parentUri); } catch { await vscode.workspace.fs.createDirectory(parentUri); }
        await vscode.workspace.fs.rename(fromUri, toUri, { overwrite: false });
        return JSON.stringify({ ok: true, fromPath, toPath, message: `${name === 'rename_file' ? 'File' : 'Folder'} renamed.` });
      }

      if (name === 'create_folder') {
        const folderExists = await vscode.workspace.fs.stat(uri).then(() => true, () => false);
        if (folderExists) return JSON.stringify({ error: 'Folder already exists.' });
        let current = root.uri;
        const segments = path.split(/[\\/]/).filter(Boolean);
        for (const segment of segments) {
          current = vscode.Uri.joinPath(current, segment);
          try {
            await vscode.workspace.fs.stat(current);
          } catch {
            await vscode.workspace.fs.createDirectory(current);
          }
        }
        return JSON.stringify({ ok: true, path, message: 'Folder created.' });
      }

      if (name === 'delete_folder') {
        await vscode.workspace.fs.delete(uri, { recursive: true, useTrash: false });
        return JSON.stringify({ ok: true, path, message: 'Folder deleted.' });
      }

      if (name === 'delete_file') {
        await vscode.workspace.fs.delete(uri, { recursive: false, useTrash: false });
        return JSON.stringify({ ok: true, path, message: 'File deleted.' });
      }

      if (name === 'list_dir') {
        const entries = await vscode.workspace.fs.readDirectory(uri);
        return JSON.stringify({ ok: true, path, entries: entries.map(([name, type]) => ({ name, type })) });
      }

      if (name === 'create_file') {
        const content = typeof args.content === 'string' ? args.content : '';
        const fileExists = await vscode.workspace.fs.stat(uri).then(() => true, () => false);
        if (fileExists) return JSON.stringify({ error: 'File already exists; use edit_file to update it.' });

        const parentDir = uri.with({ path: uri.path.substring(0, uri.path.lastIndexOf('/')) || '/' });
        let current = root.uri;
        const segments = parentDir.path.split('/').filter(Boolean);
        for (const segment of segments) {
          current = vscode.Uri.joinPath(current, segment);
          try {
            await vscode.workspace.fs.stat(current);
          } catch {
            await vscode.workspace.fs.createDirectory(current);
          }
        }

        await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
        return JSON.stringify({ ok: true, path, message: 'File created.' });
      }

      const document = await vscode.workspace.openTextDocument(uri);
      if (name === 'read_file') return JSON.stringify({ path, content: document.getText() });
      if (name !== 'edit_file') return JSON.stringify({ error: `Unknown tool: ${name}` });

      const oldText = typeof args.oldText === 'string' ? args.oldText : '';
      const newText = typeof args.newText === 'string' ? args.newText : '';
      const source = document.getText();
      const start = source.indexOf(oldText);
      if (start < 0) return JSON.stringify({ error: 'oldText was not found; reread the file and try again.' });
      if (source.indexOf(oldText, start + 1) >= 0) {
        return JSON.stringify({ error: 'oldText matched more than once; include more surrounding text.' });
      }
      const edit = new vscode.WorkspaceEdit();
      edit.replace(uri, new vscode.Range(document.positionAt(start), document.positionAt(start + oldText.length)), newText);
      if (!await vscode.workspace.applyEdit(edit) || !await document.save()) {
        return JSON.stringify({ error: 'VS Code could not apply or save the edit.' });
      }
      return JSON.stringify({ ok: true, path, message: 'File edited and saved.' });
    } catch (error) {
      return JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
    }
  }

  private async continueToolConversation(
    endpoint: string,
    model: string,
    settings: ChatRequestSettings,
    messages: OllamaMessage[],
    signal: AbortSignal,
  ): Promise<string> {
    let finalText = '';
    for (let attempt = 0; attempt < 4; attempt++) {
      const response = await fetch(`${endpoint.replace(/\/$/, '')}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages, tools: settings.includeTools ? WORKSPACE_TOOLS : [], stream: false, think: settings.think, options: this.getOllamaOptions(settings) }),
        signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      const payload = await response.json() as { message?: OllamaMessage };
      const message = payload.message ?? { role: 'assistant', content: '' };
      messages.push(message);
      if (message.tool_calls?.length) {
        for (const call of message.tool_calls) {
          messages.push({ role: 'tool', content: await this.executeFileTool(call.function?.name ?? '', call.function?.arguments) });
        }
        continue;
      }
      if (message.content) {
        finalText += message.content;
        this.view?.webview.postMessage({ type: 'assistantChunk', text: message.content });
      }
      break;
    }
    return finalText;
  }

  private getOllamaOptions(settings: ChatRequestSettings): Record<string, number> {
    const options: Record<string, number> = { num_ctx: settings.numCtx };
    if (settings.computeMode === 'cpu') options.num_gpu = 0;
    if (settings.computeMode === 'layers') options.num_gpu = settings.gpuLayers;
    return options;
  }

  private async getEditorContext(
    maxBytes: number,
    includeActiveFile: boolean,
    includeTree: boolean,
    includeOpenTabs: boolean,
  ): Promise<{
    text: string;
    parts: { activeFile: number; tree: number; openTabs: number };
  }> {
    const sections: string[] = [];
    const parts = { activeFile: 0, tree: 0, openTabs: 0 };

    const appendSection = (section: string, part: keyof typeof parts): void => {
      if (!section || maxBytes <= 0) return;
      const separatorBytes = sections.length ? 2 : 0;
      const remaining = maxBytes - sections.reduce((sum, item) => sum + item.length, 0) - separatorBytes;
      if (remaining <= 0) return;
      const value = section.length > remaining
        ? section.slice(0, Math.max(0, remaining - 32)) + '\n[Context truncated]'
        : section;
      sections.push(value);
      parts[part] += value.length;
    };

    const active = includeActiveFile ? this.getActiveFileContext() : '';
    if (active) {
      appendSection(active, 'activeFile');
    }

    if (includeTree) {
      const tree = await this.getWorkspaceTree();
      if (tree) {
        appendSection(tree, 'tree');
      }
    }
    if (includeOpenTabs) {
      const tabs = await this.getOpenTabsContents();
      if (tabs) {
        appendSection(tabs, 'openTabs');
      }
    }
    return { text: sections.join('\n\n'), parts };
  }

  private getActiveFileContext(): string {
    const editor = vscode.window.activeTextEditor ?? this.lastEditor;
    if (!editor) return '';
    const document = editor.document;
    if (document.uri.scheme !== 'file' && document.uri.scheme !== 'untitled') return '';
    const language = document.languageId;
    const path = vscode.workspace.asRelativePath(document.uri);
    const fullText = document.getText();
    let output = `[Open file: ${path}]\n\`\`\`${language}\n${fullText}\n\`\`\``;
    const selection = editor.selection;
    if (!selection.isEmpty) {
      const selectedText = document.getText(selection);
      output += `\n\n[Selection from ${path} (lines ${selection.start.line + 1}-${selection.end.line + 1})]\n\`\`\`${language}\n${selectedText}\n\`\`\``;
    }
    return output;
  }

  private async getWorkspaceTree(): Promise<string> {
    if (!vscode.workspace.workspaceFolders?.length) return '';
    const config = vscode.workspace.getConfiguration('chatAi');
    const exclude = config.get<string[]>('context.exclude', []);
    const excludeGlob = exclude.length ? `{${exclude.join(',')}}` : null;
    const uris = await vscode.workspace.findFiles('**/*', excludeGlob);
    if (!uris.length) return '';
    const paths = uris.map((uri) => vscode.workspace.asRelativePath(uri)).sort();
    return `[Workspace files]\n${paths.join('\n')}`;
  }

  private async getOpenTabsContents(): Promise<string> {
    const config = vscode.workspace.getConfiguration('chatAi');
    const maxBytes = config.get<number>('context.maxBytes', 100000);
    const activeEditor = vscode.window.activeTextEditor ?? this.lastEditor;
    const seenUris = new Set<string>();
    if (activeEditor) seenUris.add(activeEditor.document.uri.toString());

    const output: string[] = [];
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input;
        if (!(input instanceof vscode.TabInputText)) continue;
        const uri = input.uri;
        const key = uri.toString();
        if (seenUris.has(key)) continue;
        seenUris.add(key);
        if (uri.scheme !== 'file' && uri.scheme !== 'untitled') continue;
        try {
          const data = await vscode.workspace.fs.readFile(uri);
          let text = new TextDecoder().decode(data);
          let truncated = false;
          if (text.length > maxBytes) {
            text = text.slice(0, maxBytes);
            truncated = true;
          }
          const path = vscode.workspace.asRelativePath(uri);
          const language = path.split('.').pop() ?? '';
          output.push(`[Open file: ${path}${truncated ? ' (truncated)' : ''}]\n\`\`\`${language}\n${text}\n\`\`\``);
        } catch {
          // ignore unreadable files
        }
      }
    }
    if (!output.length) return '';
    return output.join('\n\n');
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'chat.css'));
    const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'chat.js'));
    const csp =
      `default-src 'none'; ` +
      `style-src ${webview.cspSource}; ` +
      `script-src 'nonce-${nonce}'; ` +
      `img-src ${webview.cspSource} data:;`;
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<link rel="stylesheet" href="${cssUri}" />
</head>
<body>
<div class="chat-topbar">
  <div class="chat-title">chatAi</div>
  <div class="chat-version">v${this.extensionVersion}</div>
</div>
<div id="messages"></div>
<div id="approval" class="approval settings-panel" hidden>
  <div class="approval-header">Chat settings</div>
  <div id="approvalSummary" class="approval-summary"></div>
  <div class="settings-group">
    <div class="settings-section-title">Permissions</div>
    <div id="approvalList" class="approval-list"></div>
  </div>
  <div class="settings-group">
    <div class="settings-section-title">Context &amp; response</div>
    <label class="approval-option"><input type="checkbox" id="includeActiveFile"> Active file</label>
    <label class="approval-option"><input type="checkbox" id="includeTree"> Workspace files and folders</label>
    <label class="approval-option"><input type="checkbox" id="includeOpenTabs"> Open tabs</label>
    <label class="approval-option"><input type="checkbox" id="includeTools"> Tools</label>
    <label class="approval-option"><input type="checkbox" id="think"> Thinking</label>
    <label class="settings-select-row" for="computeMode">
      <span>Compute</span>
      <select id="computeMode" aria-label="Compute mode">
        <option value="cpu" selected>CPU</option>
        <option value="auto">Auto</option>
        <option value="layers">GPU layers</option>
      </select>
    </label>
    <label class="settings-select-row" for="gpuLayers">
      <span>GPU layers</span>
      <input id="gpuLayers" type="number" min="1" max="128" value="1" aria-label="GPU layers" disabled>
    </label>
    <label class="settings-select-row" for="contextSizeSelect">
      <span>Context size</span>
      <select id="contextSizeSelect" aria-label="Context size"></select>
    </label>
  </div>
  <div class="approval-actions">
    <button type="button" id="approveTool" class="primary">Save settings</button>
    <button type="button" id="allowSessionTool" hidden>Allow for this session</button>
    <button type="button" id="denyTool" class="secondary">Close</button>
  </div>
</div>
<form id="composer">
  <div class="context-row">
    <button type="button" id="toolAccessButton" class="tool-access-button" aria-label="Open chat settings" title="Chat settings">
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.7 1h2.6l.3 1.6c.4.1.8.3 1.2.5l1.4-.8 1.8 1.8-.8 1.4c.2.4.4.8.5 1.2l1.6.3v2.6l-1.6.3c-.1.4-.3.8-.5 1.2l.8 1.4-1.8 1.8-1.4-.8c-.4.2-.8.4-1.2.5L9.3 15H6.7l-.3-1.6c-.4-.1-.8-.3-1.2-.5l-1.4.8L2 11.9l.8-1.4c-.2-.4-.4-.8-.5-1.2L.7 9V6.4l1.6-.3c.1-.4.3-.8.5-1.2L2 3.5l1.8-1.8 1.4.8c.4.2.8.4 1.2.5L6.7 1zM8 5.2A2.5 2.5 0 1 0 8 10.2 2.5 2.5 0 0 0 8 5.2z"/></svg>
    </button>
    <div id="context" class="context" hidden></div>
  </div>
  <div id="contextSize" class="context-size" hidden></div>
  <textarea id="input" rows="2" placeholder="Ask chatAi..." autofocus></textarea>
  <div class="row">
    <label for="model" id="modelLabel">Model</label>
    <select id="model" aria-label="Model"></select>
    <span class="spacer"></span>
    <button type="button" id="cancel" hidden>Stop</button>
    <button type="submit" id="send">Send</button>
  </div>
</form>
<script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
