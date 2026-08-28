/* =========================================================================
   Threshold — Do / Take / Give
   Single-file app logic: state, router, renderers, device integrations.
   Everything persists to localStorage. No network calls, no accounts.
   ========================================================================= */

(() => {
  'use strict';

  const STORE_KEY = 'threshold:v1';

  const ICONS = {
    home: 'M4 11 12 4l8 7M6 10v9h4v-5h4v5h4v-9',
    office: 'M6 21V6l6-3 6 3v15M9 21v-4h6v4M9 11h.01M9 8h.01M15 11h.01M15 8h.01',
    gym: 'M4 12h2M18 12h2M6 9v6M18 9v6M8 12h8M6 12v0',
    school: 'M12 4 2 9l10 5 10-5-10-5ZM2 9v6M6 12.5V17c0 1.5 3 3 6 3s6-1.5 6-3v-4.5',
    other: 'M12 21.5s7-6.4 7-12A7 7 0 0 0 5 9.5c0 5.6 7 12 7 12Z',
  };
  const ICON_LABELS = { home: 'Home', office: 'Office', gym: 'Gym', school: 'School', other: 'Place' };

  const CHECK_SVG = '<svg viewBox="0 0 24 24" fill="none"><path d="M4 12.5l5 5L20 6" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const PLUS_SVG = '<svg viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

  /* ---------------- State ---------------- */

  function defaultState() {
    return {
      places: [
        { id: uid(), name: 'Home', icon: 'home', lat: null, lng: null, isCurrent: true },
      ],
      items: [],
      vault: [],
      leavingPlaceId: null,
      settings: {
        name: '',
        permLocation: false,
        permReminders: false,
        permHaptics: true,
        pingTime: '08:15',
        lastActiveDate: todayStr(),
        lastPingFiredDate: null,
      },
    };
  }

  let state = load();

  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return defaultState();
      const parsed = JSON.parse(raw);
      // shallow-merge to survive future field additions
      const base = defaultState();
      return {
        ...base,
        ...parsed,
        settings: { ...base.settings, ...(parsed.settings || {}) },
      };
    } catch (e) {
      console.warn('Threshold: failed to load state, starting fresh.', e);
      return defaultState();
    }
  }

  function save() {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function todayStr(d = new Date()) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function currentPlace() {
    return state.places.find((p) => p.isCurrent) || state.places[0] || null;
  }

  function placeById(id) {
    return state.places.find((p) => p.id === id) || null;
  }

  /* ---------------- Daily reset ---------------- */

  function ensureDailyReset() {
    const today = todayStr();
    if (state.settings.lastActiveDate === today) return;
    // Clean-slate: drop one-off items entirely; reset recurring ones unticked.
    state.items = state.items
      .filter((i) => i.recurring)
      .map((i) => ({ ...i, done: false }));
    state.leavingPlaceId = null;
    state.settings.lastActiveDate = today;
    state.settings.lastPingFiredDate = null;
    save();
  }

  /* ---------------- Items ---------------- */

  function addItem({ type, title, time, placeId, recurring }) {
    if (!title || !title.trim()) return;
    state.items.push({
      id: uid(),
      type,
      title: title.trim(),
      time: time || null,
      placeId: placeId || null,
      recurring: !!recurring,
      done: false,
    });
    save();
  }

  function updateItem(id, patch) {
    const it = state.items.find((i) => i.id === id);
    if (!it) return;
    Object.assign(it, patch);
    save();
  }

  function completeItem(id) {
    const idx = state.items.findIndex((i) => i.id === id);
    if (idx === -1) return;
    const it = state.items[idx];
    state.vault.unshift({
      id: uid(),
      type: it.type,
      title: it.title,
      place: it.placeId ? (placeById(it.placeId)?.name || null) : null,
      timestamp: Date.now(),
    });
    if (it.recurring) {
      it.done = true;
    } else {
      state.items.splice(idx, 1);
    }
    save();
    doHaptic();
  }

  function deleteItem(id) {
    state.items = state.items.filter((i) => i.id !== id);
    save();
  }

  /* ---------------- Places ---------------- */

  function addPlace({ name, icon, lat, lng }) {
    if (!name || !name.trim()) return null;
    const p = { id: uid(), name: name.trim(), icon: icon || 'other', lat: lat ?? null, lng: lng ?? null, isCurrent: state.places.length === 0 };
    state.places.push(p);
    save();
    return p;
  }

  function updatePlace(id, patch) {
    const p = placeById(id);
    if (!p) return;
    Object.assign(p, patch);
    save();
  }

  function deletePlace(id) {
    const wasCurrent = placeById(id)?.isCurrent;
    state.places = state.places.filter((p) => p.id !== id);
    state.items.forEach((i) => { if (i.placeId === id) i.placeId = null; });
    if (state.leavingPlaceId === id) state.leavingPlaceId = null;
    if (wasCurrent && state.places[0]) state.places[0].isCurrent = true;
    save();
  }

  function setCurrentPlace(id) {
    state.places.forEach((p) => { p.isCurrent = p.id === id; });
    if (state.leavingPlaceId && state.leavingPlaceId !== id) state.leavingPlaceId = null;
    save();
  }

  /* ---------------- Leaving mode ---------------- */

  function toggleLeaving() {
    const cp = currentPlace();
    if (!cp) return;
    state.leavingPlaceId = state.leavingPlaceId === cp.id ? null : cp.id;
    save();
    applyLeavingClass();
    render();
  }

  function applyLeavingClass() {
    document.body.classList.toggle('leaving-mode', !!state.leavingPlaceId);
  }

  /* ---------------- Device integrations ---------------- */

  function doHaptic() {
    if (state.settings.permHaptics && 'vibrate' in navigator) {
      try { navigator.vibrate(35); } catch (e) { /* ignore */ }
    }
  }

  async function requestLocationPermission(turnOn) {
    if (!turnOn) {
      state.settings.permLocation = false;
      save();
      stopGeoWatch();
      renderSettingsIfActive();
      return;
    }
    if (!('geolocation' in navigator)) {
      toast('Location isn\u2019t available on this device.');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      () => {
        state.settings.permLocation = true;
        save();
        startGeoWatch();
        renderSettingsIfActive();
        toast('Location detection turned on.');
      },
      () => {
        toast('Location permission was denied.');
        state.settings.permLocation = false;
        save();
        renderSettingsIfActive();
      },
      { enableHighAccuracy: false, timeout: 8000 }
    );
  }

  async function requestReminderPermission(turnOn) {
    if (!turnOn) {
      state.settings.permReminders = false;
      save();
      renderSettingsIfActive();
      return;
    }
    if (!('Notification' in window)) {
      // Still allow in-app reminders even without system notifications.
      state.settings.permReminders = true;
      save();
      renderSettingsIfActive();
      return;
    }
    try {
      const perm = await Notification.requestPermission();
      state.settings.permReminders = true; // in-app ping always works regardless
      if (perm !== 'granted') {
        toast('Reminders will show while Threshold is open.');
      } else {
        toast('Reminders turned on.');
      }
    } catch (e) {
      state.settings.permReminders = true;
    }
    save();
    renderSettingsIfActive();
  }

  function setHaptics(turnOn) {
    state.settings.permHaptics = turnOn;
    save();
    if (turnOn) doHaptic();
    renderSettingsIfActive();
  }

  function renderSettingsIfActive() {
    if (currentRoute() === '/settings') render();
  }

  // ---- Geolocation proximity watch ----
  let geoWatchId = null;
  let proximitySuggestion = null; // {placeId}

  function haversineMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  function startGeoWatch() {
    if (!state.settings.permLocation || !('geolocation' in navigator) || geoWatchId !== null) return;
    geoWatchId = navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords;
        const cp = currentPlace();
        let nearest = null;
        let nearestDist = Infinity;
        state.places.forEach((p) => {
          if (p.lat == null || p.lng == null) return;
          const d = haversineMeters(latitude, longitude, p.lat, p.lng);
          if (d < nearestDist) { nearestDist = d; nearest = p; }
        });
        const prevSuggestion = proximitySuggestion;
        if (nearest && nearestDist < 150 && (!cp || nearest.id !== cp.id)) {
          proximitySuggestion = { placeId: nearest.id, meters: Math.round(nearestDist) };
        } else {
          proximitySuggestion = null;
        }
        const changed = JSON.stringify(prevSuggestion) !== JSON.stringify(proximitySuggestion);
        if (changed && currentRoute() === '/') render();
      },
      () => { /* silent fail */ },
      { enableHighAccuracy: false, maximumAge: 30000, timeout: 15000 }
    );
  }

  function stopGeoWatch() {
    if (geoWatchId !== null && 'geolocation' in navigator) {
      navigator.geolocation.clearWatch(geoWatchId);
      geoWatchId = null;
    }
    proximitySuggestion = null;
  }

  // ---- Morning leaving ping ----
  function checkMorningPing() {
    if (!state.settings.permReminders) return;
    const now = new Date();
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    if (hhmm !== state.settings.pingTime) return;
    if (state.settings.lastPingFiredDate === todayStr()) return;
    state.settings.lastPingFiredDate = todayStr();
    save();
    firePing();
  }

  function firePing() {
    const body = 'Check what you need to take before you leave.';
    if ('Notification' in window && Notification.permission === 'granted' && navigator.serviceWorker?.controller) {
      navigator.serviceWorker.controller.postMessage({ type: 'PING_NOTIFY', title: 'Threshold', body });
    } else {
      toast('Morning check — anything to grab before you go?');
    }
  }

  /* ---------------- Toasts ---------------- */

  function toast(msg) {
    const root = document.getElementById('toast-root');
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    root.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateY(-6px)'; }, 2200);
    setTimeout(() => el.remove(), 2500);
  }

  /* ---------------- Formatting helpers ---------------- */

  function formatClock(d) {
    let h = d.getHours();
    const m = String(d.getMinutes()).padStart(2, '0');
    const ap = h >= 12 ? 'PM' : 'AM';
    h = h % 12; if (h === 0) h = 12;
    return `${h}:${m} ${ap}`;
  }

  function formatTime12(hhmm) {
    if (!hhmm) return '';
    const [h, m] = hhmm.split(':').map(Number);
    const d = new Date(); d.setHours(h, m, 0, 0);
    return formatClock(d);
  }

  function greeting(d) {
    const h = d.getHours();
    if (h < 5) return 'Still up';
    if (h < 12) return 'Good morning';
    if (h < 17) return 'Good afternoon';
    if (h < 21) return 'Good evening';
    return 'Winding down';
  }

  function dateHeading(d) {
    return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }).toUpperCase();
  }

  function iconSvg(name, cls) {
    const d = ICONS[name] || ICONS.other;
    return `<svg class="${cls || ''}" viewBox="0 0 24 24" fill="none"><path d="${d}" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  }

  function vaultDayLabel(ts) {
    const d = new Date(ts);
    const today = todayStr();
    const y = new Date(); y.setDate(y.getDate() - 1);
    if (todayStr(d) === today) return 'Today';
    if (todayStr(d) === todayStr(y)) return 'Yesterday';
    return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  }

  /* ---------------- Router ---------------- */

  function currentRoute() {
    const h = location.hash.replace(/^#/, '');
    return h || '/';
  }

  function navigate(route) {
    location.hash = route === '/' ? '/' : route;
  }

  window.addEventListener('hashchange', render);

  document.addEventListener('click', (e) => {
    const a = e.target.closest('[data-nav]');
    if (a) {
      // let default hash navigation happen; just close any open sheet
      closeSheet();
    }
  });

  /* ---------------- Sheets (bottom modal) ---------------- */

  function openSheet(html, onMount) {
    closeSheet();
    const root = document.getElementById('sheet-root');
    const overlay = document.createElement('div');
    overlay.className = 'sheet-overlay';
    overlay.innerHTML = `<div class="sheet" role="dialog" aria-modal="true">${html}</div>`;
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeSheet(); });
    root.appendChild(overlay);
    document.addEventListener('keydown', escCloseHandler);
    if (onMount) onMount(overlay);
  }

  function escCloseHandler(e) {
    if (e.key === 'Escape') closeSheet();
  }

  function closeSheet() {
    const root = document.getElementById('sheet-root');
    root.innerHTML = '';
    document.removeEventListener('keydown', escCloseHandler);
  }

  /* ---------------- Render: shell ---------------- */

  function updateNavActive() {
    const route = currentRoute();
    document.querySelectorAll('.tabs a[data-route]').forEach((a) => {
      a.classList.toggle('active', a.dataset.route === route);
    });
  }

  function render() {
    ensureDailyReset();
    applyLeavingClass();
    updateNavActive();
    const route = currentRoute();
    const app = document.getElementById('app');
    const fab = document.getElementById('fab');

    if (route === '/') { renderToday(app); fab.hidden = true; }
    else if (route === '/history') { renderVault(app); fab.hidden = true; }
    else if (route === '/places') { renderPlaces(app); fab.hidden = false; }
    else if (route === '/settings') { renderSettings(app); fab.hidden = true; }
    else { renderToday(app); fab.hidden = true; }
  }

  /* ---------------- Render: Today ---------------- */

  function renderToday(app) {
    const now = new Date();
    const cp = currentPlace();
    const leaving = !!state.leavingPlaceId;
    const leavingPlace = leaving ? placeById(state.leavingPlaceId) : null;

    const openItems = state.items.filter((i) => !i.done);
    const doItems = openItems.filter((i) => i.type === 'do');
    const takeItems = openItems.filter((i) => i.type === 'take' && (!leaving || i.placeId === state.leavingPlaceId));
    const giveItems = openItems.filter((i) => i.type === 'give' && (!leaving || i.placeId === state.leavingPlaceId));

    const pendingForCurrent = cp
      ? openItems.filter((i) => (i.type === 'take' || i.type === 'give') && i.placeId === cp.id).length
      : 0;

    let locNote;
    if (leaving) {
      const n = takeItems.length + giveItems.length;
      locNote = n === 0 ? 'Clear to go \u2014 nothing left at this door.' : `${n} item${n === 1 ? '' : 's'} left before you go.`;
    } else {
      locNote = pendingForCurrent === 0 ? 'Nothing waiting at this door.' : `${pendingForCurrent} item${pendingForCurrent === 1 ? '' : 's'} waiting for when you leave.`;
    }

    let proximityHtml = '';
    if (!leaving && proximitySuggestion) {
      const p = placeById(proximitySuggestion.placeId);
      if (p) {
        proximityHtml = `
          <div class="proximity-banner">
            <span>You seem to be near <strong style="color:var(--ink)">${esc(p.name)}</strong> (~${proximitySuggestion.meters}m).</span>
            <button class="btn btn-ghost btn-sm" data-action="set-current" data-id="${p.id}">Set as current</button>
          </div>`;
      }
    }

    app.innerHTML = `
      <div class="today-head">
        <div>
          <div class="today-date">${esc(dateHeading(now))}</div>
          <div class="today-greet">${state.settings.name ? `${greeting(now)}, ${esc(state.settings.name)}` : greeting(now)}</div>
        </div>
        <div class="today-clock">${formatClock(now)}</div>
      </div>

      ${proximityHtml}

      <div class="loc-card">
        <div class="loc-left">
          <div class="loc-icon">${iconSvg(cp ? cp.icon : 'other')}</div>
          <div>
            <div class="loc-label">${leaving ? 'Leaving' : 'Now'}</div>
            <div class="loc-name">${leaving ? `Leaving ${esc(leavingPlace?.name || '')}` : `At ${esc(cp ? cp.name : 'nowhere set')}`}</div>
          </div>
        </div>
        ${cp ? `<button class="btn ${leaving ? 'btn-ghost' : 'btn-light'}" data-action="toggle-leaving">${leaving ? 'Arrived / Cancel' : `Leaving ${esc(cp.name)}`}</button>` : `<a href="#/places" data-nav class="btn btn-light">Add a place</a>`}
        <div class="loc-note">${esc(locNote)}</div>
      </div>

      <div class="columns">
        <section class="col ${leaving ? 'col-hidden' : ''}" data-col="do">
          <div class="col-head"><span class="col-title">Do</span><span class="col-count">${doItems.length} open</span></div>
          <div class="col-list">${doItems.length ? doItems.map(itemRow).join('') : '<p class="col-empty">Nothing here.</p>'}</div>
          <button class="add-link col-add" data-action="add" data-type="do">${PLUS_SVG} Add do</button>
        </section>
        <section class="col" data-col="take">
          <div class="col-head"><span class="col-title">Take</span><span class="col-count">${takeItems.length} open</span></div>
          <div class="col-list">${takeItems.length ? takeItems.map(itemRow).join('') : '<p class="col-empty">Nothing here.</p>'}</div>
          <button class="add-link col-add" data-action="add" data-type="take">${PLUS_SVG} Add take</button>
        </section>
        <section class="col" data-col="give">
          <div class="col-head"><span class="col-title">Give</span><span class="col-count">${giveItems.length} open</span></div>
          <div class="col-list">${giveItems.length ? giveItems.map(itemRow).join('') : '<p class="col-empty">Nothing here.</p>'}</div>
          <button class="add-link col-add" data-action="add" data-type="give">${PLUS_SVG} Add give</button>
        </section>
      </div>
    `;

    wireToday(app);
  }

  function itemRow(it) {
    const place = it.placeId ? placeById(it.placeId) : null;
    const bits = [];
    if (it.time) bits.push(`<span>${esc(formatTime12(it.time))}</span>`);
    if (place) bits.push(`<span class="item-tag">${esc(place.name)}</span>`);
    if (it.recurring) bits.push(`<span class="item-tag">Routine</span>`);
    return `
      <div class="item" data-id="${it.id}">
        <button class="item-check" data-action="complete" data-id="${it.id}" aria-label="Mark done">${CHECK_SVG}</button>
        <div class="item-body">
          <p class="item-title">${esc(it.title)}</p>
          <p class="item-meta">${bits.join('')}</p>
        </div>
        <button class="item-menu" data-action="item-menu" data-id="${it.id}">\u22EF</button>
      </div>`;
  }

  function wireToday(app) {
    app.querySelectorAll('[data-action="add"]').forEach((btn) => {
      btn.addEventListener('click', () => openAddItemSheet(btn.dataset.type));
    });
    app.querySelectorAll('[data-action="complete"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const row = btn.closest('.item');
        row.classList.add('completing');
        setTimeout(() => completeItem(btn.dataset.id) || render(), 180);
      });
    });
    app.querySelectorAll('[data-action="item-menu"]').forEach((btn) => {
      btn.addEventListener('click', () => openItemMenu(btn.dataset.id));
    });
    const leaveBtn = app.querySelector('[data-action="toggle-leaving"]');
    if (leaveBtn) leaveBtn.addEventListener('click', toggleLeaving);
    const setCurBtn = app.querySelector('[data-action="set-current"]');
    if (setCurBtn) setCurBtn.addEventListener('click', () => { setCurrentPlace(setCurBtn.dataset.id); proximitySuggestion = null; render(); toast('Current place updated.'); });
  }

  function openItemMenu(id) {
    const it = state.items.find((i) => i.id === id);
    if (!it) return;
    openSheet(`
      <h3 class="sheet-title">${esc(it.title)}</h3>
      <div class="stack">
        <button class="btn btn-ghost btn-block" data-x="edit">Edit</button>
        <button class="btn btn-danger btn-block" data-x="delete">Delete</button>
      </div>
    `, (root) => {
      root.querySelector('[data-x="edit"]').addEventListener('click', () => { closeSheet(); openAddItemSheet(it.type, it); });
      root.querySelector('[data-x="delete"]').addEventListener('click', () => { deleteItem(id); closeSheet(); render(); toast('Deleted.'); });
    });
  }

  function openAddItemSheet(type, editing) {
    const label = { do: 'do', take: 'take', give: 'give' }[type];
    const placeOptions = state.places.map((p) => `<option value="${p.id}" ${editing?.placeId === p.id ? 'selected' : (!editing && p.isCurrent ? 'selected' : '')}>${esc(p.name)}</option>`).join('');
    const needsPlace = type !== 'do';
    openSheet(`
      <h3 class="sheet-title">${editing ? 'Edit' : 'Add a'} ${label}</h3>
      <div class="sheet-row">
        <div class="field-label">What is it</div>
        <input class="text-input" id="f-title" placeholder="${type === 'do' ? 'e.g. Call the mechanic' : type === 'take' ? 'e.g. Laptop charger' : 'e.g. Return Sarah\u2019s book'}" value="${editing ? esc(editing.title) : ''}" />
      </div>
      <div class="sheet-row">
        <div class="field-label">Time (optional)</div>
        <input class="time-input" id="f-time" type="time" value="${editing?.time || ''}" />
      </div>
      ${needsPlace ? `
      <div class="sheet-row">
        <div class="field-label">${type === 'take' ? 'Take from' : 'Give at'}</div>
        <select class="select-input" id="f-place">${placeOptions}</select>
      </div>` : ''}
      <div class="sheet-row check-row">
        <input type="checkbox" id="f-recurring" ${editing?.recurring ? 'checked' : ''} />
        <label for="f-recurring">Recurring routine (resets each day instead of clearing)</label>
      </div>
      <div class="sheet-actions">
        <button class="btn btn-ghost" data-x="cancel">Cancel</button>
        <button class="btn btn-light" data-x="save">${editing ? 'Save' : 'Add'}</button>
      </div>
    `, (root) => {
      root.querySelector('#f-title').focus();
      root.querySelector('[data-x="cancel"]').addEventListener('click', closeSheet);
      root.querySelector('[data-x="save"]').addEventListener('click', () => {
        const title = root.querySelector('#f-title').value.trim();
        if (!title) { toast('Give it a name first.'); return; }
        const time = root.querySelector('#f-time').value || null;
        const placeId = needsPlace ? root.querySelector('#f-place').value : (editing?.placeId || null);
        const recurring = root.querySelector('#f-recurring').checked;
        if (editing) {
          updateItem(editing.id, { title, time, placeId, recurring });
        } else {
          addItem({ type, title, time, placeId, recurring });
        }
        closeSheet();
        render();
      });
    });
  }

  /* ---------------- Render: Vault ---------------- */

  let vaultFilter = 'all';
  let vaultQuery = '';

  function renderVault(app) {
    const q = vaultQuery.trim().toLowerCase();
    let entries = state.vault.filter((v) => vaultFilter === 'all' || v.type === vaultFilter);
    if (q) entries = entries.filter((v) => v.title.toLowerCase().includes(q) || (v.place || '').toLowerCase().includes(q));

    app.innerHTML = `
      <div class="eyebrow">History Vault</div>
      <h1 class="page-title">Did I\u2026</h1>
      <p class="page-sub">A light archive of ticks \u2014 so you can check whether you actually handed over the keys.</p>

      <div class="search-box">
        <svg viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="1.6"/><path d="m20 20-3.2-3.2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
        <input id="vault-search" placeholder="Search titles or places" value="${esc(vaultQuery)}" />
      </div>
      <div class="filter-row">
        ${['all', 'do', 'take', 'give'].map((f) => `<button class="chip ${vaultFilter === f ? 'active' : ''}" data-filter="${f}">${f === 'all' ? 'All' : f[0].toUpperCase() + f.slice(1)}</button>`).join('')}
      </div>

      ${entries.length ? renderVaultGroups(entries) : `
        <div class="empty-panel">
          <svg class="empty-icon" viewBox="0 0 24 24" fill="none"><rect x="3.5" y="7" width="17" height="13" rx="1.6" stroke="currentColor" stroke-width="1.5"/><path d="M3.5 7 5.5 3.5h13L20.5 7" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M10 11h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
          <p>${q || vaultFilter !== 'all' ? 'Nothing matches yet.' : 'Nothing in the vault yet. Completed actions land here as you tick them off.'}</p>
        </div>`}
    `;

    app.querySelector('#vault-search').addEventListener('input', (e) => { vaultQuery = e.target.value; renderVault(app); });
    app.querySelectorAll('[data-filter]').forEach((b) => b.addEventListener('click', () => { vaultFilter = b.dataset.filter; renderVault(app); }));
    // restore focus/cursor after re-render
    const s = app.querySelector('#vault-search');
    if (document.activeElement !== s && vaultQuery) { /* no-op, avoid stealing focus unexpectedly */ }
  }

  function renderVaultGroups(entries) {
    const groups = new Map();
    entries.forEach((v) => {
      const label = vaultDayLabel(v.timestamp);
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push(v);
    });
    let html = '';
    for (const [label, list] of groups) {
      html += `<div class="vault-day">
        <div class="vault-day-label">${esc(label)}</div>
        <div class="vault-list">
          ${list.map((v) => `
            <div class="vault-row">
              <div class="vault-check">${CHECK_SVG}</div>
              <div>
                <div class="vault-row-title">${esc(v.title)}</div>
                <div class="vault-row-meta">${v.type.toUpperCase()}${v.place ? ' \u00b7 ' + esc(v.place) : ''}</div>
              </div>
              <div class="vault-row-time">${esc(formatClock(new Date(v.timestamp)))}</div>
            </div>`).join('')}
        </div>
      </div>`;
    }
    return html;
  }

  /* ---------------- Render: Places ---------------- */

  function renderPlaces(app) {
    app.innerHTML = `
      <div class="eyebrow">Bases</div>
      <div class="row-between" style="align-items:flex-start; margin-bottom:8px;">
        <div>
          <h1 class="page-title" style="margin-bottom:6px;">Places</h1>
          <p class="page-sub" style="margin-bottom:22px;">Save the doors you actually use. Threshold filters take and give lists from the place you\u2019re leaving.</p>
        </div>
        <button class="btn btn-light" data-action="add-place">+ Add</button>
      </div>
      <div id="place-list">
        ${state.places.map(placeRow).join('') || '<p class="col-empty">No places yet \u2014 add the doors you walk through.</p>'}
      </div>
    `;

    app.querySelector('[data-action="add-place"]').addEventListener('click', openAddPlaceSheet);
    app.querySelectorAll('[data-action="edit-place"]').forEach((b) => b.addEventListener('click', () => openAddPlaceSheet(placeById(b.dataset.id))));
    app.querySelectorAll('[data-action="use-place"]').forEach((b) => b.addEventListener('click', () => { setCurrentPlace(b.dataset.id); render(); toast('Current place updated.'); }));

    const fab = document.getElementById('fab');
    fab.onclick = openAddPlaceSheet;
  }

  function placeRow(p) {
    const sub = [p.isCurrent ? 'Current' : null, p.lat != null ? 'Pinned' : 'No pin'].filter(Boolean).join(' \u00b7 ');
    return `
      <div class="place-row">
        <div class="place-left">
          <div class="place-icon">${iconSvg(p.icon)}</div>
          <div>
            <div class="place-name">${esc(p.name)}</div>
            <div class="place-sub">${esc(sub)}</div>
          </div>
        </div>
        <div class="place-actions">
          ${!p.isCurrent ? `<button class="btn btn-ghost btn-sm" data-action="use-place" data-id="${p.id}">Set current</button>` : ''}
          <button class="btn btn-ghost btn-sm" data-action="edit-place" data-id="${p.id}">Edit</button>
        </div>
      </div>`;
  }

  function openAddPlaceSheet(editing) {
    const isEdit = editing && editing.id;
    openSheet(`
      <h3 class="sheet-title">${isEdit ? 'Edit place' : 'Add a place'}</h3>
      <div class="sheet-row">
        <div class="field-label">Name</div>
        <input class="text-input" id="p-name" placeholder="e.g. Office" value="${isEdit ? esc(editing.name) : ''}" />
      </div>
      <div class="sheet-row">
        <div class="field-label">Icon</div>
        <div class="seg" id="p-icon-seg">
          ${Object.keys(ICONS).map((k) => `<button type="button" data-icon="${k}" class="${(isEdit ? editing.icon : 'home') === k ? 'active' : ''}">${ICON_LABELS[k]}</button>`).join('')}
        </div>
      </div>
      <div class="sheet-row">
        <button class="btn btn-ghost btn-block" id="p-pin" type="button">${isEdit && editing.lat != null ? 'Update pin to my current location' : 'Pin my current location'}</button>
        <p class="field-hint" id="p-pin-status">${isEdit && editing.lat != null ? 'Pinned \u2014 Threshold can tell when you\u2019re nearby.' : 'Optional. Lets Threshold suggest switching when you\u2019re nearby.'}</p>
      </div>
      <div class="sheet-actions">
        <button class="btn btn-ghost" data-x="cancel">Cancel</button>
        ${isEdit ? '<button class="btn btn-danger" data-x="delete">Delete</button>' : ''}
        <button class="btn btn-light" data-x="save">${isEdit ? 'Save' : 'Add'}</button>
      </div>
    `, (root) => {
      let icon = isEdit ? editing.icon : 'home';
      let pin = isEdit ? { lat: editing.lat, lng: editing.lng } : { lat: null, lng: null };
      root.querySelector('#p-name').focus();
      root.querySelectorAll('#p-icon-seg button').forEach((b) => b.addEventListener('click', () => {
        icon = b.dataset.icon;
        root.querySelectorAll('#p-icon-seg button').forEach((x) => x.classList.toggle('active', x === b));
      }));
      root.querySelector('#p-pin').addEventListener('click', () => {
        if (!('geolocation' in navigator)) { toast('Location isn\u2019t available on this device.'); return; }
        const statusEl = root.querySelector('#p-pin-status');
        statusEl.textContent = 'Locating\u2026';
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            pin = { lat: pos.coords.latitude, lng: pos.coords.longitude };
            statusEl.textContent = 'Pinned \u2014 Threshold can tell when you\u2019re nearby.';
            if (!state.settings.permLocation) { state.settings.permLocation = true; save(); startGeoWatch(); }
            toast('Location pinned.');
          },
          () => { statusEl.textContent = 'Couldn\u2019t get your location. Check permissions.'; },
          { enableHighAccuracy: true, timeout: 8000 }
        );
      });
      root.querySelector('[data-x="cancel"]').addEventListener('click', closeSheet);
      const delBtn = root.querySelector('[data-x="delete"]');
      if (delBtn) delBtn.addEventListener('click', () => { deletePlace(editing.id); closeSheet(); render(); toast('Place deleted.'); });
      root.querySelector('[data-x="save"]').addEventListener('click', () => {
        const name = root.querySelector('#p-name').value.trim();
        if (!name) { toast('Name it first.'); return; }
        if (isEdit) updatePlace(editing.id, { name, icon, lat: pin.lat, lng: pin.lng });
        else addPlace({ name, icon, lat: pin.lat, lng: pin.lng });
        closeSheet();
        render();
      });
    });
  }

  /* ---------------- Render: Settings ---------------- */

  function renderSettings(app) {
    const s = state.settings;
    app.innerHTML = `
      <div class="eyebrow">Preferences</div>
      <h1 class="page-title">More</h1>

      <div class="section-card">
        <h2 class="section-title">You</h2>
        <div class="field-label">Name</div>
        <input class="text-input" id="s-name" placeholder="Optional" value="${esc(s.name)}" />
      </div>

      <div class="section-card">
        <h2 class="section-title">Permissions</h2>
        <p class="section-sub">Threshold uses these only on this device. Nothing is uploaded.</p>

        <div class="toggle-row">
          <div class="toggle-copy"><strong>Location</strong><span>Detect when you\u2019re near a pinned place.</span></div>
          <button class="switch ${s.permLocation ? 'on' : ''}" id="s-loc" role="switch" aria-checked="${s.permLocation}"></button>
        </div>
        <div class="toggle-row">
          <div class="toggle-copy"><strong>Reminders</strong><span>Timed tasks and a morning leaving ping.</span></div>
          <button class="switch ${s.permReminders ? 'on' : ''}" id="s-rem" role="switch" aria-checked="${s.permReminders}"></button>
        </div>
        <div class="toggle-row">
          <div class="toggle-copy"><strong>Haptics</strong><span>A heavy tick when you complete an item.</span></div>
          <button class="switch ${s.permHaptics ? 'on' : ''}" id="s-hap" role="switch" aria-checked="${s.permHaptics}"></button>
        </div>

        <div class="field-label" style="margin-top:20px;">Morning leaving ping</div>
        <input class="time-input" id="s-ping" type="time" value="${esc(s.pingTime)}" />
        <p class="field-hint">Fires while the app is open, or as a system notification if allowed.</p>
      </div>

      <div class="section-card">
        <h2 class="section-title">Day</h2>
        <p class="section-sub">At midnight, one-off items clear and daily routines reset. The vault keeps the ticks.</p>
        <div class="stack">
          <button class="btn btn-ghost btn-block" id="s-reset-day">Reset today\u2019s ticks</button>
          <button class="btn btn-ghost btn-block" id="s-sample-day">Load a sample day</button>
        </div>
      </div>

      <div class="section-card">
        <h2 class="section-title">Data</h2>
        <p class="section-sub">Everything lives in this browser. Clearing wipes places, lists, and the vault.</p>
        <button class="btn btn-danger" id="s-clear">Clear all data</button>
      </div>

      <p class="footer-tag">Threshold \u00b7 a day-of companion \u00b7 Do \u00b7 Take \u00b7 Give</p>
    `;

    app.querySelector('#s-name').addEventListener('change', (e) => { state.settings.name = e.target.value.trim(); save(); });
    app.querySelector('#s-loc').addEventListener('click', () => requestLocationPermission(!state.settings.permLocation));
    app.querySelector('#s-rem').addEventListener('click', () => requestReminderPermission(!state.settings.permReminders));
    app.querySelector('#s-hap').addEventListener('click', () => setHaptics(!state.settings.permHaptics));
    app.querySelector('#s-ping').addEventListener('change', (e) => { state.settings.pingTime = e.target.value || '08:15'; save(); toast('Ping time updated.'); });
    app.querySelector('#s-reset-day').addEventListener('click', () => {
      state.settings.lastActiveDate = null;
      ensureDailyReset();
      render();
      toast('Today\u2019s ticks are cleared.');
    });
    app.querySelector('#s-sample-day').addEventListener('click', () => { loadSampleDay(); render(); toast('Sample day loaded.'); });
    app.querySelector('#s-clear').addEventListener('click', () => {
      openSheet(`
        <h3 class="sheet-title">Clear all data?</h3>
        <p class="page-sub" style="margin-bottom:18px;">This removes every place, list, and vault entry from this browser. It can\u2019t be undone.</p>
        <div class="sheet-actions">
          <button class="btn btn-ghost" data-x="cancel">Cancel</button>
          <button class="btn btn-danger" data-x="confirm">Clear everything</button>
        </div>
      `, (root) => {
        root.querySelector('[data-x="cancel"]').addEventListener('click', closeSheet);
        root.querySelector('[data-x="confirm"]').addEventListener('click', () => {
          localStorage.removeItem(STORE_KEY);
          state = defaultState();
          closeSheet();
          navigate('/');
          render();
          toast('All data cleared.');
        });
      });
    });
  }

  function loadSampleDay() {
    if (!state.places.length) {
      state.places.push({ id: uid(), name: 'Home', icon: 'home', lat: null, lng: null, isCurrent: true });
    }
    const home = state.places.find((p) => p.isCurrent) || state.places[0];
    let office = state.places.find((p) => p.name.toLowerCase() === 'office');
    if (!office) { office = { id: uid(), name: 'Office', icon: 'office', lat: null, lng: null, isCurrent: false }; state.places.push(office); }

    addItem({ type: 'do', title: 'Call the mechanic about the car', time: '10:00', recurring: false });
    addItem({ type: 'do', title: 'Take the daily vitamins', recurring: true });
    addItem({ type: 'take', title: 'Laptop charger', placeId: home.id, recurring: false });
    addItem({ type: 'take', title: 'Gym shoes', placeId: home.id, recurring: false });
    addItem({ type: 'give', title: 'Return Sarah\u2019s book', placeId: office.id, recurring: false });
    addItem({ type: 'give', title: 'Hand rent check to landlord', placeId: home.id, recurring: false });
  }

  /* ---------------- Small utils ---------------- */

  function esc(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* ---------------- Boot ---------------- */

  function boot() {
    ensureDailyReset();
    save();
    applyLeavingClass();
    render();

    if (state.settings.permLocation) startGeoWatch();

    setInterval(() => {
      ensureDailyReset();
      checkMorningPing();
      if (currentRoute() === '/') render(); // keeps the clock live
    }, 20000);

    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW registration failed', e));
      });
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
