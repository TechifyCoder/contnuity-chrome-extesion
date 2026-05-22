// ─── Continuity Blocker Content Script ──────────────────────────────────────
// Runs on ALL URLs at document_start.
// Checks if current domain is in the blocked list and shows block overlay.

(function() {
  const domain = window.location.hostname.replace(/^www\./, '');

  chrome.storage.local.get(['blockedSites', 'tempUnblocked'], (result) => {
    const blockedSites = result.blockedSites || [];
    const tempUnblocked = result.tempUnblocked || {};
    
    if (tempUnblocked[domain] && Date.now() < tempUnblocked[domain]) return;

    if (tempUnblocked[domain]) {
      delete tempUnblocked[domain];
      chrome.storage.local.set({ tempUnblocked });
    }

    if (blockedSites.includes(domain)) {
      if (document.body) createOverlay();
      else document.addEventListener('DOMContentLoaded', createOverlay);
    }
  });

  function createOverlay() {
    const host = document.createElement('div');
    host.id = 'consistify-block-host';
    host.style.cssText = 'position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; z-index: 2147483647;';
    
    const shadow = host.attachShadow({ mode: 'closed' });
    const overlay = document.createElement('div');
    overlay.innerHTML = `
      <style>
        .container { width: 100%; height: 100%; background: linear-gradient(135deg, #0f0f23 0%, #1a1a3e 50%, #0f0f23 100%); display: flex; flex-direction: column; align-items: center; justify-content: center; font-family: sans-serif; color: white; }
        h1 { color: #ff6b6b; margin-bottom: 12px; }
        .block-domain { background: rgba(255,255,255,0.1); padding: 8px 20px; border-radius: 8px; font-family: monospace; margin-bottom: 20px; }
        .block-btn { padding: 12px 28px; background: rgba(255,255,255,0.05); color: white; border: 1px solid rgba(255,255,255,0.2); cursor: pointer; border-radius: 12px; }
      </style>
      <div class="container">
        <h1>Site Blocked</h1>
        <div class="block-domain">${domain}</div>
        <button class="block-btn" id="temp-unblock">Allow for 5 minutes</button>
      </div>
    `;

    shadow.appendChild(overlay);
    document.documentElement.appendChild(host);
    document.body.style.overflow = 'hidden';

    shadow.getElementById('temp-unblock').addEventListener('click', () => {
      host.remove();
      document.body.style.overflow = '';
      chrome.storage.local.get(['tempUnblocked'], (result) => {
        const tempUnblocked = result.tempUnblocked || {};
        tempUnblocked[domain] = Date.now() + 5 * 60 * 1000;
        chrome.storage.local.set({ tempUnblocked });
      });
    });
  }
})();