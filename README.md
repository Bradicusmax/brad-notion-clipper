# Notion Clipper Chrome Extension

A Chrome extension that lets you clip web pages to Notion with custom notes.

## Features

- 📄 Capture page title and URL
- 📝 Add custom notes to each clip
- 🎯 Save to any Notion page
- 🔐 Secure token-based authentication

## Installation

### Quick Install (Developer Mode)

1. Download this folder to your computer
2. Open Chrome and go to `chrome://extensions/`
3. Enable "Developer mode" (top right)
4. Click "Load unpacked"
5. Select this folder
6. Click the extension icon to configure

### Configure Notion

1. Go to [notion.so/my-integrations](https://www.notion.so/my-integrations)
2. Click "New integration"
3. Name it "Notion Clipper"
4. Copy the Internal Integration Secret token
5. Open extension settings and paste your token
6. Share the page you want to clip to with your integration:
   - Open the page in Notion
   - Click `...` menu → "Add connections" → Select "Notion Clipper"

## Usage

1. Click the Notion Clipper icon on any page
2. Edit the title if needed
3. Add your notes
4. Select a destination page
5. Click "Save to Notion"

## Project Structure

```
notion-clipper/
├── manifest.json          # Chrome extension config
├── popup/
│   ├── popup.html        # Extension popup UI
│   ├── popup.js          # Popup logic
│   └── popup.css         # Popup styling
├── background/
│   └── background.js     # Background service worker
├── options/
│   ├── options.html      # Settings page
│   ├── options.js        # Settings logic
│   └── options.css       # Settings styling
└── icons/                # Extension icons
```

## Files

| File | Purpose |
|------|---------|
| `manifest.json` | Extension configuration |
| `popup/popup.html` | Main popup UI |
| `popup/popup.js` | Clip and save logic |
| `popup/popup.css` | Popup styling |
| `background/background.js` | Background tasks |
| `options/options.html` | Settings page |
| `options/options.js` | Auth & settings |
| `options/options.css` | Settings styling |

## Getting a Notion Integration Token

1. Go to [notion.so/my-integrations](https://www.notion.so/my-integrations)
2. Click "New integration"
3. Name it "Notion Clipper" (or any name)
4. Copy the "Internal Integration Secret" token
5. Paste in extension settings

## Sharing a Page with Your Integration

For the extension to save to a page, you must share that page with your integration:

1. Open the page in Notion
2. Click the `...` menu (top right)
3. Select "Add connections"
4. Select "Notion Clipper"

## Privacy

- All data is sent directly between Chrome and Notion API
- No third-party servers
- Tokens stored only in Chrome's local storage

## Troubleshooting

### "Failed to fetch pages"
- Make sure your integration token is valid
- Check that you've shared pages with your integration

### "Could not create page"
- Verify the parent page ID is correct
- Ensure your integration has access to the parent

### Extension icon not working
- Reload the extension in `chrome://extensions/`
- Check for console errors (View → Developer → Developer Tools)

## Version History

- **v1.0.0** (2026-02-14): Initial release
  - Basic page capture
  - Notes support
  - Token-based auth
  - Page selection

## License

MIT License - Feel free to modify and use.
