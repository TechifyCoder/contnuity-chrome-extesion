// ─── Continuity v3.0 — Background Service Worker ────────────────────────────
// Tracks active browsing time per-site with idle detection.
// Integrates with crypto.js for encrypted classification lookups.
// Stores daily + weekly stats in chrome.storage.local, syncs to server.

importScripts('crypto.js');

const VIDEO_TRACKING_SITES = ['youtube.com', 'udemy.com'];
const IDLE_THRESHOLD_SECONDS = 60;
let blockedSitesCache = [];
let isSystemIdle = false;

// ─── Helpers ────────────────────────────────────────────────────────────────

function getDomainFromUrl(urlString) {
  try {
    const hostname = new URL(urlString).hostname.replace(/^www\./, '');
    // Extract root domain (e.g., github.com from gist.github.com)
    const parts = hostname.split('.');
    if (parts.length > 2) {
      // Handle co.uk, com.au style TLDs
      const knownTLDs = ['co.uk', 'com.au', 'co.in', 'com.br', 'co.jp'];
      const lastTwo = parts.slice(-2).join('.');
      if (knownTLDs.includes(lastTwo)) {
        return parts.slice(-3).join('.');
      }
      return parts.slice(-2).join('.');
    }
    return hostname;
  } catch {
    return null;
  }
}

function isSpecialPage(urlString) {
  if (!urlString) return true;
  return /^(chrome|chrome-extension|about|edge|brave|devtools):\/\//.test(urlString) || urlString === '';
}

function getTodayDateString() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function getDateString(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

// ─── Storage Helpers ────────────────────────────────────────────────────────

/**
 * Log accumulated seconds for a site into the sync queue (trackingLogs),
 * local daily stats (dailyStats), and weekly history (weeklyHistory).
 */
async function logTimeToStorage(site, durationSec, title, url) {
  if (durationSec <= 0) return;
  const today = getTodayDateString();

  // Get classification for this site
  let classification = 'unclassified';
  try {
    const cl = await getClassification(site);
    if (cl) classification = cl.label;
  } catch (e) { /* fallback to unclassified */ }

  const result = await chrome.storage.local.get(['trackingLogs', 'dailyStats', 'weeklyHistory']);

  // 1. Sync queue — aggregate by site+date
  const logs = result.trackingLogs || [];
  const currentHour = new Date().getHours();
  const existingIndex = logs.findIndex(l => l.site === site && l.date === today);
  if (existingIndex > -1) {
    logs[existingIndex].duration += durationSec;
    logs[existingIndex].title = title;
    logs[existingIndex].url = url;
    logs[existingIndex].category = classification;
    logs[existingIndex].timestamp = Date.now();
    logs[existingIndex].hourOfDay = currentHour;
    // Track per-hour breakdown
    if (!logs[existingIndex].hourlySeconds) logs[existingIndex].hourlySeconds = {};
    const hKey = String(currentHour);
    logs[existingIndex].hourlySeconds[hKey] = (logs[existingIndex].hourlySeconds[hKey] || 0) + durationSec;
  } else {
    const hourlySeconds = {};
    hourlySeconds[String(currentHour)] = durationSec;
    logs.push({
      site, duration: durationSec, date: today, title, url,
      category: classification, timestamp: Date.now(),
      hourOfDay: currentHour, hourlySeconds
    });
  }

  // 2. Daily stats — survives sync wipes, used by popup
  const stats = result.dailyStats || { date: today, sites: {} };
  if (stats.date !== today) {
    // Day rolled over — archive yesterday's stats to weekly, reset daily
    await archiveDailyToWeekly(stats);
    stats.date = today;
    stats.sites = {};
  }
  if (!stats.sites[site]) {
    stats.sites[site] = { seconds: 0, classification };
  }
  stats.sites[site].seconds += durationSec;
  if (classification !== 'unclassified') {
    stats.sites[site].classification = classification;
  }

  // 3. Weekly history — rolling 7-day aggregate
  let weekly = result.weeklyHistory || [];
  const todayEntry = weekly.find(w => w.date === today);
  if (todayEntry) {
    if (!todayEntry.sites[site]) {
      todayEntry.sites[site] = { seconds: 0, classification };
    }
    todayEntry.sites[site].seconds += durationSec;
    if (classification !== 'unclassified') {
      todayEntry.sites[site].classification = classification;
    }
  } else {
    weekly.push({
      date: today,
      sites: { [site]: { seconds: durationSec, classification } }
    });
  }
  // Keep only last 7 days
  weekly = weekly.filter(w => {
    const entryDate = new Date(w.date);
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    return entryDate >= sevenDaysAgo;
  });

  await chrome.storage.local.set({ trackingLogs: logs, dailyStats: stats, weeklyHistory: weekly });

  // Also update time in encrypted classification store
  try {
    await updateDomainTime(site, durationSec);
  } catch (e) { /* non-critical */ }
}

/**
 * Archive daily stats into weekly history before resetting.
 */
async function archiveDailyToWeekly(oldStats) {
  if (!oldStats || !oldStats.date || !oldStats.sites) return;
  const result = await chrome.storage.local.get(['weeklyHistory']);
  let weekly = result.weeklyHistory || [];

  // Check if this date is already archived
  const existing = weekly.find(w => w.date === oldStats.date);
  if (!existing) {
    weekly.push({
      date: oldStats.date,
      sites: oldStats.sites
    });
  }

  // Keep only last 7 days
  weekly = weekly.filter(w => {
    const entryDate = new Date(w.date);
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    return entryDate >= sevenDaysAgo;
  });

  await chrome.storage.local.set({ weeklyHistory: weekly });
}

/**
 * Read-modify-write activeSessions in chrome.storage.session.
 */
async function updateSessions(updaterFunc) {
  const result = await chrome.storage.session.get('activeSessions');
  const sessions = result.activeSessions || {};
  await updaterFunc(sessions);
  await chrome.storage.session.set({ activeSessions: sessions });
}

// ─── Session Management ─────────────────────────────────────────────────────

/**
 * End session for a tab: compute elapsed time, log it, delete the session.
 */
async function endSession(tabId) {
  await updateSessions(async (sessions) => {
    const session = sessions[tabId];
    if (session) {
      const duration = Math.floor((Date.now() - session.startTime) / 1000);
      if (duration > 0) {
        await logTimeToStorage(session.site, duration, session.title, session.url);
      }
      delete sessions[tabId];
    }
  });
}

/**
 * Start (or continue) a session for a tab.
 * If the tab already has a session for a different site, end it first.
 * Also checks classification and sets pendingClassification if needed.
 */
async function startSession(tabId, site, title, url, isVideo = false) {
  if (isSystemIdle) return; // Don't start sessions while system is idle

  // Check classification and set pending if unclassified
  try {
    const cl = await getClassification(site);
    if (!cl) {
      // Domain not yet classified — flag for popup to prompt
      const pending = await chrome.storage.session.get('pendingClassification');
      const dismissed = await chrome.storage.session.get('dismissedDomains');
      const dismissedDomains = dismissed.dismissedDomains || [];

      // Only set pending if not already dismissed this session
      if (!dismissedDomains.includes(site)) {
        await chrome.storage.session.set({
          pendingClassification: { domain: site, title, url, timestamp: Date.now() }
        });
      }
    }
  } catch (e) { /* non-critical */ }

  await updateSessions(async (sessions) => {
    if (sessions[tabId] && sessions[tabId].site !== site) {
      const duration = Math.floor((Date.now() - sessions[tabId].startTime) / 1000);
      if (duration > 0) {
        await logTimeToStorage(sessions[tabId].site, duration, sessions[tabId].title, sessions[tabId].url);
      }
      delete sessions[tabId];
    }
    if (!sessions[tabId]) {
      sessions[tabId] = { site, startTime: Date.now(), title, url, isVideo };
    } else if (isVideo) {
      sessions[tabId].isVideo = true;
    }
  });
}

/**
 * Pause all non-video sessions: log elapsed time and delete them.
 */
async function pauseAllTabSessions() {
  await updateSessions(async (sessions) => {
    for (const tId in sessions) {
      if (!sessions[tId].isVideo) {
        const duration = Math.floor((Date.now() - sessions[tId].startTime) / 1000);
        if (duration > 0) {
          await logTimeToStorage(sessions[tId].site, duration, sessions[tId].title, sessions[tId].url);
        }
        delete sessions[tId];
      }
    }
  });
}

/**
 * Pause ALL sessions including video ones (used for system idle).
 */
async function pauseAllSessions() {
  await updateSessions(async (sessions) => {
    for (const tId in sessions) {
      const duration = Math.floor((Date.now() - sessions[tId].startTime) / 1000);
      if (duration > 0) {
        await logTimeToStorage(sessions[tId].site, duration, sessions[tId].title, sessions[tId].url);
      }
      delete sessions[tId];
    }
  });
}

/**
 * Flush ALL active sessions' elapsed time into the sync queue WITHOUT
 * killing the sessions. Resets startTime so the next flush only captures
 * the new delta.
 */
async function flushActiveSessions() {
  await updateSessions(async (sessions) => {
    const now = Date.now();
    for (const tId in sessions) {
      const session = sessions[tId];
      const durationSec = Math.floor((now - session.startTime) / 1000);
      if (durationSec > 0) {
        await logTimeToStorage(session.site, durationSec, session.title, session.url);
        session.startTime = now;
      }
    }
  });
}

// ─── Idle Detection ─────────────────────────────────────────────────────────

chrome.idle.setDetectionInterval(IDLE_THRESHOLD_SECONDS);

chrome.idle.onStateChanged.addListener(async (state) => {
  if (state === 'idle' || state === 'locked') {
    isSystemIdle = true;
    await pauseAllSessions();
  } else if (state === 'active') {
    isSystemIdle = false;
    // Resume tracking the active tab
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (chrome.runtime.lastError) return;
      const activeTab = tabs[0];
      if (activeTab && activeTab.url && !isSpecialPage(activeTab.url)) {
        const domain = getDomainFromUrl(activeTab.url);
        if (domain) startSession(activeTab.id, domain, activeTab.title, activeTab.url);
      }
    });
  }
});

// ─── Tab / Window Event Listeners ───────────────────────────────────────────

// Tab switched
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  if (isSystemIdle) return;
  await pauseAllTabSessions();
  chrome.tabs.get(activeInfo.tabId, (tab) => {
    if (chrome.runtime.lastError || !tab.url || tab.incognito || isSpecialPage(tab.url)) return;
    const domain = getDomainFromUrl(tab.url);
    if (domain) startSession(tab.id, domain, tab.title, tab.url);
  });
});

// Tab URL changed
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (isSystemIdle || tab.incognito || !changeInfo.url) return;
  if (isSpecialPage(changeInfo.url)) {
    await endSession(tabId);
    return;
  }
  const newDomain = getDomainFromUrl(changeInfo.url);
  chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
    if (chrome.runtime.lastError) return;
    if (tabs[0] && tabs[0].id === tabId && newDomain) {
      await startSession(tabId, newDomain, tab.title, tab.url);
    }
  });
});

// Window focus changed
chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (isSystemIdle) return;
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    await pauseAllTabSessions();
  } else {
    chrome.tabs.query({ active: true, windowId: windowId }, (tabs) => {
      if (chrome.runtime.lastError) return;
      const activeTab = tabs[0];
      if (activeTab && activeTab.url && !isSpecialPage(activeTab.url)) {
        const domain = getDomainFromUrl(activeTab.url);
        if (domain) startSession(activeTab.id, domain, activeTab.title, activeTab.url);
      }
    });
  }
});

// Tab closed
chrome.tabs.onRemoved.addListener((tabId) => endSession(tabId));

// ─── Content Script Messages ────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'HEARTBEAT') return true;

  // Handle popup requests
  if (message.type === 'CLASSIFY_DOMAIN') {
    setClassification(message.domain, message.label)
      .then(() => {
        // Clear pending classification
        chrome.storage.session.remove('pendingClassification');
        sendResponse({ success: true });
      })
      .catch(e => sendResponse({ success: false, error: e.message }));
    return true; // async response
  }

  if (message.type === 'DISMISS_CLASSIFICATION') {
    // Add to dismissed list for this session
    chrome.storage.session.get('dismissedDomains', (result) => {
      const dismissed = result.dismissedDomains || [];
      if (!dismissed.includes(message.domain)) {
        dismissed.push(message.domain);
      }
      chrome.storage.session.set({ dismissedDomains: dismissed });
      chrome.storage.session.remove('pendingClassification');
    });
    sendResponse({ success: true });
    return true;
  }

  if (message.type === 'GET_CLASSIFICATIONS') {
    getClassifications()
      .then(data => sendResponse({ success: true, data }))
      .catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }

  if (message.type === 'RECLASSIFY_DOMAIN') {
    setClassification(message.domain, message.label)
      .then(() => sendResponse({ success: true }))
      .catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }

  if (message.type === 'GET_BLOCKED_SITES') {
    sendResponse({ sites: blockedSitesCache });
    return true;
  }

  const tabId = sender.tab ? sender.tab.id : null;
  if (!tabId || sender.tab.incognito) return;

  const urlString = sender.tab.url || sender.url;
  const domain = getDomainFromUrl(urlString);

  if (domain && VIDEO_TRACKING_SITES.some(vs => domain.includes(vs))) {
    if (message.type === 'VIDEO_PLAYING') {
      startSession(tabId, domain, message.title, message.url || urlString, true);
    } else if (message.type === 'VIDEO_PAUSED') {
      endSession(tabId);
    }
  }
});

// ─── Alarm Setup & Sync Logic ───────────────────────────────────────────────

function setupAlarms() {
  chrome.alarms.create("syncLogs", { periodInMinutes: 2 });
  chrome.alarms.create("syncBlockedSites", { periodInMinutes: 10 });
  chrome.alarms.create("dailyRollover", { periodInMinutes: 30 }); // Check for day rollover
}

chrome.runtime.onInstalled.addListener(() => {
  setupAlarms();
  fetchBlockedSites();
  // Initialize encryption key
  getEncryptionKey().catch(e => console.warn('[BG] Key init failed:', e));
});

chrome.runtime.onStartup.addListener(() => {
  setupAlarms();
  fetchBlockedSites();
  getEncryptionKey().catch(e => console.warn('[BG] Key init failed:', e));
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "syncLogs") await syncLogsToServer();
  if (alarm.name === "syncBlockedSites") await fetchBlockedSites();
  if (alarm.name === "dailyRollover") await checkDayRollover();
});

/**
 * Check if the day has rolled over and archive daily stats.
 */
async function checkDayRollover() {
  const today = getTodayDateString();
  const result = await chrome.storage.local.get(['dailyStats']);
  const stats = result.dailyStats;
  if (stats && stats.date && stats.date !== today) {
    await archiveDailyToWeekly(stats);
    await chrome.storage.local.set({
      dailyStats: { date: today, sites: {} }
    });
  }
}

/**
 * Sync accumulated logs to the server.
 */
async function syncLogsToServer() {
  await flushActiveSessions();

  const result = await chrome.storage.local.get(['trackingLogs', 'userToken']);
  const logs = result.trackingLogs || [];
  const token = result.userToken;

  if (logs.length === 0) {
    console.log('[Sync] No logs to sync');
    return;
  }
  if (!token) {
    console.warn('[Sync] No userToken set — cannot sync. Please paste your extension token in the popup.');
    return;
  }

  console.log(`[Sync] Attempting to sync ${logs.length} log entries...`);
  await chrome.storage.local.set({ trackingLogs: [] });

  try {
    const response = await fetch('http://localhost:3000/api/logs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({
        logs: logs.map(l => ({
          ...l,
          hourOfDay: l.hourOfDay || new Date().getHours(),
          hourlySeconds: l.hourlySeconds || {},
        }))
      })
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error(`[Sync] Server responded with ${response.status}: ${errorBody}`);
      const current = await chrome.storage.local.get(['trackingLogs']);
      const merged = mergeLogs(logs, current.trackingLogs || []);
      await chrome.storage.local.set({ trackingLogs: merged });
      console.log(`[Sync] Restored ${merged.length} logs to retry later`);
    } else {
      console.log(`[Sync] ✅ Successfully synced ${logs.length} entries`);
    }
  } catch (error) {
    console.error('[Sync] ❌ Network error (is localhost:3000 running?):', error.message || error);
    const current = await chrome.storage.local.get(['trackingLogs']);
    const merged = mergeLogs(logs, current.trackingLogs || []);
    await chrome.storage.local.set({ trackingLogs: merged });
    console.log(`[Sync] Restored ${merged.length} logs to retry later`);
  }
}

function mergeLogs(oldLogs, newLogs) {
  const merged = [...newLogs];
  for (const old of oldLogs) {
    const idx = merged.findIndex(l => l.site === old.site && l.date === old.date);
    if (idx > -1) {
      merged[idx].duration += old.duration;
      merged[idx].timestamp = Math.max(merged[idx].timestamp || 0, old.timestamp || 0);
    } else {
      merged.push(old);
    }
  }
  return merged;
}

// ─── Blocked Sites Sync ─────────────────────────────────────────────────────

async function fetchBlockedSites() {
  const result = await chrome.storage.local.get(['userToken']);
  if (!result.userToken) return;

  try {
    const response = await fetch('http://localhost:3000/api/productivity/blocked-sites', {
      headers: { 'Authorization': `Bearer ${result.userToken}` }
    });

    if (response.ok) {
      const data = await response.json();
      blockedSitesCache = (data.sites || []).map(s => s.domain);
      await chrome.storage.local.set({ blockedSites: blockedSitesCache });
    }
  } catch (error) {
    // Silently fail — will retry on next alarm
  }
}