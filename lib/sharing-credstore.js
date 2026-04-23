'use strict';

/**
 * Build a credential store bound to a specific safeStorage implementation,
 * fs module, and file path. Injectable so tests can use fakes.
 *
 * Stored shape: { connectionString, dbName }.
 * On disk: Electron safeStorage ciphertext (DPAPI on Windows, Keychain on macOS).
 *
 * Optional `log` is called with a tag string and an error message on each
 * read-path failure (missing file is not a failure — it returns null silently).
 */
function createCredStore({ safeStorage, fs, filePath, log = () => {} }) {
  function isAvailable() {
    return safeStorage.isEncryptionAvailable();
  }

  function read() {
    if (!fs.existsSync(filePath)) return null;
    let ciphertext;
    try {
      ciphertext = fs.readFileSync(filePath);
    } catch (err) {
      log('sharing-credstore: read failed', err && err.message);
      return null;
    }
    let plain;
    try {
      plain = safeStorage.decryptString(ciphertext);
    } catch (err) {
      log('sharing-credstore: decrypt failed', err && err.message);
      return null;
    }
    try {
      const parsed = JSON.parse(plain);
      if (parsed && typeof parsed.connectionString === 'string' && typeof parsed.dbName === 'string') {
        return { connectionString: parsed.connectionString, dbName: parsed.dbName };
      }
      return null;
    } catch (err) {
      log('sharing-credstore: parse failed', err && err.message);
      return null;
    }
  }

  function write({ connectionString, dbName }) {
    if (typeof connectionString !== 'string' || typeof dbName !== 'string') {
      throw new TypeError('connectionString and dbName must be strings');
    }
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Credential encryption is not available on this machine');
    }
    const ciphertext = safeStorage.encryptString(JSON.stringify({ connectionString, dbName }));
    // Caller is responsible for ensuring the parent directory of filePath exists.
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
