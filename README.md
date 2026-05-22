# 🕒 Continuity — Privacy-Focused Productivity Tracker

> **Version 3.0.0** · Chrome Extension (Manifest V3)

Continuity is a **privacy-first** Chrome extension that tracks how you spend your time online, classifies websites as productive or non-productive, blocks distracting sites, and syncs your analytics to the Consistify backend — all with your domain data encrypted on-device.

---

## ✨ Features

| Feature | Description |
|---|---|
| 📊 **Time Tracking** | Automatically tracks active browsing time per website with idle detection (stops counting after 60s of inactivity) |
| 🔒 **Encrypted Classifications** | Domain names are encrypted with AES-256-GCM before storage — your browsing habits stay private |
| 🎬 **Video-Aware Tracking** | Smart tracking for YouTube & Udemy — only counts time while a video is actually playing |
| 🚫 **Site Blocker** | Block distracting websites with a full-screen overlay; allow a 5-minute grace period anytime |
| 📈 **Daily & Weekly Stats** | View your productivity score, time breakdown, and per-site bar charts for today or the past 7 days |
| 🔁 **Background Sync** | Automatically syncs logs to your Consistify server every 2 minutes with automatic retry on failure |
| 🧩 **Reclassify Anytime** | Edit a site's classification (productive / non-productive) at any time from the popup |

---

## 🗂️ Project Structure

```
contnuity-chrome-extension/
├── manifest.json       # Extension configuration (Manifest V3)
├── background.js       # Service worker — session management, idle detection, sync
├── popup.html          # Extension popup UI
├── popup.js            # Popup controller — stats, charts, blocker, token input
├── content.js          # YouTube/Udemy content script — video play/pause events
├── blocker.js          # Content script — runs on all pages to enforce blocks
└── crypto.js           # AES-256-GCM encryption for domain classification storage
```

---

## 🛠️ How It Works

### Time Tracking
- The **background service worker** (`background.js`) listens to tab activation, URL changes, and window focus events.
- Each active tab gets a session with a `startTime`. When you switch tabs, the elapsed time is logged.
- Sessions are paused automatically when the system goes **idle or locked** (after 60 seconds).
- Logs are persisted in `chrome.storage.local` under `dailyStats`, `weeklyHistory`, and a `trackingLogs` sync queue.

### Privacy & Encryption (`crypto.js`)
- On first install, a **device-specific AES-256-GCM key** is generated using the Web Crypto API and stored as a JWK.
- Every domain name you classify is **encrypted before storage** — even if someone reads your `chrome.storage.local`, they see only ciphertext.
- The key never leaves your device.

### Site Blocking (`blocker.js`)
- Runs at `document_start` on every URL.
- If the current domain is in your blocked list, a **full-screen overlay** is injected via a Shadow DOM (to prevent sites from removing it).
- Users can click **"Allow for 5 minutes"** to temporarily bypass the block.

### Video Tracking (`content.js`)
- Injected on YouTube and Udemy only.
- Detects `play` and `pause` events on `<video>` elements.
- Sends `VIDEO_PLAYING` / `VIDEO_PAUSED` messages to the background, so time is only counted when you're actually watching.

### Server Sync
- Every **2 minutes**, accumulated logs are POSTed to `http://localhost:3000/api/logs` with your Bearer token.
- If the server is unreachable, logs are **restored locally** and retried on the next cycle.
- Blocked sites list is refreshed from the server every **10 minutes**.

---

## 🚀 Installation (Developer Mode)

1. **Clone or download** this repository.
2. Open Chrome and navigate to `chrome://extensions/`.
3. Enable **Developer mode** (toggle in the top-right corner).
4. Click **"Load unpacked"** and select the `contnuity-chrome-extension/` folder.
5. The Continuity icon will appear in your toolbar.

---

## ⚙️ Configuration

### Connecting to the Consistify Backend

1. Click the Continuity extension icon to open the popup.
2. Scroll to the **Token** section at the bottom.
3. Paste your **extension token** from the Consistify app and click **Save**.
4. Ensure the Consistify backend is running at `http://localhost:3000`.

> **Note:** Without a token, time tracking works fully offline. Sync to the server is simply skipped.

---

## 🔐 Permissions

| Permission | Why It's Needed |
|---|---|
| `storage` | Save tracking data, classifications, and settings locally |
| `tabs` | Detect active tab changes and read current tab URL/title |
| `alarms` | Schedule periodic sync and daily rollover checks |
| `idle` | Detect when the system is idle to pause tracking |
| `host_permissions: <all_urls>` | Inject the blocker content script on any site |

---

## 📦 Tech Stack

- **Manifest V3** — Modern Chrome extension architecture with a service worker background
- **Web Crypto API** — AES-256-GCM encryption for privacy-safe classification storage
- **chrome.storage** (local + session) — Persistent and session-scoped data
- **chrome.alarms** — Reliable background scheduling without `setInterval`
- **Shadow DOM** — Tamper-resistant site blocking overlay
- **Vanilla JS** — Zero dependencies, fast and lightweight

---

## 🔗 Related Projects
- **[Consistify Backend](../consistify-backend/)** — Express.js API server for data sync and analytics

---

## 📄 License

This project is part of the Consistify ecosystem. All rights reserved.
