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
  // Use separate AbortControllers for each parallel fetch to prevent
  // one request's cleanup from interfering with the other.
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
      // Find the title property name for this database.
      // Notion databases can name their title column anything (e.g. "Name",
      // "Title", "Bookmark", etc.). We detect it by looking for the property
      // with type === 'title'.
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
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const isDatabase = destinationType === 'database';
    const parent = isDatabase
      ? { database_id: destinationId }
      : { page_id: destinationId };

    // Use the actual title property name for databases (detected during fetch).
    // For regular pages, Notion always uses the literal key 'title'.
    const propName = isDatabase ? (titleProperty || 'Name') : 'title';
    const properties = {
      [propName]: { title: [{ text: { content: title } }] }
    };

    // Build the content blocks (bookmark, notes, timestamp).
    const children = buildContentBlocks(url, notes);

    // The Notion API accepts 'children' for BOTH regular pages and database
    // entries in a single create-page request. There is no need for a two-step
    // approach. Everything goes in one call.
    const requestBody = { parent, properties, children };

    console.log('[Notion Clipper] Saving to Notion:', {
      destinationType,
      destinationId,
      propName,
      childrenCount: children.length,
      hasUrl: !!url,
      hasNotes: !!notes
    });

    const response = await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });

    if (!response.ok) {
      const errorData = await response.json();
      console.error('[Notion Clipper] Save failed:', {
        status: response.status,
        code: errorData.code,
        message: errorData.message
      });
      const rawMessage = errorData.message || errorData.code || 'Failed to save to Notion';
      throw new Error(rawMessage);
    }

    const createdPage = await response.json();

    console.log('[Notion Clipper] Save successful:', {
      pageId: createdPage.id,
      url: createdPage.url
    });

    return createdPage;
  } finally {
    clearTimeout(timeout);
  }
}

function buildContentBlocks(url, notes) {
  const blocks = [];

  // Bookmark
  if (url) {
    blocks.push({
      object: 'block',
      type: 'bookmark',
      bookmark: { url: url, caption: [] }
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
      type: 'divider',
      divider: {}
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
  if (lower.includes('rate_limited') || lower.includes('rate limit')) {
    return 'Too many requests. Please wait a moment and try again.';
  }
  if (lower.includes('conflict')) {
    return 'There was a conflict saving to Notion. Please try again.';
  }

  // Pass through the raw Notion error message so the user sees the real problem.
  // Previously this was catching 'validation' and 'invalid' keywords and replacing
  // them with a generic message, which hid the actual error from Notion.
  return raw || 'Something went wrong. Please try again.';
}
