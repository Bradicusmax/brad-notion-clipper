// Background Service Worker for Notion Clipper
// This is the single source of truth for all Notion API communication.

const CACHE_DURATION_MS = 15 * 60 * 1000; // 15 minutes

// Handle installation
chrome.runtime.onInstalled.addListener(() => {
  console.log('Notion Clipper installed');
});

// Handle messages from popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'SAVE_TO_NOTION') {
    saveToNotion(message.data)
      .then(result => sendResponse({ success: true, result }))
      .catch(error => sendResponse({ success: false, error: friendlyError(error.message) }));
    return true; // Keep channel open for async response
  }

  if (message.type === 'FETCH_DESTINATIONS') {
    fetchDestinations(message.token, message.forceRefresh)
      .then(result => sendResponse({ success: true, result }))
      .catch(error => sendResponse({ success: false, error: friendlyError(error.message) }));
    return true;
  }

  if (message.type === 'VALIDATE_TOKEN') {
    validateToken(message.token)
      .then(result => sendResponse({ success: true, result }))
      .catch(error => sendResponse({ success: false, error: friendlyError(error.message) }));
    return true;
  }
});

// --- Notion API Functions ---

async function validateToken(token) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch('https://api.notion.com/v1/users/me', {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Notion-Version': '2022-06-28'
      },
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error('Invalid token');
    }

    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchDestinations(token, forceRefresh = false) {
  // Check cache first (unless force refresh)
  if (!forceRefresh) {
    const cached = await chrome.storage.local.get(['destinationCache', 'destinationCacheTime']);
    if (cached.destinationCache && cached.destinationCacheTime) {
      const age = Date.now() - cached.destinationCacheTime;
      if (age < CACHE_DURATION_MS) {
        return cached.destinationCache;
      }
    }
  }

  // Fetch fresh data from Notion
  const pages = await fetchNotionPages(token);

  // Save to cache
  await chrome.storage.local.set({
    destinationCache: pages,
    destinationCacheTime: Date.now()
  });

  return pages;
}

async function fetchNotionPages(token) {
  // Bug fix: use SEPARATE AbortControllers for each fetch.
  // A single shared controller would cancel the second request the moment
  // the first one completes, causing intermittent "aborted" errors.
  const controller1 = new AbortController();
  const controller2 = new AbortController();
  const timeout1 = setTimeout(() => controller1.abort(), 15000);
  const timeout2 = setTimeout(() => controller2.abort(), 15000);

  try {
    const [pagesRes, dbsRes] = await Promise.all([
      fetch('https://api.notion.com/v1/search', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Notion-Version': '2022-06-28',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          filter: { property: 'object', value: 'page' },
          page_size: 100
        }),
        signal: controller1.signal
      }),
      fetch('https://api.notion.com/v1/search', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Notion-Version': '2022-06-28',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          filter: { property: 'object', value: 'database' },
          page_size: 100
        }),
        signal: controller2.signal
      })
    ]);

    if (!pagesRes.ok || !dbsRes.ok) {
      throw new Error('Failed to fetch pages from Notion');
    }

    const [pagesData, dbsData] = await Promise.all([pagesRes.json(), dbsRes.json()]);

    const pages = pagesData.results.map(page => {
      const title = page.properties?.title?.title?.[0]?.plain_text ||
                   page.properties?.Name?.title?.[0]?.plain_text ||
                   'Untitled';
      return { id: page.id, title, type: 'page' };
    });

    const databases = dbsData.results.map(db => {
      // Find the title property name for this database
      let titlePropertyName = 'Name'; // default fallback
      if (db.properties) {
        for (const [propName, propConfig] of Object.entries(db.properties)) {
          if (propConfig.type === 'title') {
            titlePropertyName = propName;
            break;
          }
        }
      }

      const title = db.title?.[0]?.plain_text || 'Untitled Database';
      return { id: db.id, title, type: 'database', titleProperty: titlePropertyName };
    });

    return [...databases, ...pages];
  } finally {
    clearTimeout(timeout1);
    clearTimeout(timeout2);
  }
}

async function saveToNotion(data) {
  const { title, notes, url, destinationId, destinationType, titleProperty, token } = data;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  try {
    const isDatabase = destinationType === 'database';
    const parent = isDatabase
      ? { database_id: destinationId }
      : { page_id: destinationId };

    // Use the actual title property name for databases (detected during fetch).
    // For regular pages, Notion requires the property key to literally be 'title'.
    const propName = isDatabase ? (titleProperty || 'Name') : 'title';
    const properties = {
      [propName]: { title: [{ text: { content: title } }] }
    };

    // Bug fix: When saving to a DATABASE, the Notion API does NOT accept a
    // 'children' array in the same create-page request. Sending children to a
    // database entry causes a validation error (which was showing as the
    // "Notion could not process the request" message). The fix is to create
    // the page first, then append the content blocks in a second API call.
    const createBody = { parent, properties };

    // For regular pages, children CAN be included in the initial request.
    if (!isDatabase) {
      createBody.children = buildContentBlocks(title, url, notes);
    }

    const response = await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(createBody),
      signal: controller.signal
    });

    if (!response.ok) {
      // Bug fix: read the raw Notion error BEFORE passing through friendlyError,
      // so we get the actual Notion message (e.g. the real property name mismatch)
      // rather than a generic fallback. The caller's catch block runs friendlyError.
      const errorData = await response.json();
      const rawMessage = errorData.message || errorData.code || 'Failed to save to Notion';
      throw new Error(rawMessage);
    }

    const createdPage = await response.json();

    // For database entries: append content blocks in a second request.
    if (isDatabase) {
      const blocks = buildContentBlocks(title, url, notes);
      if (blocks.length > 0) {
        const patchController = new AbortController();
        const patchTimeout = setTimeout(() => patchController.abort(), 20000);
        try {
          await fetch(`https://api.notion.com/v1/blocks/${createdPage.id}/children`, {
            method: 'PATCH',
            headers: {
              'Authorization': `Bearer ${token}`,
              'Notion-Version': '2022-06-28',
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ children: blocks }),
            signal: patchController.signal
          });
          // Non-fatal: if block append fails, the page was still created successfully.
        } catch (patchErr) {
          console.warn('Could not append content blocks to database entry:', patchErr.message);
        } finally {
          clearTimeout(patchTimeout);
        }
      }
    }

    return createdPage;
  } finally {
    clearTimeout(timeout);
  }
}

function buildContentBlocks(title, url, notes) {
  const blocks = [];

  // Bookmark
  if (url) {
    blocks.push({
      object: 'block',
      type: 'bookmark',
      bookmark: { url, caption: [] }
    });
  }

  // Notes
  if (notes) {
    blocks.push({
      object: 'block',
      type: 'paragraph',
      paragraph: {
        rich_text: [{ type: 'text', text: { content: notes } }]
      }
    });

    // Separator after notes
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
        annotations: { italic: true, color: 'gray' }
      }]
    }
  });

  return blocks;
}

// --- Friendly Error Messages ---

function friendlyError(raw) {
  const lower = (raw || '').toLowerCase();

  if (lower.includes('abort') || lower.includes('timed out') || lower.includes('network')) {
    return 'The request timed out. Please check your internet connection and try again.';
  }
  if (lower.includes('unauthorized') || lower.includes('invalid token')) {
    return 'Your Notion connection has expired. Please reconnect in Settings.';
  }
  if (lower.includes('not_found') || lower.includes('could not find')) {
    return 'That page or database was not found. Make sure it is shared with your Notion integration.';
  }
  if (lower.includes('validation') || lower.includes('invalid')) {
    return 'Notion could not process the request. Please check your destination page and try again.';
  }
  if (lower.includes('rate_limited') || lower.includes('rate limit')) {
    return 'Too many requests. Please wait a moment and try again.';
  }
  if (lower.includes('conflict')) {
    return 'There was a conflict saving to Notion. Please try again.';
  }

  return raw || 'Something went wrong. Please try again.';
}
