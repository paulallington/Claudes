// Pure helpers for restoring a minimised column to a row.
// DOM-free so it can be unit-tested under plain Node.

function resolveRestoreTarget(rows, origin) {
  if (!origin || typeof origin.rowId === 'undefined' || origin.rowId === null) {
    return { mode: 'new' };
  }
  var list = Array.isArray(rows) ? rows : [];
  for (var i = 0; i < list.length; i++) {
    var row = list[i];
    if (row && (row.id === origin.rowId || row.originRowId === origin.rowId)) {
      var cols = Array.isArray(row.columnIds) ? row.columnIds : [];
      var index = origin.index;
      if (typeof index !== 'number' || !isFinite(index)) {
        index = cols.length;
      }
      if (index < 0) {
        index = 0;
      }
      if (index > cols.length) {
        index = cols.length;
      }
      return { mode: 'existing', rowId: row.id, index: index };
    }
  }
  return { mode: 'new' };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    resolveRestoreTarget: resolveRestoreTarget
  };
}
if (typeof window !== 'undefined') {
  window.MinimizeDock = {
    resolveRestoreTarget: resolveRestoreTarget
  };
}
