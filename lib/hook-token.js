// A hook auth token is a 64-char lowercase hex string (crypto.randomBytes(32).toString('hex')).
function isValidHookToken(token) {
  return typeof token === 'string' && /^[a-f0-9]{64}$/.test(token);
}

module.exports = { isValidHookToken };
