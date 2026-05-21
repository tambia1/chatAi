import * as vscode from 'vscode';

interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'chatAi.chat';

  private view?: vscode.WebviewView;
  private history: ChatTurn[] = [];
  private currentAbort?: AbortController;
  private lastEditor?: vscode.TextEditor;

  constructor(private readonly extensionUri: vscode.Uri) {
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
          await this.handleSend(String(message.text ?? ''), message.model ? String(message.model) : undefined);
          break;
        case 'cancel':
          this.currentAbort?.abort();
          break;
      }
    });
  }

  private postInit(): void {
    if (!this.view) return;
    const config = vscode.workspace.getConfiguration('chatAi');
    const models = config.get<string[]>('models', ['gemma4:31b', 'qwen3.6:35b']);
    const selected = config.get<string>('model', models[0] ?? 'gemma4:31b');
    this.view.webview.postMessage({ type: 'init', models, selected });
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
  ): void {
    if (!this.view) return;
    const bytes = messages.reduce((sum, message) => sum + message.content.length, 0);
    const tokens = Math.ceil(bytes / 4);
    let severity: 'ok' | 'warn' | 'over' = 'ok';
    if (tokens > numCtx) severity = 'over';
    else if (tokens > numCtx * 0.8) severity = 'warn';
    this.view.webview.postMessage({ type: 'contextSize', bytes, tokens, numCtx, severity });
  }

  clearChat(): void {
    this.history = [];
    this.currentAbort?.abort();
    this.view?.webview.postMessage({ type: 'clear' });
  }

  private async handleSend(text: string, requestedModel?: string): Promise<void> {
    if (!text.trim() || !this.view) return;

    this.history.push({ role: 'user', content: text });
    this.view.webview.postMessage({ type: 'user', text });
    this.view.webview.postMessage({ type: 'assistantStart' });

    const config = vscode.workspace.getConfiguration('chatAi');
    const endpoint = config.get<string>('endpoint', 'http://localhost:11434');
    const model = requestedModel?.trim() || config.get<string>('model', 'gemma4:31b');
    const numCtx = config.get<number>('numCtx', 32768);
    const messages = this.buildMessages(await this.getEditorContext());
    this.postContextSize(messages, numCtx);

    let assistantText = '';
    const controller = new AbortController();
    this.currentAbort = controller;

    try {
      const response = await fetch(`${endpoint.replace(/\/$/, '')}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages,
          stream: true,
          think: true,
          options: { num_ctx: numCtx },
        }),
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        this.view.webview.postMessage({
          type: 'error',
          text: `HTTP ${response.status} ${response.statusText}`,
        });
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newlineIndex: number;
        while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (!line) continue;
          try {
            const chunk = JSON.parse(line);
            const message = chunk.message ?? {};
            if (typeof message.thinking === 'string' && message.thinking.length > 0) {
              this.view.webview.postMessage({ type: 'thinkingChunk', text: message.thinking });
            }
            if (typeof message.content === 'string' && message.content.length > 0) {
              assistantText += message.content;
              this.view.webview.postMessage({ type: 'assistantChunk', text: message.content });
            }
            if (chunk.done) {
              this.view.webview.postMessage({ type: 'assistantEnd' });
            }
          } catch {
            // ignore non-JSON / partial lines
          }
        }
      }
    } catch (caughtError: unknown) {
      const error = caughtError as { name?: string; message?: string };
      if (error?.name === 'AbortError') {
        this.view.webview.postMessage({ type: 'assistantEnd' });
      } else {
        this.view.webview.postMessage({ type: 'error', text: error?.message ?? String(caughtError) });
      }
    } finally {
      this.currentAbort = undefined;
      if (assistantText) {
        this.history.push({ role: 'assistant', content: assistantText });
      }
    }
  }

  private buildMessages(liveContext: string): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];
    if (liveContext) {
      messages.push({ role: 'system', content: liveContext });
    }
    for (const turn of this.history) {
      messages.push({ role: turn.role, content: turn.content });
    }
    return messages;
  }

  private async getEditorContext(): Promise<string> {
    const parts: string[] = [];
    const active = this.getActiveFileContext();
    if (active) parts.push(active);

    const config = vscode.workspace.getConfiguration('chatAi');
    const includeTree = config.get<boolean>('context.includeTree', true);
    const includeOpenTabs = config.get<boolean>('context.includeOpenTabs', true);

    if (includeTree) {
      const tree = await this.getWorkspaceTree();
      if (tree) parts.push(tree);
    }
    if (includeOpenTabs) {
      const tabs = await this.getOpenTabsContents();
      if (tabs) parts.push(tabs);
    }
    return parts.join('\n\n');
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
<div id="messages"></div>
<form id="composer">
  <div id="context" class="context" hidden></div>
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
