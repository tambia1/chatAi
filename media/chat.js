(function () {
  const vscode = acquireVsCodeApi();
  const messagesEl = document.getElementById('messages');
  const form = document.getElementById('composer');
  const input = document.getElementById('input');
  const sendBtn = document.getElementById('send');
  const cancelBtn = document.getElementById('cancel');
  const modelSelect = document.getElementById('model');
  const contextEl = document.getElementById('context');

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
    contextEl.innerHTML = '';
    if (!file) {
      contextEl.hidden = true;
      return;
    }
    contextEl.hidden = false;
    contextEl.appendChild(makeChip(FILE_ICON_SVG, file.name, file.path));
    if (selection) {
      const range =
        selection.startLine === selection.endLine
          ? 'line ' + selection.startLine
          : 'lines ' + selection.startLine + '\u2013' + selection.endLine;
      contextEl.appendChild(makeChip(SEL_ICON_SVG, range, 'Selection in ' + file.path));
    }
  }

  function populateModels(models, selected) {
    modelSelect.innerHTML = '';
    const saved = (vscode.getState() || {}).model;
    const preferred = (saved && models.includes(saved)) ? saved : selected;
    for (const m of models) {
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = m;
      if (m === preferred) opt.selected = true;
      modelSelect.appendChild(opt);
    }
  }

  modelSelect.addEventListener('change', () => {
    const state = vscode.getState() || {};
    state.model = modelSelect.value;
    vscode.setState(state);
  });

  function addMessage(role, text) {
    const el = document.createElement('div');
    el.className = 'msg ' + role;
    el.textContent = text;
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return el;
  }

  function addAssistantMessage() {
    const wrap = document.createElement('div');
    wrap.className = 'msg assistant';

    const loader = document.createElement('div');
    loader.className = 'loader';
    loader.innerHTML = '<span></span><span></span><span></span>';
    wrap.appendChild(loader);

    const thinking = document.createElement('div');
    thinking.className = 'thinking';
    thinking.hidden = true;
    const tHeader = document.createElement('div');
    tHeader.className = 'thinking-header';
    tHeader.textContent = 'Thinking...';
    const tContent = document.createElement('div');
    tContent.className = 'thinking-content';
    const tFooter = document.createElement('div');
    tFooter.className = 'thinking-footer';
    tFooter.textContent = '...done thinking.';
    tFooter.hidden = true;
    thinking.appendChild(tHeader);
    thinking.appendChild(tContent);
    thinking.appendChild(tFooter);

    const response = document.createElement('div');
    response.className = 'response';

    wrap.appendChild(thinking);
    wrap.appendChild(response);
    messagesEl.appendChild(wrap);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return { loader, thinking, tContent, tFooter, response };
  }

  function hideLoader(a) {
    if (a && a.loader) {
      a.loader.remove();
      a.loader = null;
    }
  }

  function setStreaming(streaming) {
    sendBtn.hidden = streaming;
    cancelBtn.hidden = !streaming;
    input.disabled = streaming;
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    vscode.postMessage({ type: 'send', text, model: modelSelect.value });
  });

  cancelBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'cancel' });
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'init':
        populateModels(msg.models || [], msg.selected);
        break;
      case 'context':
        renderContext(msg.file, msg.selection);
        break;
      case 'user':
        addMessage('user', msg.text);
        break;
      case 'assistantStart':
        currentAssistant = addAssistantMessage();
        setStreaming(true);
        break;
      case 'thinkingChunk':
        if (currentAssistant) {
          hideLoader(currentAssistant);
          currentAssistant.thinking.hidden = false;
          currentAssistant.tContent.textContent += msg.text;
          messagesEl.scrollTop = messagesEl.scrollHeight;
        }
        break;
      case 'assistantChunk':
        if (currentAssistant) {
          hideLoader(currentAssistant);
          if (!currentAssistant.thinking.hidden) {
            currentAssistant.tFooter.hidden = false;
          }
          currentAssistant.response.textContent += msg.text;
          messagesEl.scrollTop = messagesEl.scrollHeight;
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
        addMessage('error', msg.text);
        currentAssistant = null;
        setStreaming(false);
        break;
      case 'clear':
        messagesEl.innerHTML = '';
        currentAssistant = null;
        setStreaming(false);
        break;
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
