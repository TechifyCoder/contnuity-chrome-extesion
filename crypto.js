// ─── Continuity Crypto Module — AES-256-GCM Encryption ──────────────────────
// Encrypts domain names before storing classifications in chrome.storage.local.
// Uses Web Crypto API with a device-specific key generated on first install.

const CRYPTO_KEY_STORAGE = '__continuity_crypto_key';
const CLASSIFICATIONS_STORAGE = 'encryptedClassifications';

let _cachedKey = null;

// ─── Key Management ─────────────────────────────────────────────────────────

/**
 * Get or create the AES-256-GCM encryption key.
 * Key is generated once on first install and stored as JWK in chrome.storage.local.
 */
async function getEncryptionKey() {
  if (_cachedKey) return _cachedKey;

  const result = await chrome.storage.local.get([CRYPTO_KEY_STORAGE]);
  if (result[CRYPTO_KEY_STORAGE]) {
    _cachedKey = await crypto.subtle.importKey(
      'jwk',
      result[CRYPTO_KEY_STORAGE],
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
    return _cachedKey;
  }

  // First install — generate a new key
  const key = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true, // extractable so we can export as JWK
    ['encrypt', 'decrypt']
  );
  const jwk = await crypto.subtle.exportKey('jwk', key);
  await chrome.storage.local.set({ [CRYPTO_KEY_STORAGE]: jwk });

  // Re-import as non-extractable for safety
  _cachedKey = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
  return _cachedKey;
}

// ─── Encrypt / Decrypt ──────────────────────────────────────────────────────

/**
 * Encrypt a plaintext string using AES-256-GCM.
 * @returns {{ iv: string, ciphertext: string }} base64-encoded values
 */
async function encryptString(plaintext) {
  const key = await getEncryptionKey();
  const iv = crypto.getRandomValues(new Uint8Array(12)); // 96-bit IV for GCM
  const encoded = new TextEncoder().encode(plaintext);

  const cipherBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoded
  );

  return {
    iv: bufferToBase64(iv),
    ciphertext: bufferToBase64(new Uint8Array(cipherBuffer))
  };
}

/**
 * Decrypt a ciphertext using AES-256-GCM.
 * @param {{ iv: string, ciphertext: string }} encrypted base64-encoded values
 * @returns {string} plaintext
 */
async function decryptString(encrypted) {
  const key = await getEncryptionKey();
  const iv = base64ToBuffer(encrypted.iv);
  const cipherBuffer = base64ToBuffer(encrypted.ciphertext);

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    cipherBuffer
  );

  return new TextDecoder().decode(decrypted);
}

// ─── Base64 Helpers ─────────────────────────────────────────────────────────

function bufferToBase64(buffer) {
  let binary = '';
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ─── Classification Storage API ─────────────────────────────────────────────

/**
 * Get all stored classifications (decrypted).
 * @returns {Promise<Record<string, { label: string, classifiedAt: number, totalTime: number }>>}
 */
async function getClassifications() {
  const result = await chrome.storage.local.get([CLASSIFICATIONS_STORAGE]);
  const encrypted = result[CLASSIFICATIONS_STORAGE] || [];
  const decrypted = {};

  for (const entry of encrypted) {
    try {
      const domain = await decryptString(entry.encDomain);
      decrypted[domain] = {
        label: entry.label,          // 'productive' | 'non-productive'
        classifiedAt: entry.classifiedAt,
        totalTime: entry.totalTime || 0
      };
    } catch (e) {
      // Skip corrupted entries
      console.warn('[Crypto] Failed to decrypt entry, skipping');
    }
  }

  return decrypted;
}

/**
 * Set or update a domain's classification.
 * @param {string} domain - plaintext domain
 * @param {string} label - 'productive' or 'non-productive'
 */
async function setClassification(domain, label) {
  const result = await chrome.storage.local.get([CLASSIFICATIONS_STORAGE]);
  const encrypted = result[CLASSIFICATIONS_STORAGE] || [];

  // Check if domain already exists (decrypt each to compare)
  let found = false;
  for (const entry of encrypted) {
    try {
      const existingDomain = await decryptString(entry.encDomain);
      if (existingDomain === domain) {
        entry.label = label;
        entry.classifiedAt = Date.now();
        found = true;
        break;
      }
    } catch (e) { /* skip */ }
  }

  if (!found) {
    const encDomain = await encryptString(domain);
    encrypted.push({
      encDomain,
      label,
      classifiedAt: Date.now(),
      totalTime: 0
    });
  }

  await chrome.storage.local.set({ [CLASSIFICATIONS_STORAGE]: encrypted });
}

/**
 * Get classification for a single domain (fast lookup).
 * @returns {{ label: string, classifiedAt: number } | null}
 */
async function getClassification(domain) {
  const all = await getClassifications();
  return all[domain] || null;
}

/**
 * Update the total time for a domain in the encrypted store.
 */
async function updateDomainTime(domain, additionalSeconds) {
  const result = await chrome.storage.local.get([CLASSIFICATIONS_STORAGE]);
  const encrypted = result[CLASSIFICATIONS_STORAGE] || [];

  for (const entry of encrypted) {
    try {
      const existingDomain = await decryptString(entry.encDomain);
      if (existingDomain === domain) {
        entry.totalTime = (entry.totalTime || 0) + additionalSeconds;
        await chrome.storage.local.set({ [CLASSIFICATIONS_STORAGE]: encrypted });
        return;
      }
    } catch (e) { /* skip */ }
  }
}

/**
 * Remove a classification entry.
 */
async function removeClassification(domain) {
  const result = await chrome.storage.local.get([CLASSIFICATIONS_STORAGE]);
  const encrypted = result[CLASSIFICATIONS_STORAGE] || [];
  const filtered = [];

  for (const entry of encrypted) {
    try {
      const existingDomain = await decryptString(entry.encDomain);
      if (existingDomain !== domain) filtered.push(entry);
    } catch (e) {
      filtered.push(entry); // Keep entries we can't decrypt
    }
  }

  await chrome.storage.local.set({ [CLASSIFICATIONS_STORAGE]: filtered });
}

// ─── Initialize key on load ─────────────────────────────────────────────────
// Pre-warm the key so first encrypt/decrypt is fast
getEncryptionKey().catch(e => console.warn('[Crypto] Key init failed:', e));
