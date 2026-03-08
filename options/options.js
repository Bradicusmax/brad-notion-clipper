// Options Page Script for Notion Clipper

document.addEventListener('DOMContentLoaded', init);

async function init() {
  // Display version from manifest
  const manifest = chrome.runtime.getManifest();
  document.getElementById('version').textContent = `v${manifest.version}`;

  // Load saved settings
  await loadSettings();

  // Event listeners
  document.getElementById('internal-btn').addEventListener('click', showTokenInput);
  document.getElementById('cancel-token-btn').addEventListener('click', hideTokenInput);
  document.getElementById('save-token-btn').addEventListener('click', saveToken);
  document.getElementById('disconnect-btn').addEventListener('click', disconnect);
  document.getElementById('edit-settings-btn').addEventListener('click', showEditSettings);
  document.getElementById('save-settings-btn').addEventListener('click', saveSettings);
  document.getElementById('cancel-settings-btn').addEventListener('click', hideEditSettings);
}

async function loadSettings() {
  const settings = await chrome.storage.local.get([
    'notionToken',
    'notionWorkspaceId',
    'notionParentPageId'
  ]);

  if (settings.notionToken) {
    showConnected(settings);
  } else {
    showAuth();
  }
}

function showAuth() {
  document.getElementById('auth-section').classList.remove('hidden');
  document.getElementById('token-section').classList.add('hidden');
  document.getElementById('connected-section').classList.add('hidden');
  document.getElementById('edit-settings-section').classList.add('hidden');
}

function showConnected(settings) {
  document.getElementById('auth-section').classList.add('hidden');
  document.getElementById('token-section').classList.add('hidden');
  document.getElementById('connected-section').classList.remove('hidden');
  document.getElementById('edit-settings-section').classList.add('hidden');

  // Show current settings summary
  const summary = document.getElementById('settings-summary');
  if (summary) {
    const wsId = settings?.notionWorkspaceId || '(not set)';
    const parentId = settings?.notionParentPageId || '(not set)';
    summary.innerHTML = '';

    const wsLine = document.createElement('div');
    wsLine.className = 'summary-line';
    wsLine.textContent = `Workspace ID: ${wsId}`;
    summary.appendChild(wsLine);

    const parentLine = document.createElement('div');
    parentLine.className = 'summary-line';
    parentLine.textContent = `Default Page ID: ${parentId}`;
    summary.appendChild(parentLine);
  }
}

function showTokenInput() {
  document.getElementById('auth-section').classList.add('hidden');
  document.getElementById('token-section').classList.remove('hidden');
}

function hideTokenInput() {
  // Don't wipe fields — just hide the section and go back to auth
  document.getElementById('token-section').classList.add('hidden');
  document.getElementById('auth-section').classList.remove('hidden');
}

async function showEditSettings() {
  // Load current values into the edit form
  const settings = await chrome.storage.local.get(['notionWorkspaceId', 'notionParentPageId']);
  document.getElementById('edit-workspace-id').value = settings.notionWorkspaceId || '';
  document.getElementById('edit-parent-page-id').value = settings.notionParentPageId || '';

  document.getElementById('connected-section').classList.add('hidden');
  document.getElementById('edit-settings-section').classList.remove('hidden');
}

function hideEditSettings() {
  document.getElementById('edit-settings-section').classList.add('hidden');
  document.getElementById('connected-section').classList.remove('hidden');
}

async function saveSettings() {
  const workspaceId = document.getElementById('edit-workspace-id').value.trim();
  const parentPageId = document.getElementById('edit-parent-page-id').value.trim();

  await chrome.storage.local.set({
    notionWorkspaceId: workspaceId || null,
    notionParentPageId: parentPageId || null
  });

  // Clear the destination cache so the popup picks up the new default
  await chrome.storage.local.remove(['destinationCache', 'destinationCacheTime']);

  const settings = await chrome.storage.local.get(['notionToken', 'notionWorkspaceId', 'notionParentPageId']);
  showConnected(settings);
  showOptionsStatus('Settings saved!', 'success');
}

async function saveToken() {
  const token = document.getElementById('api-token').value.trim();
  const workspaceId = document.getElementById('workspace-id').value.trim();
  const parentPageId = document.getElementById('parent-page-id').value.trim();

  if (!token) {
    showOptionsStatus('Please enter your API token.', 'error');
    return;
  }

  // Validate token format
  if (!token.startsWith('secret_') && !token.startsWith('ntn_')) {
    if (!confirm('Your token should start with "secret_" or "ntn_". Continue anyway?')) {
      return;
    }
  }

  // Validate the token BEFORE saving it
  const saveBtn = document.getElementById('save-token-btn');
  saveBtn.disabled = true;
  saveBtn.textContent = 'Connecting...';

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'VALIDATE_TOKEN',
      token: token
    });

    if (!response.success) {
      throw new Error(response.error);
    }

    // Token is valid — now save everything
    await chrome.storage.local.set({
      notionToken: token,
      notionWorkspaceId: workspaceId || null,
      notionParentPageId: parentPageId || null
    });

    // Clear any stale cache
    await chrome.storage.local.remove(['destinationCache', 'destinationCacheTime']);

    const settings = await chrome.storage.local.get(['notionToken', 'notionWorkspaceId', 'notionParentPageId']);
    showConnected(settings);
    showOptionsStatus('Connected successfully!', 'success');

  } catch (error) {
    showOptionsStatus('Could not connect: ' + error.message, 'error');
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save';
  }
}

async function disconnect() {
  if (confirm('Disconnect from Notion? You will need to re-enter your token to reconnect.')) {
    await chrome.storage.local.remove([
      'notionToken',
      'notionWorkspaceId',
      'notionParentPageId',
      'destinationCache',
      'destinationCacheTime',
      'recentPages'
    ]);
    showAuth();
    showOptionsStatus('Disconnected from Notion.', 'info');
  }
}

function showOptionsStatus(message, type) {
  let statusEl = document.getElementById('options-status');
  if (!statusEl) {
    statusEl = document.createElement('div');
    statusEl.id = 'options-status';
    document.querySelector('.container').appendChild(statusEl);
  }
  statusEl.textContent = message;
  statusEl.className = `options-status ${type}`;
  statusEl.classList.remove('hidden');

  setTimeout(() => {
    statusEl.classList.add('hidden');
  }, 4000);
}
