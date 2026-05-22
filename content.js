// ─── Continuity Content Script — Video Tracking ────────────────────────────
// Injected on YouTube and Udemy pages. Detects video play/pause events and
// notifies the background service worker so it can track viewing time.

let isPlaying = false;
let debounceTimer;

function sendMessageToBackground(type) {
  try {
    chrome.runtime.sendMessage({
      type,
      source: window.location.hostname,
      title: document.title,
      url: window.location.href
    });
  } catch (error) {
    // Extension context invalidated — ignore
  }
}

function attachVideoListeners() {
  const videos = document.querySelectorAll('video');
  videos.forEach(video => {
    if (video.dataset.consistifyAttached) return;
    video.dataset.consistifyAttached = "true";

    // If video is already playing when we discover it
    if (!video.paused && !video.ended) {
      isPlaying = true;
      sendMessageToBackground('VIDEO_PLAYING');
    }

    ['play', 'playing'].forEach(evt => video.addEventListener(evt, () => {
      isPlaying = true;
      sendMessageToBackground('VIDEO_PLAYING');
    }));

    ['pause', 'ended'].forEach(evt => video.addEventListener(evt, () => {
      isPlaying = false;
      sendMessageToBackground('VIDEO_PAUSED');
    }));
  });
}

// Observe DOM mutations for dynamically loaded videos (SPAs like YouTube)
const observer = new MutationObserver((mutations) => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    if (mutations.some(m => m.addedNodes.length > 0)) {
      attachVideoListeners();
    }
  }, 500);
});

observer.observe(document.body, { childList: true, subtree: true });
attachVideoListeners();

// Send paused when navigating away
window.addEventListener('beforeunload', () => {
  if (isPlaying) sendMessageToBackground('VIDEO_PAUSED');
});

// Heartbeat to keep service worker alive during long videos
setInterval(() => {
  if (isPlaying) sendMessageToBackground('HEARTBEAT');
}, 20000);