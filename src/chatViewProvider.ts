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
    vscode.window.onDidChangeActiveTextEditor((e) => {
      if (e) this.lastEditor = e;
      this.postContext();
    });
    vscode.window.onDidChangeTextEditorSelection((e) => {
      if (e.textEditor === this.lastEditor || e.textEditor === vscode.window.activeTextEditor) {
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

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      switch (msg?.type) {
        case 'ready':
          this.postInit();
          break;
        case 'send':
          await this.handleSend(String(msg.text ?? ''), msg.model ? String(msg.model) : undefined);
          break;
        case 'cancel':
          this.currentAbort?.abort();
          break;
      }
    });
  }

  private postInit(): void {
    if (!this.view) return;
    const cfg = vscode.workspace.getConfiguration('chatAi');
    const models = cfg.get<string[]>('models', ['gemma4:31b', 'qwen3.6:35b']);
    const selected = cfg.get<string>('model', models[0] ?? 'gemma4:31b');
    this.view.webview.postMessage({ type: 'init', models, selected });
    this.postContext();
  }

  private postContext(): void {
    if (!this.view) return;
    const ed = vscode.window.activeTextEditor ?? this.lastEditor;
    if (!ed) {
      this.view.webview.postMessage({ type: 'context', file: null, selection: null });
      return;
    }
    const doc = ed.document;
    if (doc.uri.scheme !== 'file' && doc.uri.scheme !== 'untitled') {
      this.view.webview.postMessage({ type: 'context', file: null, selection: null });
      return;
    }
    const path = vscode.workspace.asRelativePath(doc.uri);
    const name = path.split(/[\\/]/).pop() || path;
    const sel = ed.selection;
    const selection = sel.isEmpty
      ? null
      : { startLine: sel.start.line + 1, endLine: sel.end.line + 1 };
    this.view.webview.postMessage({ type: 'context', file: { name, path }, selection });
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

    const cfg = vscode.workspace.getConfiguration('chatAi');
    const endpoint = cfg.get<string>('endpoint', 'http://localhost:11434');
    const model = requestedModel?.trim() || cfg.get<string>('model', 'gemma4:31b');
    const messages = this.buildMessages(this.getEditorContext());

    let assistantText = '';
    const controller = new AbortController();
    this.currentAbort = controller;

    try {
      const res = await fetch(`${endpoint.replace(/\/$/, '')}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages, stream: true, think: true }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        this.view.webview.postMessage({
          type: 'error',
          text: `HTTP ${res.status} ${res.statusText}`,
        });
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          try {
            const obj = JSON.parse(line);
            const msg = obj.message ?? {};
            if (typeof msg.thinking === 'string' && msg.thinking.length > 0) {
              this.view.webview.postMessage({ type: 'thinkingChunk', text: msg.thinking });
            }
            if (typeof msg.content === 'string' && msg.content.length > 0) {
              assistantText += msg.content;
              this.view.webview.postMessage({ type: 'assistantChunk', text: msg.content });
            }
            if (obj.done) {
              this.view.webview.postMessage({ type: 'assistantEnd' });
            }
          } catch {
            // ignore non-JSON / partial lines
          }
        }
      }
    } catch (err: unknown) {
      const e = err as { name?: string; message?: string };
      if (e?.name === 'AbortError') {
        this.view.webview.postMessage({ type: 'assistantEnd' });
      } else {
        this.view.webview.postMessage({ type: 'error', text: e?.message ?? String(err) });
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
    for (const t of this.history) {
      messages.push({ role: t.role, content: t.content });
    }
    return messages;
  }

  private getEditorContext(): string {
    const ed = vscode.window.activeTextEditor ?? this.lastEditor;
    if (!ed) return '';
    const doc = ed.document;
    if (doc.uri.scheme !== 'file' && doc.uri.scheme !== 'untitled') return '';
    const lang = doc.languageId;
    const path = vscode.workspace.asRelativePath(doc.uri);
    const fullText = doc.getText();
    let out = `[Open file: ${path}]\n\`\`\`${lang}\n${fullText}\n\`\`\``;
    const sel = ed.selection;
    if (!sel.isEmpty) {
      const selected = doc.getText(sel);
      out += `\n\n[Selection from ${path} (lines ${sel.start.line + 1}-${sel.end.line + 1})]\n\`\`\`${lang}\n${selected}\n\`\`\``;
    }
    return out;
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
