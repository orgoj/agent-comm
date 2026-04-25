// =============================================================================
// agent-comm — Channel card rendering
// =============================================================================

(function () {
  'use strict';

  var AC = (window.AC = window.AC || {});

  function buildChannelCard(ch) {
    var msgCount = (AC.state.messages || []).filter(function (m) {
      return m.channel_id === ch.id;
    }).length;
    return (
      '<div class="card-title">#' +
      AC.esc(ch.name) +
      '</div>' +
      (ch.description ? '<div class="card-meta">' + AC.esc(ch.description) + '</div>' : '') +
      '<div class="card-meta">Created: ' +
      AC.timeAgo(ch.created_at) +
      '</div>' +
      '<div class="card-meta">' +
      msgCount +
      ' messages</div>' +
      (ch.archived_at ? '<div class="card-meta" style="color:var(--yellow)">Archived</div>' : '') +
      '<div class="card-actions">' +
      '<button class="compose-btn channel-compose-btn" data-channel-name="' +
      AC.escAttr(ch.name) +
      '" title="Send message to #' +
      AC.escAttr(ch.name) +
      '"><span class="material-symbols-outlined" style="font-size:16px;vertical-align:-2px">edit</span> Message</button>' +
      '<span class="card-action">View messages &rarr;</span>' +
      '</div>'
    );
  }

  function renderChannels() {
    var channels = AC.state.channels || [];
    var container = AC._root.getElementById('channels-list');

    if (channels.length === 0) {
      AC.morph(
        container,
        '<div class="empty-state"><span class="material-symbols-outlined empty-state-icon">forum</span>No channels created<div class="empty-state-hint">Use comm_channel({ action: "create" }) to add a channel</div></div>',
      );
      return;
    }

    AC.morph(
      container,
      channels
        .map(function (ch) {
          return (
            '<div class="card" data-channel-id="' +
            AC.escAttr(ch.id) +
            '">' +
            buildChannelCard(ch) +
            '</div>'
          );
        })
        .join(''),
    );
  }

  AC.renderChannels = renderChannels;

  // ── Create channel modal ─────────────────────────────────────────────────
  AC.initChannelCreate = function () {
    var modal = AC._root.getElementById('create-channel-modal');
    var btn = AC._root.getElementById('create-channel-btn');
    var nameInput = AC._root.getElementById('channel-name');
    var descInput = AC._root.getElementById('channel-desc');
    var submitBtn = AC._root.getElementById('create-channel-submit');
    var cancelBtn = AC._root.getElementById('create-channel-cancel');

    function open() {
      nameInput.value = '';
      descInput.value = '';
      modal.classList.remove('hidden');
      nameInput.focus();
    }
    function close() {
      modal.classList.add('hidden');
    }

    btn.addEventListener('click', open);
    cancelBtn.addEventListener('click', close);
    modal.addEventListener('click', function (e) {
      if (e.target === modal) close();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !modal.classList.contains('hidden')) close();
    });
    nameInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') submitBtn.click();
    });
    descInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') submitBtn.click();
    });

    submitBtn.addEventListener('click', function () {
      var name = nameInput.value.trim().toLowerCase().replace(/\s+/g, '-');
      var desc = descInput.value.trim();
      if (!name) {
        AC.showToast('Error', 'Channel name is required');
        return;
      }
      var humanAgent = AC._getHumanAgent();
      var createdBy = humanAgent ? humanAgent.id : 'human';

      AC._fetch('/api/channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name, description: desc, created_by: createdBy }),
      })
        .then(function (r) {
          if (!r.ok)
            return r.json().then(function (d) {
              throw new Error(d.error || 'Failed');
            });
          return r.json();
        })
        .then(function () {
          close();
          AC.showToast('Created', 'Channel #' + name + ' created');
          if (AC._ws && AC._ws.readyState === WebSocket.OPEN)
            AC._ws.send(JSON.stringify({ type: 'refresh' }));
        })
        .catch(function (err) {
          AC.showToast('Error', err.message || 'Failed to create channel');
        });
    });
  };
})();
