// Day-record helpers for item details: finishing and resetting set progress.
// Pure, so Node tests can drive it without a DOM.

/** Remove persisted set-counter progress for one item. Used when the Today row is unchecked. */
export function clearItemProgress(day, itemKey) {
  if (!day || !itemKey || !day.set_progress || !Object.prototype.hasOwnProperty.call(day.set_progress, itemKey)) return day;
  const set_progress = { ...day.set_progress };
  delete set_progress[itemKey];
  return { ...day, set_progress };
}

/** Always-visible Finish control for an item details sheet. */
export function finishBarHtml() {
  return `<div class="sheet-actions ex-finish"><button class="btn primary wide" type="button" data-ex-finish>Finish</button></div>`;
}

/** Finish, then the unexpected-pain checkbox, so the flag is last in the sheet. */
export function itemSheetTailHtml(painFlagHtml = "") {
  return `${finishBarHtml()}${painFlagHtml}`;
}
