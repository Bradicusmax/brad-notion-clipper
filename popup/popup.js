// Popup Script for Notion Clipper

document.addEventListener('DOMContentLoaded', init);

async function init() {
  // Check authentication status
  const authData = await chrome.storage.local.get(['notionToken', 'notionWorkspaceId']);
  
  if (authData.notionToken) {
    showClipSection();
    loadCurrentTab();
    loadDestinations();
  } else {
    showAuthSection();
  }
  
  // Event listeners
  document.getElementById('auth-btn').addEventListener('click', startAuth);
  document.getElementById('save-btn').addEventListener('click', saveToNotion);
  document.getElementById('refresh-destinations').addEventListener('click', loadDestinations);
  document.getElementById('options-link').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });
}

function showAuthSection() {
  document.getElementById('auth-section').classList.remove('hidden');
  document.getElementById('clip-section').classList.add('hidden');
}

function showClipSection() {
  document.getElementById('auth-section').classList.add('hidden');
  document.getElementById('clip-section').classList.remove('hidden');
}

async function loadCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  
  if (tab) {
    document.getElementById('page-title').value = tab.title || '';
    document.getElementById('page-url').textContent = tab.url || '';
    
    // Try to get favicon
    const faviconUrl = `https://www.google.com/s2/favicons?domain=${new URL(tab.url).hostname}&sz=32`;
    const faviconImg = document.getElementById('favicon');
    faviconImg.src = faviconUrl;
    faviconImg.classList.remove('hidden');
  }
}

async function loadDestinations() {
  const select = document.getElementById('destination');
  const refreshBtn = document.getElementById('refresh-destinations');
  
  select.innerHTML = '<option value="">Loading...</option>';
  refreshBtn.disabled = true;
  
  try {
    const authData = await chrome.storage.local.get(['notionToken', 'notionWorkspaceId']);
    
    if (!authData.notionToken) {
      throw new Error('Not authenticated');
    }
    
    // Get pages and databases
    const pages = await fetchNotionPages(authData.notionToken);
    
    select.innerHTML = '<option value="">Select destination...</option>';
    
    // Add parent page option if set
    const parentId = await chrome.storage.local.get(['notionParentPageId']);
    if (parentId.notionParentPageId) {
      const option = document.createElement('option');
      option.value = parentId.notionParentPageId;
      option.textContent = '★ Default Page';
      select.appendChild(option);
    }
    
    // Add pages
    pages.forEach(page => {
      const option = document.createElement('option');
      option.value = page.id;
      option.textContent = page.title;
      select.appendChild(option);
    });
    
    // Add "Create new page" option
    const createOption = document.createElement('option');
    createOption.value = 'new';
    createOption.textContent = '+ Create new page';
    select.appendChild(createOption);
    
  } catch (error) {
    showStatus('Error loading destinations: ' + error.message, 'error');
    select.innerHTML = '<option value="">Error loading</option>';
  } finally {
    refreshBtn.disabled = false;
  }
}

async function fetchNotionPages(token) {
  const response = await fetch('https://api.notion.com/v1/search', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      filter: {
        property: 'object',
        value: 'page'
      },
      page_size: 50
    })
  });
  
  if (!response.ok) {
    throw new Error('Failed to fetch pages');
  }
  
  const data = await response.json();
  
  return data.results.map(page => {
    const title = page.properties?.title?.title?.[0]?.plain_text || 
                 page.properties?.Name?.title?.[0]?.plain_text ||
                 'Untitled';
    return { id: page.id, title };
  });
}

async function startAuth() {
  // Open options page for auth setup
  showStatus('Opening settings to connect Notion...', 'info');
  setTimeout(() => {
    chrome.runtime.openOptionsPage();
  }, 1000);
}

async function saveToNotion() {
  const saveBtn = document.getElementById('save-btn');
  const btnText = saveBtn.querySelector('.btn-text');
  const btnLoading = saveBtn.querySelector('.btn-loading');
  
  const title = document.getElementById('page-title').value.trim();
  const notes = document.getElementById('notes').value.trim();
  const destination = document.getElementById('destination').value;
  
  if (!title) {
    showStatus('Please enter a title', 'error');
    return;
  }
  
  if (!destination) {
    showStatus('Please select a destination', 'error');
    return;
  }
  
  // Check if we need to create new page
  let parentId = destination;
  if (destination === 'new') {
    showStatus('Creating new page...', 'info');
    parentId = await createNewPage(title);
    if (!parentId) return;
  }
  
  // Show loading state
  saveBtn.disabled = true;
  btnText.classList.add('hidden');
  btnLoading.classList.remove('hidden');
  hideStatus();
  
  try {
    const authData = await chrome.storage.local.get(['notionToken']);
    
    const response = await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authData.notionToken}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        parent: { page_id: parentId },
        properties: {
          title: {
            title: [{ text: { content: title } }]
          }
        },
        children: buildPageContent(title, notes)
      })
    });
    
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || 'Failed to create page');
    }
    
    showStatus('Saved to Notion! ✓', 'success');
    
    // Clear notes
    document.getElementById('notes').value = '';
    
  } catch (error) {
    showStatus('Error: ' + error.message, 'error');
  } finally {
    saveBtn.disabled = false;
    btnText.classList.remove('hidden');
    btnLoading.classList.add('hidden');
  }
}

async function createNewPage(title) {
  try {
    const authData = await chrome.storage.local.get(['notionToken', 'notionWorkspaceId']);
    
    const response = await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authData.notionToken}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        parent: { page_id: authData.notionWorkspaceId },
        properties: {
          title: {
            title: [{ text: { content: title } }]
          }
        }
      })
    });
    
    if (!response.ok) {
      throw new Error('Failed to create page');
    }
    
    const data = await response.json();
    return data.id;
    
  } catch (error) {
    showStatus('Error creating page: ' + error.message, 'error');
    return null;
  }
}

function buildPageContent(title, notes) {
  const url = document.getElementById('page-url').textContent;
  const blocks = [];
  
  // Bookmark block
  blocks.push({
    object: 'block',
    type: 'bookmark',
    bookmark: {
      url: url,
      caption: []
    }
  });
  
  // Notes paragraph (if provided)
  if (notes) {
    blocks.push({
      object: 'block',
      type: 'paragraph',
      paragraph: {
        rich_text: [{
          type: 'text',
          text: { content: notes }
        }]
      }
    });
    
    // Separator
    blocks.push({
      object: 'block',
      type: 'divider'
    });
  }
  
  // Timestamp
  const timestamp = new Date().toLocaleString();
  blocks.push({
    object: 'block',
    type: 'paragraph',
    paragraph: {
      rich_text: [{
        type: 'text',
        text: { content: `Clipped: ${timestamp}` },
        annotations: {
          italic: true,
          color: 'gray'
        }
      }]
    }
  });
  
  return blocks;
}

function showStatus(message, type) {
  const statusEl = document.getElementById('status');
  statusEl.textContent = message;
  statusEl.className = `status ${type}`;
  statusEl.classList.remove('hidden');
}

function hideStatus() {
  document.getElementById('status').classList.add('hidden');
}
