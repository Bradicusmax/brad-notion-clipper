// Popup Script for Notion Clipper

let allPages = [];
let recentPageIds = [];
let highlightedIndex = -1;

document.addEventListener('DOMContentLoaded', init);

async function init() {
  // Load recent pages from storage
  const stored = await chrome.storage.local.get(['recentPages']);
  recentPageIds = stored.recentPages || [];

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

  // Search input listeners
  const searchInput = document.getElementById('destination-search');
  searchInput.addEventListener('focus', () => openDropdown());
  searchInput.addEventListener('input', () => {
    highlightedIndex = -1;
    openDropdown();
  });
  searchInput.addEventListener('keydown', handleSearchKeydown);

  // Close dropdown when clicking outside
  document.addEventListener('click', (e) => {
    const wrapper = document.querySelector('.destination-section');
    if (!wrapper.contains(e.target)) {
      closeDropdown();
    }
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
  const searchInput = document.getElementById('destination-search');
  const refreshBtn = document.getElementById('refresh-destinations');

  searchInput.placeholder = 'Loading pages...';
  searchInput.disabled = true;
  refreshBtn.disabled = true;

  try {
    const authData = await chrome.storage.local.get(['notionToken', 'notionWorkspaceId']);

    if (!authData.notionToken) {
      throw new Error('Not authenticated');
    }

    // Get pages
    const pages = await fetchNotionPages(authData.notionToken);

    allPages = [];

    // Add default page if set
    const parentId = await chrome.storage.local.get(['notionParentPageId']);
    if (parentId.notionParentPageId) {
      allPages.push({
        id: parentId.notionParentPageId,
        title: 'Default Page',
        isDefault: true
      });
    }

    // Add fetched pages
    pages.forEach(page => {
      // Skip if it's the same as the default
      if (parentId.notionParentPageId && page.id === parentId.notionParentPageId) return;
      allPages.push(page);
    });

    searchInput.placeholder = 'Search pages...';

  } catch (error) {
    showStatus('Error loading destinations: ' + error.message, 'error');
    searchInput.placeholder = 'Error loading pages';
  } finally {
    searchInput.disabled = false;
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

function getSortedPages(query) {
  const q = query.toLowerCase().trim();

  // Separate pages into groups
  const defaultPages = [];
  const recentPages = [];
  const otherPages = [];

  allPages.forEach(page => {
    // If there's a search query, filter by it
    if (q && !page.title.toLowerCase().includes(q)) return;

    if (page.isDefault) {
      defaultPages.push(page);
    } else if (recentPageIds.includes(page.id)) {
      recentPages.push(page);
    } else {
      otherPages.push(page);
    }
  });

  // Sort recent pages by recency (most recent first)
  recentPages.sort((a, b) => {
    return recentPageIds.indexOf(a.id) - recentPageIds.indexOf(b.id);
  });

  // Sort other pages alphabetically
  otherPages.sort((a, b) => a.title.localeCompare(b.title));

  return { defaultPages, recentPages, otherPages };
}

function openDropdown() {
  const dropdown = document.getElementById('destination-dropdown');
  const query = document.getElementById('destination-search').value;
  const { defaultPages, recentPages, otherPages } = getSortedPages(query);

  dropdown.innerHTML = '';

  let itemIndex = 0;

  // Default page
  defaultPages.forEach(page => {
    const el = createDropdownItem(page, itemIndex, true, false);
    dropdown.appendChild(el);
    itemIndex++;
  });

  // Recent pages
  recentPages.forEach(page => {
    const el = createDropdownItem(page, itemIndex, false, true);
    dropdown.appendChild(el);
    itemIndex++;
  });

  // Other pages
  otherPages.forEach(page => {
    const el = createDropdownItem(page, itemIndex, false, false);
    dropdown.appendChild(el);
    itemIndex++;
  });

  if (itemIndex === 0) {
    const noResults = document.createElement('div');
    noResults.className = 'destination-no-results';
    noResults.textContent = allPages.length === 0 ? 'Loading...' : 'No matching pages';
    dropdown.appendChild(noResults);
  }

  dropdown.classList.add('open');
}

function createDropdownItem(page, index, isDefault, isRecent) {
  const el = document.createElement('div');
  el.className = 'destination-item';
  if (index === highlightedIndex) el.classList.add('highlighted');
  el.dataset.index = index;
  el.dataset.id = page.id;
  el.dataset.title = page.title;

  let label = page.title;
  if (isDefault) {
    el.innerHTML = `<span class="star-badge">&#9733;</span> ${escapeHtml(label)}`;
  } else {
    el.textContent = label;
  }

  if (isRecent && !isDefault) {
    const badge = document.createElement('span');
    badge.className = 'recent-badge';
    badge.textContent = 'recent';
    el.appendChild(badge);
  }

  el.addEventListener('click', () => selectPage(page.id, page.title));
  el.addEventListener('mouseenter', () => {
    highlightedIndex = index;
    updateHighlight();
  });

  return el;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function selectPage(id, title) {
  document.getElementById('destination').value = id;
  document.getElementById('destination-search').value = title;
  closeDropdown();
}

function closeDropdown() {
  document.getElementById('destination-dropdown').classList.remove('open');
  highlightedIndex = -1;
}

function updateHighlight() {
  const items = document.querySelectorAll('.destination-item');
  items.forEach(item => {
    item.classList.toggle('highlighted', parseInt(item.dataset.index) === highlightedIndex);
  });
}

function handleSearchKeydown(e) {
  const dropdown = document.getElementById('destination-dropdown');
  const items = dropdown.querySelectorAll('.destination-item');
  const count = items.length;

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    highlightedIndex = (highlightedIndex + 1) % count;
    updateHighlight();
    scrollToHighlighted();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    highlightedIndex = highlightedIndex <= 0 ? count - 1 : highlightedIndex - 1;
    updateHighlight();
    scrollToHighlighted();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (highlightedIndex >= 0 && highlightedIndex < count) {
      const item = items[highlightedIndex];
      selectPage(item.dataset.id, item.dataset.title);
    }
  } else if (e.key === 'Escape') {
    closeDropdown();
    e.target.blur();
  }
}

function scrollToHighlighted() {
  const highlighted = document.querySelector('.destination-item.highlighted');
  if (highlighted) {
    highlighted.scrollIntoView({ block: 'nearest' });
  }
}

async function saveRecentPage(pageId) {
  // Add to front, remove duplicates, keep max 10
  recentPageIds = [pageId, ...recentPageIds.filter(id => id !== pageId)].slice(0, 10);
  await chrome.storage.local.set({ recentPages: recentPageIds });
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
        parent: { page_id: destination },
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

    // Save as recent page
    await saveRecentPage(destination);

    showStatus('Saved to Notion!', 'success');

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
