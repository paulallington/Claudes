function computeMaximizeRowOp(rows, targetRowId) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { hide: [], expand: null, snapshot: null };
  }
  var target = null;
  var hide = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (!r) continue;
    if (r.id === targetRowId) {
      target = r;
    } else {
      hide.push(r.id);
    }
  }
  if (!target) {
    return { hide: [], expand: null, snapshot: null };
  }
  return {
    hide: hide,
    expand: { rowId: target.id, flex: '1', height: '' },
    snapshot: {
      rowId: target.id,
      flex: target.inlineFlex != null ? target.inlineFlex : '',
      height: target.inlineHeight != null ? target.inlineHeight : '',
    },
  };
}

function computeRestoreRowOp(snapshot) {
  if (!snapshot) return null;
  return {
    rowId: snapshot.rowId,
    flex: snapshot.flex != null ? snapshot.flex : '',
    height: snapshot.height != null ? snapshot.height : '',
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { computeMaximizeRowOp, computeRestoreRowOp };
}
if (typeof window !== 'undefined') {
  window.MaximizeLayout = { computeMaximizeRowOp: computeMaximizeRowOp, computeRestoreRowOp: computeRestoreRowOp };
}
