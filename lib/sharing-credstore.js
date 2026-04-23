'use strict';

/**
 * Build a credential store bound to a specific safeStorage implementation,
 * fs module, and file path. Injectable so tests can use fakes.
 *
 * Stored shape: { connectionString, dbName }.
 * On disk: Electron safeStorage ciphertext (DPAPI on Windows, Keychain on macOS).
 */
function createCredStore({ safeStorage, fs, filePath }) {
  function isAvailable() {
    return safeStorage.isEncryptionAvailable();
  }

  function read() {
    if (!fs.existsSync(filePath)) return null;
    let ciphertext;
    try {
      ciphertext = fs.readFileSync(filePath);
    } catch {
      return null;
    }
    let plain;
    try {
      plain = safeStorage.decryptString(ciphertext);
    } catch {
      return null;
    }
    try {
      const parsed = JSON.parse(plain);
      if (parsed && typeof parsed.connectionString === 'string' && typeof parsed.dbName === 'string') {
        return { connectionString: parsed.connectionString, dbName: parsed.dbName };
      }
      return null;
    } catch {
      return null;
    }
  }

  function write({ connectionString, dbName }) {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Credential encryption is not available on this machine');
    }
    const ciphertext = safeStorage.encryptString(JSON.stringify({ connectionString, dbName }));
    fs.writeFileSync(filePath, ciphertext);
  }

  function clear() {
    if (!fs.existsSync(filePath)) return;
    try {
      fs.unlinkSync(filePath);
    } catch {
      // If the file disappeared between exists check and unlink, ignore.
    }
  }

  return { isAvailable, read, write, clear };
}

module.exports = { createCredStore };
