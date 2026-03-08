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

  // When saving to a DATABASE, the Notion API does NOT accept a 'children'
  // array in the same create-page request — it only allows them for regular
  // pages. The fix is a two-step process: create the entry first, then append
  // content blocks in a separate PATCH call.
  const createBody = { parent, properties };
  if (!isDatabase) {
    createBody.children = buildContentBlocks(title, url, notes);
  }

  // --- Step 1: Create the page / database entry ---
  // Bug fix: use a DEDICATED controller for this request only.
  // Previously the controller was shared with the PATCH step, so when the
  // 20-second timeout fired it would abort whichever request was still in
  // flight — often the PATCH — causing the content to silently disappear.
  const createController = new AbortController();
  const createTimeout = setTimeout(() => createController.abort(), 20000);

  let createdPage;
  try {
    const response = await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(createBody),
      signal: createController.signal
    });

    if (!response.ok) {
      const errorData = await response.json();
      const rawMessage = errorData.message || errorData.code || 'Failed to save to Notion';
      throw new Error(rawMessage);
    }

    createdPage = await response.json();
  } finally {
    clearTimeout(createTimeout);
  }

  // --- Step 2 (databases only): Append content blocks ---
  // Bug fix: this step now runs OUTSIDE the first try/finally block with its
  // own independent controller and timeout. Previously it was inside the same
  // try/finally, which meant:
  //   (a) the shared timeout could abort this request before it finished, and
  //   (b) any error was caught and swallowed silently, so the user never knew
  //       the content hadn't been saved.
  // Now errors from this step are thrown and will surface to the user.
  if (isDatabase) {
    const blocks = buildContentBlocks(title, url, notes);
    if (blocks.length > 0) {
      const patchController = new AbortController();
      const patchTimeout = setTimeout(() => patchController.abort(), 20000);

      try {
        const patchResponse = await fetch(
          `https://api.notion.com/v1/blocks/${createdPage.id}/children`,
          {
            method: 'PATCH',
            headers: {
              'Authorization': `Bearer ${token}`,
              'Notion-Version': '2022-06-28',
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ children: blocks }),
            signal: patchController.signal
          }
        );

        if (!patchResponse.ok) {
          const patchError = await patchResponse.json();
          const patchMsg = patchError.message || patchError.code || 'Failed to append content';
          throw new Error(`Entry was created but content could not be added: ${patchMsg}`);
        }
      } finally {
        clearTimeout(patchTimeout);
      }
    }
  }

  return createdPage;
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
