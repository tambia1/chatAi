(function () {
  const vscode = acquireVsCodeApi();
  const messagesElement = document.getElementById('messages');
  const form = document.getElementById('composer');
  const input = document.getElementById('input');
  const sendButton = document.getElementById('send');
  const cancelButton = document.getElementById('cancel');
  const modelSelectElement = document.getElementById('model');
  const contextElement = document.getElementById('context');
  const contextSizeElement = document.getElementById('contextSize');

  let currentAssistant = null;

  const FILE_ICON_SVG =
    '<svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor" aria-hidden="true">' +
    '<path d="M9 1H3a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V6L9 1zm0 1.5L12.5 6H9V2.5z"/>' +
    '</svg>';

  const SEL_ICON_SVG =
    '<svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor" aria-hidden="true">' +
    '<path d="M3 3h4v1H4v3H3V3zm6 0h4v4h-1V4H9V3zM3 9h1v3h3v1H3V9zm9 0h1v4H9v-1h3V9z"/>' +
    '<path d="M5 6h6v1H5V6zm0 2h6v1H5V8zm0 2h4v1H5v-1z"/>' +
    '</svg>';

  function makeChip(iconSvg, label, tooltip) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    if (tooltip) chip.title = tooltip;
    const icon = document.createElement('span');
    icon.className = 'chip-icon';
    icon.innerHTML = iconSvg;
    const name = document.createElement('span');
    name.className = 'chip-name';
    name.textContent = label;
    chip.appendChild(icon);
    chip.appendChild(name);
    return chip;
  }

  function renderContext(file, selection) {
    contextElement.innerHTML = '';
    if (!file) {
      contextElement.hidden = true;
      return;
    }
    contextElement.hidden = false;
    contextElement.appendChild(makeChip(FILE_ICON_SVG, file.name, file.path));
    if (selection) {
      const range =
        selection.startLine === selection.endLine
          ? 'line ' + selection.startLine
          : 'lines ' + selection.startLine + '\u2013' + selection.endLine;
      contextElement.appendChild(makeChip(SEL_ICON_SVG, range, 'Selection in ' + file.path));
    }
  }

  function formatKB(bytes) {
    if (bytes < 1024) return bytes + ' B';
    return (bytes / 1024).toFixed(bytes < 10240 ? 1 : 0) + ' KB';
  }

  function formatTokens(tokens) {
    if (tokens < 1000) return String(tokens);
    if (tokens < 10000) return (Math.floor(tokens / 100) / 10).toFixed(1) + 'k';
    return Math.floor(tokens / 1000) + 'k';
  }

  function renderContextSize(bytes, tokens, numCtx, severity, parts) {
    contextSizeElement.hidden = false;
    contextSizeElement.className = 'context-size ' + (severity || 'ok');
    contextSizeElement.textContent =
      'context: ' + formatTokens(tokens) + ' / ' + formatTokens(numCtx) +
      ' tokens (' + formatKB(bytes) + ')';

    const lines = [];
    if (parts) {
      const row = (label, byteCount) => {
        if (!byteCount) return;
        lines.push(label + ': ~' + formatTokens(Math.ceil(byteCount / 4)) + ' tokens (' + formatKB(byteCount) + ')');
      };
      row('Active file', parts.activeFile);
      row('Workspace tree', parts.tree);
      row('Open tabs', parts.openTabs);
      row('Conversation', parts.conversation);
      if (lines.length) lines.push('');
    }
    lines.push('Total: ~' + formatTokens(tokens) + ' tokens (' + formatKB(bytes) + ')');
    lines.push('Limit: ' + formatTokens(numCtx) + ' tokens (chatAi.numCtx)');
    contextSizeElement.title = lines.join('\n');
  }

  function populateModels(models, selected) {
    modelSelectElement.innerHTML = '';
    const saved = (vscode.getState() || {}).model;
    const preferred = (saved && models.includes(saved)) ? saved : selected;
    for (const modelName of models) {
      const option = document.createElement('option');
      option.value = modelName;
      option.textContent = modelName;
      if (modelName === preferred) option.selected = true;
      modelSelectElement.appendChild(option);
    }
  }

  modelSelectElement.addEventListener('change', () => {
    const state = vscode.getState() || {};
    state.model = modelSelectElement.value;
    vscode.setState(state);
  });

  function addMessage(role, text) {
    const element = document.createElement('div');
    element.className = 'message ' + role;
    element.textContent = text;
    messagesElement.appendChild(element);
    messagesElement.scrollTop = messagesElement.scrollHeight;
    return element;
  }

  function addAssistantMessage() {
    const wrapper = document.createElement('div');
    wrapper.className = 'message assistant';

    const loader = document.createElement('div');
    loader.className = 'loader';
    loader.innerHTML = '<span></span><span></span><span></span>';
    wrapper.appendChild(loader);

    const thinking = document.createElement('div');
    thinking.className = 'thinking';
    thinking.hidden = true;
    const thinkingHeader = document.createElement('div');
    thinkingHeader.className = 'thinking-header';
    thinkingHeader.textContent = 'Thinking...';
    const thinkingContent = document.createElement('div');
    thinkingContent.className = 'thinking-content';
    const thinkingFooter = document.createElement('div');
    thinkingFooter.className = 'thinking-footer';
    thinkingFooter.textContent = '...done thinking.';
    thinkingFooter.hidden = true;
    thinking.appendChild(thinkingHeader);
    thinking.appendChild(thinkingContent);
    thinking.appendChild(thinkingFooter);

    const response = document.createElement('div');
    response.className = 'response';

    wrapper.appendChild(thinking);
    wrapper.appendChild(response);
    messagesElement.appendChild(wrapper);
    messagesElement.scrollTop = messagesElement.scrollHeight;
    return { loader, thinking, thinkingContent, thinkingFooter, response };
  }

  function hideLoader(assistant) {
    if (assistant && assistant.loader) {
      assistant.loader.remove();
      assistant.loader = null;
    }
  }

  function setStreaming(streaming) {
    sendButton.hidden = streaming;
    cancelButton.hidden = !streaming;
    input.disabled = streaming;
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    vscode.postMessage({ type: 'send', text, model: modelSelectElement.value });
  });

  cancelButton.addEventListener('click', () => {
    vscode.postMessage({ type: 'cancel' });
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      form.requestSubmit();
    }
  });

  window.addEventListener('message', (event) => {
    const message = event.data;
    switch (message.type) {
      case 'init':
        populateModels(message.models || [], message.selected);
        break;
      case 'context':
        renderContext(message.file, message.selection);
        break;
      case 'contextSize':
        renderContextSize(message.bytes, message.tokens, message.numCtx, message.severity, message.parts);
        break;
      case 'user':
        addMessage('user', message.text);
        break;
      case 'assistantStart':
        currentAssistant = addAssistantMessage();
        setStreaming(true);
        break;
      case 'thinkingChunk':
        if (currentAssistant) {
          hideLoader(currentAssistant);
          currentAssistant.thinking.hidden = false;
          currentAssistant.thinkingContent.textContent += message.text;
          messagesElement.scrollTop = messagesElement.scrollHeight;
        }
        break;
      case 'assistantChunk':
        if (currentAssistant) {
          hideLoader(currentAssistant);
          if (!currentAssistant.thinking.hidden) {
            currentAssistant.thinkingFooter.hidden = false;
          }
          currentAssistant.response.textContent += message.text;
          messagesElement.scrollTop = messagesElement.scrollHeight;
        }
        break;
      case 'assistantEnd':
        hideLoader(currentAssistant);
        currentAssistant = null;
        setStreaming(false);
        input.focus();
        break;
      case 'error':
        hideLoader(currentAssistant);
        addMessage('error', message.text);
        currentAssistant = null;
        setStreaming(false);
        break;
      case 'clear':
        messagesElement.innerHTML = '';
        currentAssistant = null;
        setStreaming(false);
        break;
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
