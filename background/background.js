// Background Service Worker for Notion Clipper
// This is the single source of truth for all Notion API communication.

const CACHE_DURATION_MS = 15 * 60 * 1000; // 15 minutes

// Common names users give to URL-type and notes/description-type columns.
// Used as a fallback when matching database properties by name.
const URL_PROPERTY_NAMES = ['url', 'link', 'website', 'source', 'source url', 'page url', 'web address'];
const NOTES_PROPERTY_NAMES = ['description', 'notes', 'note', 'summary', 'details', 'comments', 'comment', 'memo', 'text', 'content', 'body'];

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
      // Scan ALL properties of this database so we can intelligently map
      // the clipped URL and notes to the right columns when saving.
      const propertyMap = {};
      let titlePropertyName = 'Name'; // default fallback

      if (db.properties) {
        for (const [propName, propConfig] of Object.entries(db.properties)) {
          propertyMap[propName] = propConfig.type;
          if (propConfig.type === 'title') {
            titlePropertyName = propName;
          }
        }
      }

      const title = db.title?.[0]?.plain_text || 'Untitled Database';
      return {
        id: db.id,
        title,
        type: 'database',
        titleProperty: titlePropertyName,
        propertyMap  // e.g. { "Name": "title", "URL": "url", "Description": "rich_text", "Tags": "multi_select" }
      };
    });

    return [...databases, ...pages];
  } finally {
    clearTimeout(timeout1);
    clearTimeout(timeout2);
  }
}

// --- Smart Property Matching ---

// Given a database's property map, find the best property to store the URL.
// Strategy: first look for a property of type "url", then fall back to
// matching common column names.
function findUrlProperty(propertyMap) {
  // Priority 1: Any property with Notion type "url"
  for (const [name, type] of Object.entries(propertyMap)) {
    if (type === 'url') {
      return { name, type };
    }
  }

  // Priority 2: A rich_text property whose name matches common URL-ish names
  for (const [name, type] of Object.entries(propertyMap)) {
    if (type === 'rich_text' && URL_PROPERTY_NAMES.includes(name.toLowerCase().trim())) {
      return { name, type };
    }
  }

  return null;
}

// Given a database's property map, find the best property to store the notes.
// Strategy: look for a rich_text property whose name matches common
// description/notes names. Skip the title property (that's for the page title).
function findNotesProperty(propertyMap, titlePropertyName) {
  // Look for a rich_text property with a common notes/description name
  for (const [name, type] of Object.entries(propertyMap)) {
    if (type === 'rich_text' && name !== titlePropertyName &&
        NOTES_PROPERTY_NAMES.includes(name.toLowerCase().trim())) {
      return { name, type };
    }
  }

  return null;
}

// --- Save Logic ---

async function saveToNotion(data) {
  const { title, notes, url, destinationId, destinationType, titleProperty, propertyMap, token } = data;

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

    // For databases, try to fill in additional property columns automatically.
    if (isDatabase && propertyMap) {
      // Find and populate the URL property
      const urlProp = findUrlProperty(propertyMap);
      if (urlProp && url) {
        if (urlProp.type === 'url') {
          // Notion "url" type: simple string value
          properties[urlProp.name] = { url: url };
        } else if (urlProp.type === 'rich_text') {
          // Fallback: store URL as rich text
          properties[urlProp.name] = {
            rich_text: [{ type: 'text', text: { content: url } }]
          };
        }
      }

      // Find and populate the Notes/Description property
      const notesProp = findNotesProperty(propertyMap, propName);
      if (notesProp && notes) {
        properties[notesProp.name] = {
          rich_text: [{ type: 'text', text: { content: notes } }]
        };
      }
    }

    // Build the content blocks (bookmark, notes, timestamp) for the page body.
    // These go INSIDE the page as visible content, in addition to the property
    // fields above. This way the user sees a nice formatted view when they
    // open the page, AND the database columns are populated for filtering/sorting.
    const children = buildContentBlocks(url, notes);

    const requestBody = { parent, properties, children };

    console.log('[Notion Clipper] Saving to Notion:', {
      destinationType,
      destinationId,
      titleProp: propName,
      propertiesSet: Object.keys(properties),
      childrenCount: children.length,
      hasUrl: !!url,
      hasNotes: !!notes,
      propertyMap: propertyMap || 'N/A (regular page)'
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

  // Pass through the raw Notion error so the user sees the real problem.
  return raw || 'Something went wrong. Please try again.';
}
