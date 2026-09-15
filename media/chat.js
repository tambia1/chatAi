(function () {
  const vscode = acquireVsCodeApi();
  const messagesElement = document.getElementById('messages');
  const form = document.getElementById('composer');
  const input = document.getElementById('input');
  const sendButton = document.getElementById('send');
  const cancelButton = document.getElementById('cancel');
  const modelSelectElement = document.getElementById('model');
  const contextSelectElement = document.getElementById('contextSizeSelect');
  const contextElement = document.getElementById('context');
  const contextSizeElement = document.getElementById('contextSize');
  const approvalElement = document.getElementById('approval');
  const approvalSummaryElement = document.getElementById('approvalSummary');
  const approvalListElement = document.getElementById('approvalList');
  const approveToolButton = document.getElementById('approveTool');
  const allowSessionToolButton = document.getElementById('allowSessionTool');
  const denyToolButton = document.getElementById('denyTool');
  const toolAccessButton = document.getElementById('toolAccessButton');
  const includeActiveFileElement = document.getElementById('includeActiveFile');
  const includeTreeElement = document.getElementById('includeTree');
  const includeOpenTabsElement = document.getElementById('includeOpenTabs');
  const includeToolsElement = document.getElementById('includeTools');
  const thinkElement = document.getElementById('think');
  const computeModeElement = document.getElementById('computeMode');
  const gpuLayersElement = document.getElementById('gpuLayers');

  let currentAssistant = null;
  let approvalMode = null;
  const CONTEXT_SIZES = [2048, 4096, 8192, 16384];

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

  function populateContextSizes(selected, useSaved = true) {
    contextSelectElement.innerHTML = '';
    const saved = (vscode.getState() || {}).numCtx;
    const preferred = useSaved && CONTEXT_SIZES.includes(saved)
      ? saved
      : (CONTEXT_SIZES.includes(selected) ? selected : 2048);
    for (const size of CONTEXT_SIZES) {
      const option = document.createElement('option');
      option.value = String(size);
      option.textContent = (size / 1024) + 'k';
      option.selected = size === preferred;
      contextSelectElement.appendChild(option);
    }
  }

  contextSelectElement.addEventListener('change', () => {
    const state = vscode.getState() || {};
    state.numCtx = Number(contextSelectElement.value);
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

  function formatTimer(ms) {
    const totalMs = Math.max(0, ms);
    const hours = Math.floor(totalMs / 3600000);
    const minutes = Math.floor((totalMs % 3600000) / 60000);
    const seconds = Math.floor((totalMs % 60000) / 1000);
    const millis = Math.floor(totalMs % 1000);
    const hh = String(hours).padStart(2, '0');
    const mm = String(minutes).padStart(2, '0');
    const ss = String(seconds).padStart(2, '0');
    const msText = String(millis).padStart(3, '0');
    return hh + ':' + mm + ':' + ss + '.' + msText;
  }

  function formatDuration(ms) {
    if (ms < 1000) return ms + ' ms';
    if (ms < 60000) return (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + ' s';
    return (ms / 60000).toFixed(1) + ' min';
  }

  function startAssistantTimer(assistant) {
    if (!assistant) return;
    assistant.timerStartedAt = performance.now();
    assistant.timerInterval = window.setInterval(() => {
      const elapsed = performance.now() - assistant.timerStartedAt;
      assistant.responseMeta.hidden = false;
      assistant.responseMeta.textContent = formatTimer(elapsed);
    }, 16);
  }

  function stopAssistantTimer(assistant) {
    if (!assistant) return;
    if (assistant.timerInterval) {
      window.clearInterval(assistant.timerInterval);
      assistant.timerInterval = null;
    }
  }

  function addAssistantMessage() {
    const wrapper = document.createElement('div');
    wrapper.className = 'message assistant';

    const responseMeta = document.createElement('div');
    responseMeta.className = 'response-meta';
    responseMeta.hidden = true;

    wrapper.appendChild(responseMeta);

    const loader = document.createElement('div');
    loader.className = 'loader';
    loader.innerHTML = '<span></span><span></span><span></span>';
    wrapper.appendChild(loader);

    const thinking = document.createElement('div');
    thinking.className = 'thinking';
    const thinkingHeader = document.createElement('div');
    thinkingHeader.className = 'thinking-header';
    thinkingHeader.textContent = 'Thinking...';
    const thinkingContent = document.createElement('div');
    thinkingContent.className = 'thinking-content';
    thinkingContent.textContent = 'Waiting for response...';
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
    return { loader, thinking, thinkingContent, thinkingFooter, response, responseMeta };
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

  function showSettings(tools, settings) {
    approvalMode = 'config';
    approvalSummaryElement.textContent = 'Choose what chatAi can access and include in requests';
    approvalListElement.hidden = false;
    approvalListElement.innerHTML = '';

    const selected = new Set((tools || []).filter((tool) => tool.selected).map((tool) => tool.name));
    const groups = new Map();
    for (const tool of tools) {
      const groupName = tool.group || 'Other';
      if (!groups.has(groupName)) groups.set(groupName, []);
      groups.get(groupName).push(tool);
    }

    for (const [groupName, groupTools] of groups) {
      const group = document.createElement('div');
      group.className = 'approval-group';

      const heading = document.createElement('div');
      heading.className = 'approval-group-title';
      heading.textContent = groupName;
      group.appendChild(heading);

      for (const tool of groupTools) {
        const row = document.createElement('label');
        row.className = 'approval-option';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = selected.has(tool.name) || tool.requiresConfirmation === false;
        checkbox.value = tool.name;

        const label = document.createElement('span');
        label.textContent = tool.name;

        row.appendChild(checkbox);
        row.appendChild(label);
        group.appendChild(row);
      }
      approvalListElement.appendChild(group);
    }

    includeActiveFileElement.checked = settings?.includeActiveFile !== false;
    includeTreeElement.checked = settings?.includeTree !== false;
    includeOpenTabsElement.checked = settings?.includeOpenTabs !== false;
    includeToolsElement.checked = settings?.includeTools === true;
    thinkElement.checked = settings?.think === true;
    computeModeElement.value = settings?.computeMode || 'cpu';
    gpuLayersElement.value = String(settings?.gpuLayers || 1);
    gpuLayersElement.disabled = computeModeElement.value !== 'layers';
    populateContextSizes(settings?.numCtx, false);
    approveToolButton.textContent = 'Save settings';
    allowSessionToolButton.hidden = true;
    denyToolButton.textContent = 'Close';
    approvalElement.hidden = false;
  }

  function hideApproval() {
    approvalMode = null;
    approvalListElement.innerHTML = '';
    approvalListElement.hidden = true;
    approvalElement.hidden = true;
  }

  approveToolButton.addEventListener('click', () => {
    if (approvalMode === 'config') {
      const selected = Array.from(approvalListElement.querySelectorAll('input:checked')).map((input) => input.value);
      vscode.postMessage({
        type: 'saveSettings',
        tools: selected,
        settings: getRequestSettings(),
      });
      hideApproval();
      return;
    }
    hideApproval();
  });

  allowSessionToolButton.addEventListener('click', () => {
    hideApproval();
  });

  denyToolButton.addEventListener('click', () => {
    if (approvalMode === 'config') {
      hideApproval();
      return;
    }
    hideApproval();
  });

  toolAccessButton.addEventListener('click', () => {
    if (!approvalElement.hidden) {
      hideApproval();
      return;
    }
    vscode.postMessage({ type: 'requestSettingsState' });
  });

  computeModeElement.addEventListener('change', () => {
    gpuLayersElement.disabled = computeModeElement.value !== 'layers';
  });

  function getRequestSettings() {
    return {
      includeActiveFile: includeActiveFileElement.checked,
      includeTree: includeTreeElement.checked,
      includeOpenTabs: includeOpenTabsElement.checked,
      includeTools: includeToolsElement.checked,
      think: thinkElement.checked,
      numCtx: Number(contextSelectElement.value),
      computeMode: computeModeElement.value,
      gpuLayers: Number(gpuLayersElement.value),
    };
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    vscode.postMessage({ type: 'send', text, model: modelSelectElement.value, settings: getRequestSettings() });
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
        populateContextSizes(message.numCtx);
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
        currentAssistant.responseMeta.hidden = false;
        currentAssistant.responseMeta.textContent = '00:00:00.000';
        startAssistantTimer(currentAssistant);
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
      case 'assistantEnd': {
        const assistant = currentAssistant;
        hideLoader(assistant);
        stopAssistantTimer(assistant);
        if (assistant && assistant.responseMeta) {
          const duration = typeof message.durationMs === 'number' ? message.durationMs : 0;
          assistant.responseMeta.hidden = false;
          assistant.responseMeta.textContent = formatTimer(duration);
        }
        currentAssistant = null;
        setStreaming(false);
        input.focus();
        break;
      }
      case 'error':
        hideLoader(currentAssistant);
        stopAssistantTimer(currentAssistant);
        addMessage('error', message.text);
        currentAssistant = null;
        setStreaming(false);
        break;
      case 'settingsState': {
        showSettings(message.tools || [], message.settings);
        break;
      }
      case 'clear':
        messagesElement.innerHTML = '';
        hideApproval();
        currentAssistant = null;
        setStreaming(false);
        break;
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
