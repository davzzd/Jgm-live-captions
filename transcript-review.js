/**
 * Caption review on the transcript page.
 *
 * Shows lines waiting to be sent (Delay 10s mode) below the transcript, with a countdown and
 * Send now / Reject / Edit / Speaking-in-tongues buttons, the Auto/Delay mode switch, and the
 * Rejected lines popup. All state lives on the server; this page renders what the server sends
 * over the transcript SSE stream ({ type: 'queue', ... }).
 */
(function () {
  const EDIT_RENEW_MS = 5000;     // keep our edit lease alive while the editor is open
  const MOVED_CLICK_GUARD_MS = 400; // ignore clicks on a line that just moved under the cursor
  const LONG_EDIT_WARN_MS = 30000;
  const TONGUES_TEXT = '(speaking in tongues)';

  const queueContainer = document.getElementById('queueContainer');
  const modeAutoBtn = document.getElementById('modeAutoBtn');
  const modeVetoBtn = document.getElementById('modeVetoBtn');
  const waitingCounter = document.getElementById('waitingCounter');
  const reviewHint = document.getElementById('reviewHint');
  const rejectedBtn = document.getElementById('rejectedBtn');
  const rejectedModal = document.getElementById('rejectedModal');
  const rejectedList = document.getElementById('rejectedList');
  const rejectedClearBtn = document.getElementById('rejectedClearBtn');
  const rejectedCloseBtn = document.getElementById('rejectedCloseBtn');

  let state = { mode: 'auto', delayMs: 10000, items: [], rejectedCount: 0 };
  let clockOffset = 0;          // serverNow - Date.now()
  let localEdit = null;         // { id, renewTimer } - the line this page is editing
  const elements = new Map();   // id -> element

  const serverNow = () => Date.now() + clockOffset;

  // ---------- server calls ----------

  async function post(url, body) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {})
      });
      const data = await res.json();
      if (!data.success) console.warn(url, data.error);
      return data;
    } catch (err) {
      alert('Could not reach the server: ' + err.message);
      return { success: false, error: err.message };
    }
  }

  function sendNow(id) {
    return post('/api/queue/send-now', { id });
  }

  function reject(id) {
    if (localEdit && localEdit.id === id) endLocalEdit();
    return post('/api/queue/reject', { id });
  }

  async function startEdit(id) {
    if (localEdit) {
      const el = elements.get(localEdit.id);
      if (el) el.querySelector('.queue-edit-input').focus();
      return;
    }
    const result = await post('/api/queue/edit', { id, action: 'start' });
    if (!result.success) {
      if (result.error) alert(result.error);
      return;
    }
    localEdit = {
      id,
      renewTimer: setInterval(() => post('/api/queue/edit', { id, action: 'renew' }), EDIT_RENEW_MS)
    };
    const item = state.items.find(i => i.id === id);
    const el = elements.get(id);
    if (el) showEditor(el, item ? item.text : el.querySelector('.queue-text').textContent);
  }

  async function saveEdit(id, text) {
    text = (text || '').trim();
    if (!text) {
      alert('The line is empty. Use Reject to remove it.');
      return;
    }
    endLocalEdit();
    await post('/api/queue/edit', { id, action: 'save', text });
  }

  async function cancelEdit(id) {
    endLocalEdit();
    await post('/api/queue/edit', { id, action: 'cancel' });
  }

  function replaceWithTongues(id) {
    if (localEdit && localEdit.id === id) endLocalEdit();
    return post('/api/queue/edit', { id, action: 'save', text: TONGUES_TEXT });
  }

  function endLocalEdit() {
    if (!localEdit) return;
    clearInterval(localEdit.renewTimer);
    const el = elements.get(localEdit.id);
    localEdit = null;
    if (el) hideEditor(el);
  }

  // ---------- rendering ----------

  // Lines shift when the one above is sent or the page auto-scrolls. A click that lands on a
  // line which moved in the last moment was probably aimed at a different line: ignore it.
  function guarded(el, action) {
    return () => {
      if (Date.now() - (el._movedAt || 0) < MOVED_CLICK_GUARD_MS) {
        el.classList.add('nudge');
        setTimeout(() => el.classList.remove('nudge'), 500);
        return;
      }
      action();
    };
  }

  function trackMovement() {
    const now = Date.now();
    elements.forEach(el => {
      const top = el.getBoundingClientRect().top;
      if (el._lastTop !== undefined && Math.abs(top - el._lastTop) > 2) el._movedAt = now;
      el._lastTop = top;
    });
    requestAnimationFrame(trackMovement);
  }
  requestAnimationFrame(trackMovement);

  function createItem(id) {
    const el = document.createElement('div');
    el.className = 'queue-item';
    el.dataset.id = id;
    el.innerHTML =
      '<div class="queue-meta"><span class="queue-time"></span><span class="queue-status"></span></div>' +
      '<div class="queue-text"></div>' +
      '<textarea class="queue-edit-input" rows="2" style="display: none;"></textarea>' +
      '<div class="queue-bar"><div class="queue-bar-fill"></div></div>' +
      '<div class="queue-actions queue-actions-normal">' +
        '<button class="send" title="Send now (Enter)">✓ Send now</button>' +
        '<button class="reject" title="Reject: never sent (Delete)">✗ Reject</button>' +
        '<button class="edit" title="Edit before sending (E)">✏️ Edit</button>' +
        '<button class="tongues" title="Replace with (speaking in tongues)">🗣️</button>' +
      '</div>' +
      '<div class="queue-actions queue-actions-edit" style="display: none;">' +
        '<button class="send save" title="Save and send (Enter)">💾 Save &amp; send</button>' +
        '<button class="cancel" title="Cancel (Esc)">Cancel</button>' +
        '<button class="reject" title="Reject: never sent">✗ Reject</button>' +
      '</div>';

    el.querySelector('.queue-time').textContent = new Date(id).toLocaleTimeString();

    const normal = el.querySelector('.queue-actions-normal');
    normal.querySelector('.send').addEventListener('click', guarded(el, () => sendNow(id)));
    normal.querySelector('.reject').addEventListener('click', guarded(el, () => reject(id)));
    normal.querySelector('.edit').addEventListener('click', guarded(el, () => startEdit(id)));
    normal.querySelector('.tongues').addEventListener('click', guarded(el, () => replaceWithTongues(id)));

    const input = el.querySelector('.queue-edit-input');
    const editActions = el.querySelector('.queue-actions-edit');
    editActions.querySelector('.save').addEventListener('click', () => saveEdit(id, input.value));
    editActions.querySelector('.cancel').addEventListener('click', () => cancelEdit(id));
    editActions.querySelector('.reject').addEventListener('click', () => reject(id));
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        saveEdit(id, input.value);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancelEdit(id);
      }
    });

    return el;
  }

  function showEditor(el, text) {
    const input = el.querySelector('.queue-edit-input');
    input.value = text;
    input.style.display = '';
    el.querySelector('.queue-text').style.display = 'none';
    el.querySelector('.queue-actions-normal').style.display = 'none';
    el.querySelector('.queue-actions-edit').style.display = '';
    el.classList.add('editing');
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }

  function hideEditor(el) {
    el.querySelector('.queue-edit-input').style.display = 'none';
    el.querySelector('.queue-text').style.display = '';
    el.querySelector('.queue-actions-normal').style.display = '';
    el.querySelector('.queue-actions-edit').style.display = 'none';
  }

  function renderItems() {
    const ids = new Set(state.items.map(i => i.id));
    let added = false;

    // Our edit's line is gone (sent after the edit lease expired, or rejected elsewhere)
    if (localEdit && !ids.has(localEdit.id)) {
      clearInterval(localEdit.renewTimer);
      localEdit = null;
    }

    elements.forEach((el, id) => {
      if (!ids.has(id)) {
        el.remove();
        elements.delete(id);
      }
    });

    state.items.forEach((item, index) => {
      let el = elements.get(item.id);
      if (!el) {
        el = createItem(item.id);
        elements.set(item.id, el);
        added = true;
      }
      const editingHere = localEdit && localEdit.id === item.id;
      if (!editingHere) el.querySelector('.queue-text').textContent = item.text;
      el.classList.toggle('editing', item.editing);

      const blockedAbove = state.items.slice(0, index).some(i => i.editing);
      const normal = el.querySelector('.queue-actions-normal');
      normal.querySelector('.send').disabled = item.editing || blockedAbove;
      normal.querySelector('.edit').disabled = item.editing && !editingHere;
      normal.querySelector('.tongues').disabled = item.editing && !editingHere;

      // Keep DOM order == queue order, moving an element only if it's out of place
      // (re-inserting the line being edited would take the cursor out of the edit box)
      if (queueContainer.children[index] !== el) {
        queueContainer.insertBefore(el, queueContainer.children[index] || null);
      }
    });

    updateCountdowns();
    if (added && typeof smartScroll === 'function') smartScroll();
  }

  function updateCountdowns() {
    const now = serverNow();
    let longEdit = false;

    state.items.forEach((item, index) => {
      const el = elements.get(item.id);
      if (!el) return;
      const status = el.querySelector('.queue-status');
      const bar = el.querySelector('.queue-bar');
      const fill = el.querySelector('.queue-bar-fill');
      const blockedAbove = state.items.slice(0, index).some(i => i.editing);
      let text;
      let warn = false;

      if (item.editing) {
        const behind = state.items.length - index - 1;
        const editingFor = now - item.editingSince;
        const who = localEdit && localEdit.id === item.id ? 'Editing' : 'Being edited';
        text = '✏️ ' + who + (behind > 0 ? ' — ' + behind + ' line' + (behind === 1 ? '' : 's') + ' waiting behind this' : '');
        if (editingFor > LONG_EDIT_WARN_MS) {
          warn = true;
          longEdit = true;
          text += behind > 0 ? ' · phones paused ' + Math.floor(editingFor / 1000) + 's' : ' · ' + Math.floor(editingFor / 1000) + 's';
        }
        bar.style.visibility = 'hidden';
      } else {
        const remaining = item.dueAt - now;
        if (item.sendNow || remaining <= 0) {
          text = blockedAbove ? '⏳ Ready — waiting for the line being edited above' : 'Sending…';
          fill.style.width = '0%';
        } else {
          text = 'Sending in ' + Math.ceil(remaining / 1000) + 's' + (blockedAbove ? ' (after the line being edited above)' : '');
          fill.style.width = Math.max(0, Math.min(100, (remaining / state.delayMs) * 100)) + '%';
        }
        bar.style.visibility = '';
      }

      status.textContent = text;
      status.classList.toggle('warn', warn);
      el.classList.toggle('blocked', blockedAbove && !item.editing);
    });

    const count = state.items.length;
    waitingCounter.textContent = count > 0 ? '⏳ ' + count + ' waiting' : '';
    waitingCounter.classList.toggle('alert', longEdit);
  }

  function renderMode() {
    const veto = state.mode === 'veto';
    modeAutoBtn.classList.toggle('active', !veto);
    modeVetoBtn.classList.toggle('active', veto);
    modeVetoBtn.classList.toggle('veto', veto);
    modeVetoBtn.textContent = '⏳ Delay ' + Math.round(state.delayMs / 1000) + 's';
    reviewHint.style.display = veto || state.items.length > 0 ? '' : 'none';
    rejectedBtn.textContent = '🚫 Rejected (' + (state.rejectedCount || 0) + ')';
  }

  window.renderQueueState = function (newState) {
    state = newState;
    clockOffset = newState.serverNow - Date.now();
    renderMode();
    renderItems();
  };

  setInterval(updateCountdowns, 200);

  // ---------- mode switch ----------

  modeAutoBtn.addEventListener('click', () => {
    if (state.mode !== 'auto') post('/api/caption-mode', { mode: 'auto' });
  });
  modeVetoBtn.addEventListener('click', () => {
    if (state.mode !== 'veto') post('/api/caption-mode', { mode: 'veto' });
  });

  // ---------- keyboard: act on the oldest waiting line ----------

  document.addEventListener('keydown', e => {
    if (rejectedModal.style.display !== 'none') {
      if (e.key === 'Escape') closeRejected();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const target = e.target;
    if (target.closest && target.closest('input, textarea, select, [contenteditable="true"]')) return;
    const oldest = state.items[0];
    if (!oldest) return;

    // (Mac laptops label Backspace as "delete")
    if (e.key === 'Enter') {
      e.preventDefault();
      if (!oldest.editing) sendNow(oldest.id);
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      reject(oldest.id);
    } else if (e.key === 'e' || e.key === 'E') {
      e.preventDefault();
      startEdit(oldest.id);
    } else {
      return;
    }
    if (target.blur && target.tagName === 'BUTTON') target.blur();
  });

  // ---------- Rejected lines popup ----------

  async function loadRejected() {
    rejectedList.textContent = 'Loading…';
    try {
      const data = await (await fetch('/api/rejected')).json();
      renderRejected(data.lines || []);
    } catch (err) {
      rejectedList.textContent = 'Could not load rejected lines: ' + err.message;
    }
  }

  function renderRejected(lines) {
    rejectedList.innerHTML = '';
    if (lines.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'rejected-empty';
      empty.textContent = 'No rejected lines.';
      rejectedList.appendChild(empty);
      return;
    }
    lines.forEach(line => {
      const row = document.createElement('div');
      row.className = 'rejected-item';

      const time = document.createElement('span');
      time.className = 'rejected-time';
      time.textContent = new Date(line.timestamp).toLocaleTimeString();

      const text = document.createElement('span');
      text.className = 'rejected-text';
      text.textContent = line.text;

      const copy = document.createElement('button');
      copy.textContent = '📋 Copy';
      copy.addEventListener('click', () => copyText(line.text, copy));

      row.append(time, text, copy);
      rejectedList.appendChild(row);
    });
  }

  function copyText(text, button) {
    const done = () => {
      button.textContent = '✓ Copied';
      setTimeout(() => { button.textContent = '📋 Copy'; }, 1500);
    };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
    } else {
      fallbackCopy(text, done);
    }
  }

  function fallbackCopy(text, done) {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    try { document.execCommand('copy'); done(); } catch (e) { alert(text); }
    area.remove();
  }

  function openRejected() {
    rejectedModal.style.display = '';
    loadRejected();
  }

  function closeRejected() {
    rejectedModal.style.display = 'none';
  }

  rejectedBtn.addEventListener('click', openRejected);
  rejectedCloseBtn.addEventListener('click', closeRejected);
  rejectedModal.addEventListener('click', e => {
    if (e.target === rejectedModal) closeRejected();
  });
  rejectedClearBtn.addEventListener('click', async () => {
    if (!confirm('Clear the rejected lines list? This only empties this list — nothing live is affected.')) return;
    const result = await post('/api/rejected/clear');
    if (result.success) renderRejected([]);
  });

  // Initial state (the SSE stream also sends it on connect)
  fetch('/api/queue')
    .then(res => res.json())
    .then(window.renderQueueState)
    .catch(err => console.error('Could not load review queue:', err));
})();
