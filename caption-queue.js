/**
 * Caption review queue.
 *
 * Every finished caption line passes through this queue before it reaches phones and YouTube.
 *
 * - 'auto' mode: lines are sent immediately (unless a line ahead of them is being edited).
 * - 'veto' mode: lines wait `delayMs` (a visible countdown) and then send themselves,
 *   unless the operator rejects or edits them first.
 *
 * Lines are ALWAYS sent in the order they were spoken. A line being edited holds back the
 * lines behind it; they send right after it once the edit is saved or cancelled.
 *
 * An edit is a lease the page renews every few seconds. If the page goes away (tab closed,
 * laptop asleep) the lease expires and the original line is sent, so the feed can't get stuck.
 *
 * No timers of its own: the caller passes `now` and calls process(now) periodically.
 */

const DEFAULT_DELAY_MS = 10000;
const DEFAULT_EDIT_LEASE_MS = 15000;

class CaptionQueue {
  constructor(options = {}) {
    this.mode = options.mode === 'veto' ? 'veto' : 'auto';
    this.delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
    this.editLeaseMs = options.editLeaseMs ?? DEFAULT_EDIT_LEASE_MS;
    this.onSend = options.onSend || (() => {});
    this.onEditExpired = options.onEditExpired || (() => {});
    this.items = [];
  }

  /**
   * Add a finished line. item: { id, text, createdAt }
   */
  add(item, now) {
    this.items.push({
      id: item.id,
      text: item.text,
      createdAt: item.createdAt ?? now,
      dueAt: now + (this.mode === 'veto' ? this.delayMs : 0),
      sendNow: false,
      editing: false,
      editingSince: 0,
      editLeaseUntil: 0
    });
    this.process(now);
  }

  setMode(mode, now) {
    const next = mode === 'veto' ? 'veto' : 'auto';
    if (next === this.mode) return false;
    this.mode = next;
    if (next === 'auto') {
      // Leaving review: everything still waiting goes out now (in order)
      this.items.forEach(item => { item.sendNow = true; });
    }
    this.process(now);
    return true;
  }

  /**
   * Send this line now, together with any lines ahead of it (to keep the order).
   * Not allowed while this line or a line ahead of it is being edited.
   */
  sendNow(id, now) {
    const index = this._indexOf(id);
    if (index < 0) return { ok: false, error: 'Line not found (already sent?)' };
    for (let i = 0; i <= index; i++) {
      if (this.items[i].editing) return { ok: false, error: 'A line above is being edited' };
    }
    for (let i = 0; i <= index; i++) this.items[i].sendNow = true;
    this.process(now);
    return { ok: true };
  }

  /**
   * Remove a waiting line so it is never sent. Returns the removed item.
   */
  reject(id, now) {
    const index = this._indexOf(id);
    if (index < 0) return { ok: false, error: 'Line not found (already sent?)' };
    const [item] = this.items.splice(index, 1);
    this.process(now); // lines behind a rejected edit may now be free to go
    return { ok: true, item };
  }

  startEdit(id, now) {
    const item = this._find(id);
    if (!item) return { ok: false, error: 'Line not found (already sent?)' };
    if (item.editing && item.editLeaseUntil > now) {
      return { ok: false, error: 'This line is already being edited' };
    }
    item.editing = true;
    item.editingSince = now;
    item.editLeaseUntil = now + this.editLeaseMs;
    return { ok: true };
  }

  renewEdit(id, now) {
    const item = this._find(id);
    if (!item || !item.editing) return { ok: false, error: 'Not being edited' };
    item.editLeaseUntil = now + this.editLeaseMs;
    return { ok: true };
  }

  /**
   * Save an edit: the corrected line is sent as soon as the lines ahead of it have gone.
   */
  saveEdit(id, text, now) {
    const item = this._find(id);
    if (!item) return { ok: false, error: 'Line not found (already sent?)' };
    if (!text) return { ok: false, error: 'Text is empty' };
    item.text = text;
    item.editing = false;
    item.sendNow = true;
    this.process(now);
    return { ok: true };
  }

  /**
   * Cancel an edit: the countdown carries on (the line sends at once if its time has passed).
   */
  cancelEdit(id, now) {
    const item = this._find(id);
    if (!item) return { ok: false, error: 'Line not found (already sent?)' };
    item.editing = false;
    this.process(now);
    return { ok: true };
  }

  /**
   * Send every line that is due, in order, stopping at the first one that must wait.
   * Returns the number of lines sent.
   */
  process(now) {
    // Edits whose page stopped renewing the lease are cancelled (the original line goes out)
    this.items.forEach(item => {
      if (item.editing && item.editLeaseUntil <= now) {
        item.editing = false;
        this.onEditExpired(item);
      }
    });

    let sent = 0;
    while (this.items.length > 0) {
      const head = this.items[0];
      if (head.editing) break;
      if (!head.sendNow && now < head.dueAt) break;
      this.items.shift();
      sent++;
      this.onSend(head, now);
    }
    return sent;
  }

  /**
   * Send everything immediately (used after a server restart). Edits are dropped.
   */
  flushAll(now) {
    this.items.forEach(item => {
      item.editing = false;
      item.sendNow = true;
    });
    return this.process(now);
  }

  clear() {
    this.items = [];
  }

  snapshot(now) {
    return {
      mode: this.mode,
      delayMs: this.delayMs,
      serverNow: now,
      items: this.items.map(item => ({
        id: item.id,
        text: item.text,
        dueAt: item.dueAt,
        sendNow: item.sendNow,
        editing: item.editing,
        editingSince: item.editingSince
      }))
    };
  }

  /**
   * Items to save to disk, and restore them after a restart.
   */
  serialize() {
    return this.items.map(({ id, text, createdAt }) => ({ id, text, createdAt }));
  }

  restore(items, now) {
    (items || []).forEach(item => {
      if (item && item.id && item.text) {
        this.items.push({
          id: item.id,
          text: item.text,
          createdAt: item.createdAt || now,
          dueAt: now,
          sendNow: false,
          editing: false,
          editingSince: 0,
          editLeaseUntil: 0
        });
      }
    });
  }

  _indexOf(id) {
    return this.items.findIndex(item => item.id === id);
  }

  _find(id) {
    return this.items.find(item => item.id === id) || null;
  }
}

module.exports = { CaptionQueue, DEFAULT_DELAY_MS, DEFAULT_EDIT_LEASE_MS };
