// Popup Script for Notion Clipper

let allPages = [];
let recentPageIds = [];
let highlightedIndex = -1;
let currentTabUrl = '';
let statusTimeout = null;

document.addEventListener('DOMContentLoaded', init);

async function init() {
  // Load recent pages from storage
  const stored = await chrome.storage.local.get(['recentPages']);
  recentPageIds = stored.recentPages || [];

  // Check authentication status
  const authData = await chrome.storage.local.get(['notionToken']);

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
  document.getElementById('refresh-destinations').addEventListener('click', () => loadDestinations(true));
  document.getElementById('options-link').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  // Select all title text on focus for easy replacement
  document.getElementById('page-title').addEventListener('focus', (e) => {
    e.target.select();
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
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (tab) {
      document.getElementById('page-title').value = tab.title || '';
      currentTabUrl = tab.url || '';
      document.getElementById('page-url').textContent = currentTabUrl;
      document.getElementById('page-url').title = currentTabUrl;

      // Only fetch favicon for http/https pages
      if (currentTabUrl.startsWith('http://') || currentTabUrl.startsWith('https://')) {
        const hostname = new URL(currentTabUrl).hostname;
        const faviconUrl = `https://www.google.com/s2/favicons?domain=${hostname}&sz=32`;
        const faviconImg = document.getElementById('favicon');
        faviconImg.src = faviconUrl;
        faviconImg.classList.remove('hidden');

        // Hide if the image fails to load
        faviconImg.onerror = () => {
          faviconImg.classList.add('hidden');
        };
      }
    }
  } catch (err) {
    // Silently handle restricted pages
    document.getElementById('page-title').value = '';
    document.getElementById('page-url').textContent = '';
    currentTabUrl = '';
  }
}

async function loadDestinations(forceRefresh = false) {
  const searchInput = document.getElementById('destination-search');
  const refreshBtn = document.getElementById('refresh-destinations');

  searchInput.placeholder = 'Loading pages...';
  searchInput.disabled = true;
  refreshBtn.disabled = true;

  try {
    const authData = await chrome.storage.local.get(['notionToken', 'notionParentPageId']);

    if (!authData.notionToken) {
      throw new Error('Not authenticated');
    }

    // Ask background script to fetch (with caching)
    const response = await chrome.runtime.sendMessage({
      type: 'FETCH_DESTINATIONS',
      token: authData.notionToken,
      forceRefresh: forceRefresh
    });

    if (!response.success) {
      throw new Error(response.error);
    }

    const pages = response.result;
    allPages = [];

    // Add default page if set
    if (authData.notionParentPageId) {
      // Try to find the actual name of the default page from fetched results
      const matchingPage = pages.find(p => p.id === authData.notionParentPageId);
      const defaultTitle = matchingPage ? matchingPage.title : 'Default Page';
      allPages.push({
        id: authData.notionParentPageId,
        title: defaultTitle,
        type: matchingPage ? matchingPage.type : 'page',
        titleProperty: matchingPage ? matchingPage.titleProperty : undefined,
        propertyMap: matchingPage ? matchingPage.propertyMap : undefined,
        isDefault: true
      });
    }

    // Add fetched pages (skip the default to avoid duplicates)
    pages.forEach(page => {
      if (authData.notionParentPageId && page.id === authData.notionParentPageId) return;
      allPages.push(page);
    });

    searchInput.placeholder = 'Search pages...';

  } catch (error) {
    showStatus('Could not load pages. Try the refresh button, or check Settings.', 'error');
    searchInput.placeholder = 'Error loading pages';
  } finally {
    searchInput.disabled = false;
    refreshBtn.disabled = false;
  }
}

function getSortedPages(query) {
  const q = query.toLowerCase().trim();

  const defaultPages = [];
  const recentPages = [];
  const otherPages = [];

  allPages.forEach(page => {
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

  defaultPages.forEach(page => {
    const el = createDropdownItem(page, itemIndex, true, false);
    dropdown.appendChild(el);
    itemIndex++;
  });

  recentPages.forEach(page => {
    const el = createDropdownItem(page, itemIndex, false, true);
    dropdown.appendChild(el);
    itemIndex++;
  });

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
  el.dataset.type = page.type || 'page';
  el.dataset.titleProperty = page.titleProperty || '';

  const isDb = page.type === 'database';
  const label = page.title;

  if (isDefault) {
    const star = document.createElement('span');
    star.className = 'star-badge';
    star.textContent = '\u2605';
    el.appendChild(star);
    el.appendChild(document.createTextNode(' ' + label));
  } else if (isDb) {
    const icon = document.createElement('span');
    icon.className = 'db-icon';
    icon.textContent = '\u25EB';
    el.appendChild(icon);
    el.appendChild(document.createTextNode(' ' + label));
  } else {
    el.textContent = label;
  }

  if (isRecent && !isDefault) {
    const badge = document.createElement('span');
    badge.className = 'recent-badge';
    badge.textContent = 'recent';
    el.appendChild(badge);
  }

  el.addEventListener('click', () => selectPage(page.id, page.title, page.type, page.titleProperty));
  el.addEventListener('mouseenter', () => {
    highlightedIndex = index;
    updateHighlight();
  });

  return el;
}

function selectPage(id, title, type, titleProperty) {
  const dest = document.getElementById('destination');
  dest.value = id;
  dest.dataset.type = type || 'page';
  dest.dataset.titleProperty = titleProperty || '';
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
      selectPage(item.dataset.id, item.dataset.title, item.dataset.type, item.dataset.titleProperty);
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
  recentPageIds = [pageId, ...recentPageIds.filter(id => id !== pageId)].slice(0, 10);
  await chrome.storage.local.set({ recentPages: recentPageIds });
}

async function startAuth() {
  // Open options page immediately — no artificial delay
  chrome.runtime.openOptionsPage();
}

async function saveToNotion() {
  const saveBtn = document.getElementById('save-btn');
  const btnText = saveBtn.querySelector('.btn-text');
  const btnLoading = saveBtn.querySelector('.btn-loading');

  const title = document.getElementById('page-title').value.trim();
  const notes = document.getElementById('notes').value.trim();
  const destination = document.getElementById('destination').value;

  if (!title) {
    showStatus('Please enter a title.', 'error');
    return;
  }

  if (!destination) {
    showStatus('Please select a destination page.', 'error');
    return;
  }

  if (!currentTabUrl) {
    showStatus('Cannot clip this page. Try a regular website.', 'error');
    return;
  }

  // Show loading state
  saveBtn.disabled = true;
  btnText.classList.add('hidden');
  btnLoading.classList.remove('hidden');
  hideStatus();

  try {
    const authData = await chrome.storage.local.get(['notionToken']);

    const destEl = document.getElementById('destination');
    const destType = destEl.dataset.type || 'page';
    const titleProperty = destEl.dataset.titleProperty || '';

    // Look up the full page data from allPages to get the propertyMap.
    // The propertyMap is an object that can't be stored in HTML dataset
    // attributes, so we retrieve it from the original data array.
    const selectedPage = allPages.find(p => p.id === destination);
    const propertyMap = selectedPage ? selectedPage.propertyMap : undefined;

    // Delegate saving to background script
    const response = await chrome.runtime.sendMessage({
      type: 'SAVE_TO_NOTION',
      data: {
        title,
        notes,
        url: currentTabUrl,
        destinationId: destination,
        destinationType: destType,
        titleProperty: titleProperty,
        propertyMap: propertyMap,
        token: authData.notionToken
      }
    });

    if (!response.success) {
      throw new Error(response.error);
    }

    // Save as recent page
    await saveRecentPage(destination);

    // Show success with link to the new page
    const notionUrl = response.result.url;
    if (notionUrl) {
      showStatus('Saved to Notion!', 'success', notionUrl);
    } else {
      showStatus('Saved to Notion!', 'success');
    }

    // Clear notes
    document.getElementById('notes').value = '';

    // Auto-close popup after a short delay
    setTimeout(() => window.close(), 2500);

  } catch (error) {
    showStatus(error.message || 'Something went wrong. Please try again.', 'error');
  } finally {
    saveBtn.disabled = false;
    btnText.classList.remove('hidden');
    btnLoading.classList.add('hidden');
  }
}

function showStatus(message, type, linkUrl) {
  const statusEl = document.getElementById('status');

  // Clear any previous auto-dismiss timer
  if (statusTimeout) {
    clearTimeout(statusTimeout);
    statusTimeout = null;
  }

  statusEl.innerHTML = '';
  statusEl.className = `status ${type}`;

  const textSpan = document.createElement('span');
  textSpan.textContent = message;
  statusEl.appendChild(textSpan);

  // Add "View in Notion" link if available
  if (linkUrl && type === 'success') {
    const link = document.createElement('a');
    link.href = linkUrl;
    link.textContent = ' View in Notion';
    link.target = '_blank';
    link.className = 'status-link';
    statusEl.appendChild(link);
  }

  statusEl.classList.remove('hidden');

  // Auto-dismiss after 5 seconds for non-error messages
  if (type !== 'error') {
    statusTimeout = setTimeout(() => hideStatus(), 5000);
  }
}

function hideStatus() {
  document.getElementById('status').classList.add('hidden');
  if (statusTimeout) {
    clearTimeout(statusTimeout);
    statusTimeout = null;
  }
}
