// ─── Continuity v3.0 — Popup Controller ─────────────────────────────────────
// Handles classification prompts, chart rendering, site management, and stats.

document.addEventListener('DOMContentLoaded', () => {
  // ─── DOM References ───────────────────────────────────────────────────────
  const classifyBanner = document.getElementById('classify-banner');
  const classifyDomain = document.getElementById('classify-domain');
  const btnProductive = document.getElementById('btn-classify-productive');
  const btnNonProductive = document.getElementById('btn-classify-nonproductive');
  const btnDismiss = document.getElementById('btn-classify-dismiss');
  const toast = document.getElementById('toast');

  const productiveTimeEl = document.getElementById('productive-time');
  const unproductiveTimeEl = document.getElementById('unproductive-time');
  const totalTimeEl = document.getElementById('total-time');
  const scorePercent = document.getElementById('score-percent');
  const scoreDisplay = document.getElementById('score-display');
  const scoreSub = document.getElementById('score-sub');
  const scoreArc = document.getElementById('score-arc');

  const chartContainer = document.getElementById('chart-container');
  const btnDaily = document.getElementById('btn-daily');
  const btnWeekly = document.getElementById('btn-weekly');

  const sitesList = document.getElementById('sites-list');

  const blockCurrentBtn = document.getElementById('block-current-btn');
  const currentDomainDisplay = document.getElementById('current-domain-display');

  const tokenInput = document.getElementById('extension-token');
  const saveBtn = document.getElementById('save-btn');
  const statusMsg = document.getElementById('status-msg');

  const reclassifyModal = document.getElementById('reclassify-modal');
  const modalDomain = document.getElementById('modal-domain');
  const modalProductive = document.getElementById('modal-productive');
  const modalNonProductive = document.getElementById('modal-nonproductive');
  const modalCancel = document.getElementById('modal-cancel');

  let currentDomain = null;
  let currentView = 'daily';
  let allClassifications = {};
  let dailySiteData = {};
  let weeklySiteData = {};
  let reclassifyTarget = null;

  // ─── Helpers ──────────────────────────────────────────────────────────────

  function getTodayDateString() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function extractDomain(urlString) {
    try {
      const hostname = new URL(urlString).hostname.replace(/^www\./, '');
      const parts = hostname.split('.');
      if (parts.length > 2) {
        const knownTLDs = ['co.uk', 'com.au', 'co.in', 'com.br', 'co.jp'];
        const lastTwo = parts.slice(-2).join('.');
        if (knownTLDs.includes(lastTwo)) return parts.slice(-3).join('.');
        return parts.slice(-2).join('.');
      }
      return hostname;
    } catch { return null; }
  }

  function formatTime(seconds) {
    if (seconds < 60) return `${seconds}s`;
    const mins = Math.floor(seconds / 60);
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    const remainMins = mins % 60;
    return remainMins > 0 ? `${hrs}h ${remainMins}m` : `${hrs}h`;
  }

  function showToast(message, duration = 2500) {
    toast.textContent = message;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), duration);
  }

  function showStatus(msg, isError = false) {
    statusMsg.textContent = msg;
    statusMsg.style.color = isError ? 'var(--danger)' : 'var(--success)';
    statusMsg.classList.add('show');
    setTimeout(() => statusMsg.classList.remove('show'), 3000);
  }

  function getClassForDomain(domain) {
    if (allClassifications[domain]) return allClassifications[domain].label;
    return 'unclassified';
  }

  // ─── Initialize ───────────────────────────────────────────────────────────

  async function initialize() {
    // Load token
    const localResult = await chrome.storage.local.get(['userToken', 'dailyStats', 'blockedSites', 'weeklyHistory']);
    const sessionResult = await chrome.storage.session.get(['activeSessions', 'pendingClassification']);

    if (localResult.userToken) tokenInput.value = localResult.userToken;

    // Load classifications from background
    try {
      const response = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'GET_CLASSIFICATIONS' }, resolve);
      });
      if (response && response.success) {
        allClassifications = response.data || {};
      }
    } catch (e) { /* fallback to empty */ }

    // Build daily stats (merge active sessions)
    const stats = localResult.dailyStats || { date: getTodayDateString(), sites: {} };
    const activeSessions = sessionResult.activeSessions || {};
    const blockedSites = localResult.blockedSites || [];
    const today = getTodayDateString();

    if (stats.date !== today) {
      stats.sites = {};
      stats.date = today;
    }

    // Deep copy and merge active sessions
    dailySiteData = {};
    for (const [site, data] of Object.entries(stats.sites)) {
      if (typeof data === 'object') {
        dailySiteData[site] = { ...data };
      } else {
        // Legacy format: just seconds
        dailySiteData[site] = { seconds: data, classification: getClassForDomain(site) };
      }
    }

    const now = Date.now();
    for (const tId in activeSessions) {
      const session = activeSessions[tId];
      if (!session.site) continue;
      const durationSec = Math.floor((now - session.startTime) / 1000);
      if (durationSec > 0) {
        if (!dailySiteData[session.site]) {
          dailySiteData[session.site] = { seconds: 0, classification: getClassForDomain(session.site) };
        }
        dailySiteData[session.site].seconds += durationSec;
      }
    }

    // Ensure classifications are applied
    for (const site in dailySiteData) {
      dailySiteData[site].classification = getClassForDomain(site);
    }

    // Build weekly data
    const weeklyHistory = localResult.weeklyHistory || [];
    weeklySiteData = {};
    for (const dayEntry of weeklyHistory) {
      for (const [site, data] of Object.entries(dayEntry.sites)) {
        if (!weeklySiteData[site]) {
          weeklySiteData[site] = { seconds: 0, classification: getClassForDomain(site) };
        }
        const secs = typeof data === 'object' ? data.seconds : data;
        weeklySiteData[site].seconds += secs;
      }
    }
    // Also add today's data to weekly
    for (const [site, data] of Object.entries(dailySiteData)) {
      if (!weeklySiteData[site]) {
        weeklySiteData[site] = { seconds: 0, classification: getClassForDomain(site) };
      }
      weeklySiteData[site].seconds += data.seconds;
    }

    // Render everything
    renderStats(dailySiteData);
    renderChart(dailySiteData);
    renderSitesList(dailySiteData);
    setupBlockButton(blockedSites);
    checkPendingClassification(sessionResult.pendingClassification);
  }

  // ─── Check Pending Classification ─────────────────────────────────────────

  function checkPendingClassification(pending) {
    if (!pending || !pending.domain) {
      classifyBanner.classList.add('hidden');
      return;
    }
    // Check if already classified
    if (allClassifications[pending.domain]) {
      classifyBanner.classList.add('hidden');
      return;
    }
    classifyDomain.textContent = pending.domain;
    classifyBanner.classList.remove('hidden');
    classifyBanner.dataset.domain = pending.domain;
  }

  // ─── Classification Actions ───────────────────────────────────────────────

  btnProductive.addEventListener('click', () => classifyCurrentDomain('productive'));
  btnNonProductive.addEventListener('click', () => classifyCurrentDomain('non-productive'));
  btnDismiss.addEventListener('click', () => {
    const domain = classifyBanner.dataset.domain;
    chrome.runtime.sendMessage({ type: 'DISMISS_CLASSIFICATION', domain });
    classifyBanner.classList.add('hidden');
    showToast(`${domain} skipped — will ask again next visit`);
  });

  async function classifyCurrentDomain(label) {
    const domain = classifyBanner.dataset.domain;
    if (!domain) return;

    try {
      await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'CLASSIFY_DOMAIN', domain, label }, resolve);
      });

      allClassifications[domain] = { label, classifiedAt: Date.now() };
      classifyBanner.classList.add('hidden');

      const labelDisplay = label === 'productive' ? 'Productive ✅' : 'Non-Productive ❌';
      showToast(`${domain} saved as ${labelDisplay}`);

      // Update existing data classifications
      if (dailySiteData[domain]) dailySiteData[domain].classification = label;
      if (weeklySiteData[domain]) weeklySiteData[domain].classification = label;

      // Re-render
      renderStats(dailySiteData);
      renderChart(currentView === 'daily' ? dailySiteData : weeklySiteData);
      renderSitesList(currentView === 'daily' ? dailySiteData : weeklySiteData);
    } catch (e) {
      showToast('Failed to save classification', 3000);
    }
  }

  // ─── Render Stats ─────────────────────────────────────────────────────────

  function renderStats(siteData) {
    let prodSecs = 0, nonProdSecs = 0, totalSecs = 0;

    for (const [site, data] of Object.entries(siteData)) {
      const secs = data.seconds || 0;
      totalSecs += secs;
      const cl = data.classification || getClassForDomain(site);
      if (cl === 'productive') prodSecs += secs;
      else if (cl === 'non-productive') nonProdSecs += secs;
    }

    productiveTimeEl.textContent = formatTime(prodSecs);
    unproductiveTimeEl.textContent = formatTime(nonProdSecs);
    totalTimeEl.textContent = formatTime(totalSecs);

    // Productivity score (productive / (productive + non-productive))
    const classifiedTotal = prodSecs + nonProdSecs;
    const score = classifiedTotal > 0 ? Math.round((prodSecs / classifiedTotal) * 100) : 0;

    scorePercent.textContent = `${score}%`;
    scoreDisplay.textContent = `${score}%`;

    // Color the score
    let scoreColor = 'var(--text-muted)';
    if (score >= 70) scoreColor = 'var(--success)';
    else if (score >= 40) scoreColor = 'var(--warning)';
    else if (classifiedTotal > 0) scoreColor = 'var(--danger)';

    scorePercent.style.color = scoreColor;
    scoreDisplay.style.color = scoreColor;
    scoreArc.style.stroke = scoreColor;

    // Animate ring (circumference = 2 * PI * 22 ≈ 138.23)
    const circumference = 138.23;
    const offset = circumference - (score / 100) * circumference;
    scoreArc.style.strokeDashoffset = offset;

    // Sub text
    if (totalSecs === 0) {
      scoreSub.textContent = 'No data yet';
    } else {
      const unclassifiedSecs = totalSecs - classifiedTotal;
      if (unclassifiedSecs > 0) {
        scoreSub.textContent = `${formatTime(unclassifiedSecs)} unclassified`;
      } else {
        scoreSub.textContent = score >= 70 ? 'Great focus! 🔥' : score >= 40 ? 'Keep improving! 💪' : 'Too much distraction 😟';
      }
    }
  }

  // ─── Render Chart ─────────────────────────────────────────────────────────

  function renderChart(siteData) {
    const entries = Object.entries(siteData)
      .map(([site, data]) => ({
        site,
        seconds: data.seconds || 0,
        classification: data.classification || getClassForDomain(site)
      }))
      .filter(e => e.seconds > 0)
      .sort((a, b) => b.seconds - a.seconds)
      .slice(0, 8); // Top 8 sites

    if (entries.length === 0) {
      chartContainer.innerHTML = '<div class="chart-empty">No usage data for this period</div>';
      return;
    }

    const maxSeconds = entries[0].seconds;

    let html = '<div class="chart-bar-wrapper">';
    for (const entry of entries) {
      const pct = Math.max(3, (entry.seconds / maxSeconds) * 100);
      let barClass = 'unclassified';
      if (entry.classification === 'productive') barClass = 'productive';
      else if (entry.classification === 'non-productive') barClass = 'nonproductive';

      html += `
        <div class="chart-bar-row">
          <div class="chart-bar-label" title="${entry.site}">${entry.site}</div>
          <div class="chart-bar-track">
            <div class="chart-bar-fill ${barClass}" style="width: ${pct}%"></div>
          </div>
          <div class="chart-bar-time">${formatTime(entry.seconds)}</div>
        </div>
      `;
    }
    html += '</div>';
    chartContainer.innerHTML = html;
  }

  // Chart toggle
  btnDaily.addEventListener('click', () => {
    currentView = 'daily';
    btnDaily.classList.add('active');
    btnWeekly.classList.remove('active');
    renderChart(dailySiteData);
    renderSitesList(dailySiteData);
  });

  btnWeekly.addEventListener('click', () => {
    currentView = 'weekly';
    btnWeekly.classList.add('active');
    btnDaily.classList.remove('active');
    renderChart(weeklySiteData);
    renderSitesList(weeklySiteData);
  });

  // ─── Render Sites List ────────────────────────────────────────────────────

  function renderSitesList(siteData) {
    const entries = Object.entries(siteData)
      .map(([site, data]) => ({
        site,
        seconds: data.seconds || 0,
        classification: data.classification || getClassForDomain(site)
      }))
      .filter(e => e.seconds > 0)
      .sort((a, b) => b.seconds - a.seconds);

    if (entries.length === 0) {
      sitesList.innerHTML = '<div class="chart-empty">No sites tracked yet</div>';
      return;
    }

    let html = '';
    for (const entry of entries) {
      let dotClass = 'unclassified';
      if (entry.classification === 'productive') dotClass = 'productive';
      else if (entry.classification === 'non-productive') dotClass = 'nonproductive';

      html += `
        <div class="site-item">
          <div class="site-dot ${dotClass}"></div>
          <div class="site-info">
            <div class="site-domain">${entry.site}</div>
            <div class="site-time">${formatTime(entry.seconds)} · ${entry.classification.replace('-', ' ')}</div>
          </div>
          <div class="site-actions">
            <button class="site-edit-btn" data-domain="${entry.site}">Edit</button>
          </div>
        </div>
      `;
    }
    sitesList.innerHTML = html;

    // Attach edit listeners
    sitesList.querySelectorAll('.site-edit-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const domain = e.target.dataset.domain;
        openReclassifyModal(domain);
      });
    });
  }

  // ─── Reclassify Modal ─────────────────────────────────────────────────────

  function openReclassifyModal(domain) {
    reclassifyTarget = domain;
    modalDomain.textContent = domain;
    reclassifyModal.classList.remove('hidden');
  }

  modalCancel.addEventListener('click', () => {
    reclassifyModal.classList.add('hidden');
    reclassifyTarget = null;
  });

  reclassifyModal.addEventListener('click', (e) => {
    if (e.target === reclassifyModal) {
      reclassifyModal.classList.add('hidden');
      reclassifyTarget = null;
    }
  });

  modalProductive.addEventListener('click', () => reclassifyDomain('productive'));
  modalNonProductive.addEventListener('click', () => reclassifyDomain('non-productive'));

  async function reclassifyDomain(label) {
    if (!reclassifyTarget) return;
    const domain = reclassifyTarget;

    try {
      await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'RECLASSIFY_DOMAIN', domain, label }, resolve);
      });

      allClassifications[domain] = { label, classifiedAt: Date.now() };
      reclassifyModal.classList.add('hidden');
      reclassifyTarget = null;

      const labelDisplay = label === 'productive' ? 'Productive ✅' : 'Non-Productive ❌';
      showToast(`${domain} reclassified as ${labelDisplay}`);

      // Update data
      if (dailySiteData[domain]) dailySiteData[domain].classification = label;
      if (weeklySiteData[domain]) weeklySiteData[domain].classification = label;

      // Re-render
      renderStats(dailySiteData);
      renderChart(currentView === 'daily' ? dailySiteData : weeklySiteData);
      renderSitesList(currentView === 'daily' ? dailySiteData : weeklySiteData);
    } catch (e) {
      showToast('Failed to reclassify', 3000);
    }
  }

  // ─── Block Button ─────────────────────────────────────────────────────────

  function setupBlockButton(blockedSites) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab || !tab.url) {
        disableBlockBtn('Cannot detect site');
        return;
      }

      currentDomain = extractDomain(tab.url);

      if (!currentDomain || /^(chrome|edge|brave|about)/.test(currentDomain)) {
        currentDomainDisplay.textContent = 'System Page';
        disableBlockBtn('Cannot block browser pages');
        return;
      }

      currentDomainDisplay.textContent = currentDomain;

      if (blockedSites.includes(currentDomain)) {
        setUnblockUI();
      } else {
        setBlockUI();
      }
    });
  }

  function disableBlockBtn(text) {
    blockCurrentBtn.textContent = `❌ ${text}`;
    blockCurrentBtn.style.opacity = '0.5';
    blockCurrentBtn.style.cursor = 'not-allowed';
    blockCurrentBtn.disabled = true;
  }

  function setBlockUI() {
    blockCurrentBtn.innerHTML = '🚫 Block Current Site';
    blockCurrentBtn.className = 'action-btn btn-block';
    blockCurrentBtn.disabled = false;
    blockCurrentBtn.style.opacity = '1';
    blockCurrentBtn.style.cursor = 'pointer';
  }

  function setUnblockUI() {
    blockCurrentBtn.innerHTML = '✅ Unblock Current Site';
    blockCurrentBtn.className = 'action-btn btn-unblock';
    blockCurrentBtn.disabled = false;
    blockCurrentBtn.style.opacity = '1';
    blockCurrentBtn.style.cursor = 'pointer';
  }

  blockCurrentBtn.addEventListener('click', () => {
    if (!currentDomain || blockCurrentBtn.disabled) return;

    chrome.storage.local.get(['blockedSites'], (result) => {
      let sites = result.blockedSites || [];
      if (sites.includes(currentDomain)) {
        sites = sites.filter(s => s !== currentDomain);
        setBlockUI();
        showToast(`${currentDomain} unblocked`);
      } else {
        sites.push(currentDomain);
        setUnblockUI();
        showToast(`${currentDomain} blocked`);
      }
      chrome.storage.local.set({ blockedSites: sites });
    });
  });

  // ─── Token Save ───────────────────────────────────────────────────────────

  saveBtn.addEventListener('click', () => {
    const token = tokenInput.value.trim();
    if (!token) {
      showStatus('Please enter a token.', true);
      return;
    }
    chrome.storage.local.set({ userToken: token }, () => {
      showStatus('Token saved successfully!');
    });
  });

  // ─── Start ────────────────────────────────────────────────────────────────

  initialize().catch(e => console.error('[Popup] Init failed:', e));
});