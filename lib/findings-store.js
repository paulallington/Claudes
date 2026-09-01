/**
 * Pure core of the automation findings inbox: identity (fingerprinting),
 * recurrence (upsert), acknowledgement, and pruning. Automations report
 * `attentionItems` on every run; the hard problem is that a recurring
 * finding (e.g. "Certificate expiring in N days") must collapse into one
 * entry that gets bumped, not appended fresh every run. No fs, no
 * Electron, no DOM — pure data in, pure data out.
 */
(function () {
'use strict';

/**
 * Normalise a finding summary for fingerprinting: lowercase, collapse
 * whitespace, fold ISO dates and digit runs to a single placeholder so
 * "expiring in 12 days" and "expiring in 11 days" hash the same, and strip
 * trailing punctuation.
 * @param {string} summary
 * @returns {string}
 */
function normalizeSummary(summary) {
  var s = typeof summary === 'string' ? summary : '';
  s = s.toLowerCase();
  // ISO date/datetime, e.g. 2026-08-30 or 2026-08-30t12:00:00.000z
  s = s.replace(/\d{4}-\d{2}-\d{2}(t[\d:.,+-]*z?)?/g, 'n');
  s = s.replace(/\d+/g, 'n');
  s = s.replace(/\s+/g, ' ').trim();
  s = s.replace(/[.,;:!?]+$/, '');
  return s;
}

/**
 * FNV-1a hash, hex-encoded. Deterministic, dependency-free.
 * @param {string} str
 * @returns {string}
 */
function fnv1aHex(str) {
  var hash = 0x811c9dc5;
  for (var i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return (hash >>> 0).toString(16);
}

/**
 * Stable fingerprint for a finding within an automation+agent. Prefers an
 * explicit `item.key` (a stable business identifier the automation
 * controls); falls back to hashing the normalised summary so recurring
 * "N days left" style findings collapse together.
 * @param {string} automationId
 * @param {string} agentId
 * @param {{ key?: string, summary?: string }} item
 * @returns {string}
 */
function fingerprintFinding(automationId, agentId, item) {
  var aId = automationId || '';
  var gId = agentId || '';
  var it = item && typeof item === 'object' ? item : {};
  var suffix;
  if (typeof it.key === 'string' && it.key.trim() !== '') {
    suffix = it.key;
  } else {
    suffix = fnv1aHex(normalizeSummary(it.summary));
  }
  return aId + ':' + gId + ':' + suffix;
}

/**
 * Return `now` (an ISO string or Date) as an ISO string, defaulting to the
 * current time when neither is given.
 * @param {string|Date} now
 * @returns {string}
 */
function toIso(now) {
  if (now instanceof Date) return now.toISOString();
  if (typeof now === 'string') return now;
  return new Date().toISOString();
}

/**
 * Coerce a possibly-missing/malformed store into a valid `{ version: 1,
 * findings: [] }` shape. Never mutates the input.
 * @param {*} store
 * @returns {{ version: 1, findings: Array }}
 */
function normalizeStore(store) {
  if (!store || typeof store !== 'object' || !Array.isArray(store.findings)) {
    return { version: 1, findings: [] };
  }
  return { version: 1, findings: store.findings.slice() };
}

var idCounter = 0;

/**
 * Generate a unique-within-process finding id without `crypto`.
 * @returns {string}
 */
function nextId() {
  idCounter = (idCounter + 1) % 0xffffff;
  var ts = Date.now().toString(16);
  var rand = Math.floor(Math.random() * 0xffff).toString(16);
  return 'fnd_' + ts + idCounter.toString(16) + rand;
}

/**
 * Upsert a batch of reported findings into `store`, keyed by fingerprint.
 * A fingerprint match refreshes the mutable fields and bumps `occurrences`
 * while preserving `firstSeenAt` and `acknowledgedAt`; a miss creates a new
 * entry. Pure — does not mutate `store` or `entries`.
 * @param {{ version: 1, findings: Array }} store
 * @param {Array<{ automationId, automationName, agentId, agentName, item, runStartedAt, sessionId, cwd, profileId }>} entries
 * @param {string|Date} now
 * @returns {{ store: { version: 1, findings: Array }, newFindings: Array }}
 */
function upsertFindings(store, entries, now) {
  var nowIso = toIso(now);
  var base = normalizeStore(store);
  var findings = base.findings.slice();
  var list = Array.isArray(entries) ? entries : [];
  var newFindings = [];

  for (var i = 0; i < list.length; i++) {
    var entry = list[i] || {};
    var item = entry.item && typeof entry.item === 'object' ? entry.item : {};
    var fp = fingerprintFinding(entry.automationId, entry.agentId, item);
    var idx = -1;
    for (var j = 0; j < findings.length; j++) {
      if (findings[j].fingerprint === fp) { idx = j; break; }
    }

    if (idx === -1) {
      var created = {
        id: nextId(),
        fingerprint: fp,
        automationId: entry.automationId || null,
        automationName: entry.automationName || null,
        agentId: entry.agentId || null,
        agentName: entry.agentName || null,
        summary: item.summary || '',
        detail: item.detail != null ? item.detail : null,
        runStartedAt: entry.runStartedAt || null,
        sessionId: entry.sessionId || null,
        cwd: entry.cwd || null,
        profileId: entry.profileId != null ? entry.profileId : null,
        firstSeenAt: nowIso,
        lastSeenAt: nowIso,
        occurrences: 1,
        acknowledgedAt: null,
      };
      findings.push(created);
      newFindings.push(created);
    } else {
      var existing = findings[idx];
      var wasAcknowledged = !!existing.acknowledgedAt;
      var updated = Object.assign({}, existing, {
        automationName: entry.automationName || existing.automationName,
        agentName: entry.agentName || existing.agentName,
        summary: item.summary || existing.summary,
        detail: item.detail != null ? item.detail : existing.detail,
        runStartedAt: entry.runStartedAt || existing.runStartedAt,
        sessionId: entry.sessionId || existing.sessionId,
        cwd: entry.cwd || existing.cwd,
        profileId: entry.profileId != null ? entry.profileId : existing.profileId,
        lastSeenAt: nowIso,
        occurrences: existing.occurrences + 1,
      });
      findings[idx] = updated;
      // A recurring finding stays acknowledged (acknowledgedAt is never
      // cleared here) — this branch exists for symmetry with the
      // documented contract but currently never fires from upsert alone.
      if (wasAcknowledged && !updated.acknowledgedAt) {
        newFindings.push(updated);
      }
    }
  }

  return { store: { version: 1, findings: findings }, newFindings: newFindings };
}

/**
 * Mark a single finding acknowledged by id. Pure — returns a new store; a
 * missing id leaves the store unchanged (a fresh, but equal, store).
 * @param {{ version: 1, findings: Array }} store
 * @param {string} id
 * @param {string|Date} now
 * @returns {{ version: 1, findings: Array }}
 */
function acknowledgeFinding(store, id, now) {
  var nowIso = toIso(now);
  var base = normalizeStore(store);
  var findings = base.findings.map(function (f) {
    if (f.id === id) return Object.assign({}, f, { acknowledgedAt: nowIso });
    return f;
  });
  return { version: 1, findings: findings };
}

/**
 * Evict from `list` down to `cap` entries, oldest-acknowledged first (by
 * `acknowledgedAt` ascending, tie-broken by `lastSeenAt` ascending).
 * Unacknowledged findings are never eviction candidates, so `list` can
 * remain over `cap` when there aren't enough acknowledged entries to evict.
 * @param {Array} list
 * @param {number} cap
 * @returns {Array}
 */
function evictOldestAcknowledgedFirst(list, cap) {
  if (list.length <= cap) return list;
  var kept = list.slice();
  while (kept.length > cap) {
    var candidateIdx = -1;
    for (var i = 0; i < kept.length; i++) {
      if (!kept[i].acknowledgedAt) continue;
      if (candidateIdx === -1) { candidateIdx = i; continue; }
      var a = kept[i], b = kept[candidateIdx];
      var aAck = new Date(a.acknowledgedAt).getTime();
      var bAck = new Date(b.acknowledgedAt).getTime();
      if (aAck !== bAck) {
        if (aAck < bAck) candidateIdx = i;
      } else if (new Date(a.lastSeenAt).getTime() < new Date(b.lastSeenAt).getTime()) {
        candidateIdx = i;
      }
    }
    if (candidateIdx === -1) break; // nothing left to evict — all remaining are unacknowledged
    kept.splice(candidateIdx, 1);
  }
  return kept;
}

/**
 * Prune `store`: drop acknowledged findings older than `ackMaxAgeDays` (by
 * `lastSeenAt`), then enforce per-automation and global caps, evicting
 * oldest-acknowledged first and then oldest `lastSeenAt`. Unacknowledged
 * findings are never pruned, even over cap. Pure — returns a new store.
 * @param {{ version: 1, findings: Array }} store
 * @param {string|Date} now
 * @param {{ perAutomation?: number, global?: number, ackMaxAgeDays?: number }} [caps]
 * @returns {{ version: 1, findings: Array }}
 */
function pruneFindings(store, now, caps) {
  var c = caps && typeof caps === 'object' ? caps : {};
  var perAutomation = typeof c.perAutomation === 'number' ? c.perAutomation : 100;
  var global = typeof c.global === 'number' ? c.global : 500;
  var ackMaxAgeDays = typeof c.ackMaxAgeDays === 'number' ? c.ackMaxAgeDays : 30;
  var nowMs = new Date(toIso(now)).getTime();
  var maxAgeMs = ackMaxAgeDays * 24 * 60 * 60 * 1000;

  var base = normalizeStore(store);
  var findings = base.findings.filter(function (f) {
    if (!f.acknowledgedAt) return true;
    var lastSeenMs = new Date(f.lastSeenAt).getTime();
    if (isNaN(lastSeenMs)) return true;
    return (nowMs - lastSeenMs) <= maxAgeMs;
  });

  var byAutomation = Object.create(null);
  var order = [];
  findings.forEach(function (f) {
    var key = f.automationId || '';
    if (!byAutomation[key]) { byAutomation[key] = []; order.push(key); }
    byAutomation[key].push(f);
  });
  var afterPerAutomation = [];
  order.forEach(function (key) {
    afterPerAutomation = afterPerAutomation.concat(evictOldestAcknowledgedFirst(byAutomation[key], perAutomation));
  });

  var afterGlobal = evictOldestAcknowledgedFirst(afterPerAutomation, global);

  return { version: 1, findings: afterGlobal };
}

/**
 * Acknowledge every currently-unacknowledged finding, optionally scoped to
 * one automation. Pure — returns a new store.
 * @param {{ version: 1, findings: Array }} store
 * @param {{ automationId?: string }|null} filter
 * @param {string|Date} now
 * @returns {{ version: 1, findings: Array }}
 */
function acknowledgeAll(store, filter, now) {
  var nowIso = toIso(now);
  var base = normalizeStore(store);
  var automationId = filter && typeof filter === 'object' ? filter.automationId : null;
  var findings = base.findings.map(function (f) {
    if (f.acknowledgedAt) return f;
    if (automationId && f.automationId !== automationId) return f;
    return Object.assign({}, f, { acknowledgedAt: nowIso });
  });
  return { version: 1, findings: findings };
}

/**
 * List findings, newest `lastSeenAt` first, optionally filtered to only
 * unacknowledged findings.
 * @param {{ version: 1, findings: Array }} store
 * @param {{ unacknowledgedOnly?: boolean }} [opts]
 * @returns {Array}
 */
function listFindings(store, opts) {
  var base = normalizeStore(store);
  var o = opts && typeof opts === 'object' ? opts : {};
  var list = base.findings.slice();
  if (o.unacknowledgedOnly) {
    list = list.filter(function (f) { return !f.acknowledgedAt; });
  }
  list.sort(function (a, b) {
    return new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime();
  });
  return list;
}

var api = {
  fingerprintFinding: fingerprintFinding,
  upsertFindings: upsertFindings,
  acknowledgeFinding: acknowledgeFinding,
  acknowledgeAll: acknowledgeAll,
  pruneFindings: pruneFindings,
  listFindings: listFindings,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
}
if (typeof window !== 'undefined') {
  window.FindingsStore = api;
}

})();
