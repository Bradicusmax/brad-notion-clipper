// Options Page Script for Notion Clipper

document.addEventListener('DOMContentLoaded', init);

async function init() {
  // Load saved settings
  await loadSettings();
  
  // Event listeners
  document.getElementById('internal-btn').addEventListener('click', showTokenInput);
  document.getElementById('cancel-token-btn').addEventListener('click', hideTokenInput);
  document.getElementById('save-token-btn').addEventListener('click', saveToken);
  document.getElementById('disconnect-btn').addEventListener('click', disconnect);
}

async function loadSettings() {
  const settings = await chrome.storage.local.get([
    'notionToken',
    'notionWorkspaceId',
    'notionParentPageId'
  ]);
  
  if (settings.notionToken) {
    showConnected();
    document.getElementById('workspace-id').value = settings.notionWorkspaceId || '';
    document.getElementById('parent-page-id').value = settings.notionParentPageId || '';
  } else {
    showAuth();
  }
}

function showAuth() {
  document.getElementById('auth-section').classList.remove('hidden');
  document.getElementById('token-section').classList.add('hidden');
  document.getElementById('connected-section').classList.add('hidden');
}

function showConnected() {
  document.getElementById('auth-section').classList.add('hidden');
  document.getElementById('token-section').classList.add('hidden');
  document.getElementById('connected-section').classList.remove('hidden');
}

function showTokenInput() {
  document.getElementById('auth-section').classList.add('hidden');
  document.getElementById('token-section').classList.remove('hidden');
}

function hideTokenInput() {
  document.getElementById('token-section').classList.add('hidden');
  document.getElementById('auth-section').classList.remove('hidden');
  document.getElementById('api-token').value = '';
  document.getElementById('workspace-id').value = '';
  document.getElementById('parent-page-id').value = '';
}

async function saveToken() {
  const token = document.getElementById('api-token').value.trim();
  const workspaceId = document.getElementById('workspace-id').value.trim();
  const parentPageId = document.getElementById('parent-page-id').value.trim();
  
  if (!token) {
    alert('Please enter your API token');
    return;
  }
  
  // Validate token format
  if (!token.startsWith('secret_')) {
    if (!confirm('Your token should start with "secret_". Continue anyway?')) {
      return;
    }
  }
  
  // Save to storage
  await chrome.storage.local.set({
    notionToken: token,
    notionWorkspaceId: workspaceId || null,
    notionParentPageId: parentPageId || null
  });
  
  // Test the token
  try {
    const response = await fetch('https://api.notion.com/v1/users/me', {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Notion-Version': '2022-06-28'
      }
    });
    
    if (!response.ok) {
      throw new Error('Invalid token');
    }
    
    showConnected();
    alert('Connected successfully!');
    
  } catch (error) {
    alert('Error connecting to Notion: ' + error.message);
    await chrome.storage.local.remove(['notionToken']);
  }
}

async function disconnect() {
  if (confirm('Disconnect from Notion?')) {
    await chrome.storage.local.remove([
      'notionToken',
      'notionWorkspaceId',
      'notionParentPageId'
    ]);
    showAuth();
  }
}
