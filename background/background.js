// Background Service Worker for Notion Clipper

// Handle installation
chrome.runtime.onInstalled.addListener(() => {
  console.log('Notion Clipper installed');
});

// Handle messages from popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'SAVE_TO_NOTION') {
    saveToNotion(message.data)
      .then(result => sendResponse({ success: true, result }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true; // Keep channel open for async response
  }
});

async function saveToNotion(data) {
  const { title, notes, url, parentId, token } = data;
  
  const response = await fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
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
      children: buildContentBlocks(title, url, notes)
    })
  });
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Failed to save to Notion');
  }
  
  return await response.json();
}

function buildContentBlocks(title, url, notes) {
  const blocks = [];
  
  // Bookmark
  blocks.push({
    object: 'block',
    type: 'bookmark',
    bookmark: { url, caption: [] }
  });
  
  // Notes
  if (notes) {
    blocks.push({
      object: 'block',
      type: 'paragraph',
      paragraph: {
        rich_text: [{ type: 'text', text: { content: notes } }]
      }
    });
  }
  
  // Timestamp
  blocks.push({
    object: 'block',
    type: 'paragraph',
    paragraph: {
      rich_text: [{
        type: 'text',
        text: { content: `Clipped from: ${url}` },
        annotations: { italic: true, color: 'gray' }
      }]
    }
  });
  
  return blocks;
}
