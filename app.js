/* =========================================================================
   Threshold — Do / Take / Give
   Single-file app logic: state, router, renderers, device integrations.
   Everything persists to localStorage. No network calls, no accounts.
   ========================================================================= */

(() => {
  'use strict';

  const STORE_KEY = 'threshold:v1';

  // ---- Ola Maps (https://maps.olakrutrim.com) ----
  // Bring-your-own-key: the person pastes their own Ola Maps API key into
  // More → Maps. Nothing is bundled or sent anywhere except olamaps.io.
  const OLA = {
    BASE: 'https://api.olamaps.io',
    AUTOCOMPLETE: '/places/v1/autocomplete',
    DETAILS: '/places/v1/details',
    REVERSE_GEOCODE: '/places/v1/reverse-geocode',
    STATIC_MAP: '/tiles/v1/styles/default-light-standard/static',
    DOCS_URL: 'https://maps.olakrutrim.com/docs',
  };

  const ICONS = {
    home: 'M4 11 12 4l8 7M6 10v9h4v-5h4v5h4v-9',
    office: 'M6 21V6l6-3 6 3v15M9 21v-4h6v4M9 11h.01M9 8h.01M15 11h.01M15 8h.01',
    restaurant: 'M6 3v7a2 2 0 0 0 2 2v9M6 3v5M9 3v5M6 8h3M16 3c-1.7 0-3 2-3 5s1.3 5 3 5v8M16 3c1.7 0 3 2 3 5s-1.3 5-3 5',
    cafe: 'M4 8h13v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V8ZM17 9h1.5a2.5 2.5 0 0 1 0 5H17M7 3.5c-.6.6-.6 1.4 0 2M10.5 3.5c-.6.6-.6 1.4 0 2',
    gym: 'M4 12h2M18 12h2M6 9v6M18 9v6M8 12h8M6 12v0',
    school: 'M12 4 2 9l10 5 10-5-10-5ZM2 9v6M6 12.5V17c0 1.5 3 3 6 3s6-1.5 6-3v-4.5',
    other: 'M12 21.5s7-6.4 7-12A7 7 0 0 0 5 9.5c0 5.6 7 12 7 12Z',
  };
  const ICON_LABELS = { home: 'Home', office: 'Office', restaurant: 'Restaurant', cafe: 'Cafe', gym: 'Gym', school: 'School', other: 'Other' };

  const CHECK_SVG = '<svg viewBox="0 0 24 24" fill="none"><path d="M4 12.5l5 5L20 6" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const PLUS_SVG = '<svg viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  const PIN_SVG = '<svg viewBox="0 0 24 24" fill="none"><path d="M12 21.5s7-6.4 7-12A7 7 0 0 0 5 9.5c0 5.6 7 12 7 12Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><circle cx="12" cy="9.4" r="2.3" stroke="currentColor" stroke-width="1.6"/></svg>';
  const SPINNER_SVG = '<svg class="spin" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-dasharray="34 100"/></svg>';

  /* ---------------- State ---------------- */

  function defaultState() {
    return {
      places: [
        { id: uid(), name: 'Home', icon: 'home', lat: null, lng: null, address: null, isCurrent: true },
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
        olaMapsKey: '',
        installBannerDismissed: false,
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

  function addPlace({ name, icon, lat, lng, address }) {
    if (!name || !name.trim()) return null;
    const p = { id: uid(), name: name.trim(), icon: icon || 'other', lat: lat ?? null, lng: lng ?? null, address: address || null, isCurrent: state.places.length === 0 };
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

  // ---- Ola Maps: search, reverse geocode, static preview ----

  function olaKey() {
    return (state.settings.olaMapsKey || '').trim();
  }

  function debounce(fn, ms) {
    let t = null;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  async function olaAutocomplete(query, lat, lng) {
    const key = olaKey();
    if (!key || !query || query.trim().length < 3) return [];
    const params = new URLSearchParams({ input: query.trim(), api_key: key });
    if (lat != null && lng != null) params.set('location', `${lat},${lng}`);
    const res = await fetch(`${OLA.BASE}${OLA.AUTOCOMPLETE}?${params.toString()}`);
    if (!res.ok) throw new Error(`Ola Maps autocomplete failed (${res.status})`);
    const data = await res.json();
    return (data.predictions || []).map((p) => ({
      placeId: p.place_id,
      description: p.description,
      main: p.structured_formatting?.main_text || p.description,
      secondary: p.structured_formatting?.secondary_text || '',
    }));
  }

  async function olaPlaceDetails(placeId) {
    const key = olaKey();
    if (!key || !placeId) return null;
    const params = new URLSearchParams({ place_id: placeId, api_key: key });
    const res = await fetch(`${OLA.BASE}${OLA.DETAILS}?${params.toString()}`);
    if (!res.ok) throw new Error(`Ola Maps place details failed (${res.status})`);
    const data = await res.json();
    const r = data.result;
    if (!r || !r.geometry?.location) return null;
    return {
      lat: r.geometry.location.lat,
      lng: r.geometry.location.lng,
      address: r.formatted_address || r.name || null,
    };
  }

  async function olaReverseGeocode(lat, lng) {
    const key = olaKey();
    if (!key) return null;
    const params = new URLSearchParams({ latlng: `${lat},${lng}`, api_key: key });
    const res = await fetch(`${OLA.BASE}${OLA.REVERSE_GEOCODE}?${params.toString()}`);
    if (!res.ok) throw new Error(`Ola Maps reverse geocode failed (${res.status})`);
    const data = await res.json();
    const first = (data.results || [])[0];
    return first ? (first.formatted_address || null) : null;
  }

  function olaStaticMapUrl(lat, lng, { zoom = 15, width = 640, height = 220 } = {}) {
    const key = olaKey();
    if (!key || lat == null || lng == null) return null;
    const marker = `${lng},${lat}|marker:true|color:%23e0a458`;
    const params = new URLSearchParams({ api_key: key, marker });
    return `${OLA.BASE}${OLA.STATIC_MAP}/${lng},${lat},${zoom}/${width}x${height}.png?${params.toString()}`;
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
    const locBit = p.address || (p.lat != null ? `${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}` : 'No pin yet');
    const sub = [p.isCurrent ? 'Current' : null, locBit].filter(Boolean).join(' \u00b7 ');
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
    const hasKey = !!olaKey();
    openSheet(`
      <h3 class="sheet-title">${isEdit ? 'Edit place' : 'Add a place'}</h3>
      <div class="sheet-row">
        <div class="field-label">Name</div>
        <input class="text-input" id="p-name" placeholder="e.g. Office, Mum\u2019s place, Ravi\u2019s Tiffin" value="${isEdit ? esc(editing.name) : ''}" />
      </div>
      <div class="sheet-row">
        <div class="field-label">Icon</div>
        <div class="seg seg-wrap" id="p-icon-seg">
          ${Object.keys(ICONS).map((k) => `<button type="button" data-icon="${k}" class="${(isEdit ? editing.icon : 'home') === k ? 'active' : ''}">${ICON_LABELS[k]}</button>`).join('')}
        </div>
      </div>

      <div class="sheet-row">
        <div class="field-label">Location</div>
        ${hasKey ? `
          <div class="place-search" id="p-search-wrap">
            <div class="search-box search-box-flat">
              <svg viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="1.6"/><path d="m20 20-3.2-3.2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
              <input id="p-search" placeholder="Search on Ola Maps \u2014 e.g. a cafe or address" autocomplete="off" />
            </div>
            <div class="place-results" id="p-search-results" hidden></div>
          </div>
        ` : `
          <p class="field-hint">Add an <a href="#/settings" data-nav class="text-btn" id="p-goto-settings">Ola Maps API key</a> in More to search for places by name.</p>
        `}
        <button class="btn btn-ghost btn-block" id="p-pin" type="button" style="margin-top:10px;">${PIN_SVG} ${isEdit && editing.lat != null ? 'Update to my current location' : 'Use my current location'}</button>
        <p class="field-hint" id="p-pin-status">${isEdit && editing.lat != null ? 'Pinned \u2014 Threshold can tell when you\u2019re nearby.' : 'Lets Threshold suggest switching to this place when you\u2019re nearby.'}</p>
        <div id="p-map-preview"></div>
      </div>

      <div class="sheet-actions">
        <button class="btn btn-ghost" data-x="cancel">Cancel</button>
        ${isEdit ? '<button class="btn btn-danger" data-x="delete">Delete</button>' : ''}
        <button class="btn btn-light" data-x="save">${isEdit ? 'Save' : 'Add'}</button>
      </div>
    `, (root) => {
      let icon = isEdit ? editing.icon : 'home';
      let pin = isEdit ? { lat: editing.lat, lng: editing.lng, address: editing.address || null } : { lat: null, lng: null, address: null };
      root.querySelector('#p-name').focus();
      root.querySelectorAll('#p-icon-seg button').forEach((b) => b.addEventListener('click', () => {
        icon = b.dataset.icon;
        root.querySelectorAll('#p-icon-seg button').forEach((x) => x.classList.toggle('active', x === b));
      }));

      const statusEl = root.querySelector('#p-pin-status');
      const previewEl = root.querySelector('#p-map-preview');

      function renderPreview() {
        if (pin.lat == null || pin.lng == null) { previewEl.innerHTML = ''; return; }
        const mapUrl = olaStaticMapUrl(pin.lat, pin.lng);
        previewEl.innerHTML = `
          <div class="map-preview-card">
            ${mapUrl ? `<img class="map-preview" src="${mapUrl}" alt="Map preview of the pinned spot" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'map-preview map-preview-fallback',textContent:'Map preview unavailable'}))" />` : `<div class="map-preview map-preview-fallback">${PIN_SVG}<span>${pin.lat.toFixed(5)}, ${pin.lng.toFixed(5)}</span></div>`}
            ${pin.address ? `<p class="field-hint" style="margin-top:8px;">${esc(pin.address)}</p>` : ''}
          </div>`;
      }
      renderPreview();

      // ---- Search (Ola Maps autocomplete) ----
      if (hasKey) {
        const searchInput = root.querySelector('#p-search');
        const resultsEl = root.querySelector('#p-search-results');
        let reqToken = 0;
        const runSearch = debounce(async (q) => {
          const myToken = ++reqToken;
          if (q.trim().length < 3) { resultsEl.hidden = true; resultsEl.innerHTML = ''; return; }
          resultsEl.hidden = false;
          resultsEl.innerHTML = `<div class="place-result place-result-status">${SPINNER_SVG} Searching\u2026</div>`;
          try {
            const cp = currentPlace();
            const preds = await olaAutocomplete(q, cp?.lat, cp?.lng);
            if (myToken !== reqToken) return;
            if (!preds.length) {
              resultsEl.innerHTML = `<div class="place-result place-result-status">No matches. Try a different search.</div>`;
              return;
            }
            resultsEl.innerHTML = preds.map((p, i) => `
              <button type="button" class="place-result" data-idx="${i}">
                <span class="place-result-main">${esc(p.main)}</span>
                ${p.secondary ? `<span class="place-result-sub">${esc(p.secondary)}</span>` : ''}
              </button>`).join('');
            resultsEl.querySelectorAll('.place-result[data-idx]').forEach((btn) => {
              btn.addEventListener('click', async () => {
                const pred = preds[Number(btn.dataset.idx)];
                btn.disabled = true;
                btn.innerHTML = `<span class="place-result-main">${SPINNER_SVG} Locating\u2026</span>`;
                try {
                  const details = await olaPlaceDetails(pred.placeId);
                  if (!details) { toast('Couldn\u2019t load that place.'); return; }
                  pin = { lat: details.lat, lng: details.lng, address: details.address || pred.description };
                  searchInput.value = pred.main;
                  resultsEl.hidden = true;
                  statusEl.textContent = 'Pinned from search \u2014 Threshold can tell when you\u2019re nearby.';
                  renderPreview();
                  if (!root.querySelector('#p-name').value.trim()) root.querySelector('#p-name').value = pred.main;
                } catch (e) {
                  console.warn('Ola Maps details failed', e);
                  toast('Ola Maps lookup failed. Check your API key in More.');
                }
              });
            });
          } catch (e) {
            if (myToken !== reqToken) return;
            console.warn('Ola Maps autocomplete failed', e);
            resultsEl.innerHTML = `<div class="place-result place-result-status">Search failed. Check your API key in More.</div>`;
          }
        }, 350);
        searchInput.addEventListener('input', (e) => runSearch(e.target.value));
        searchInput.addEventListener('focus', () => { if (resultsEl.innerHTML && searchInput.value.trim().length >= 3) resultsEl.hidden = false; });
        document.addEventListener('click', (e) => {
          if (!root.contains(e.target)) return;
          if (!e.target.closest('#p-search-wrap')) resultsEl.hidden = true;
        });
      }

      root.querySelector('#p-pin').addEventListener('click', () => {
        if (!('geolocation' in navigator)) { toast('Location isn\u2019t available on this device.'); return; }
        statusEl.textContent = 'Locating\u2026';
        navigator.geolocation.getCurrentPosition(
          async (pos) => {
            pin = { lat: pos.coords.latitude, lng: pos.coords.longitude, address: null };
            statusEl.textContent = 'Pinned \u2014 Threshold can tell when you\u2019re nearby.';
            if (!state.settings.permLocation) { state.settings.permLocation = true; save(); startGeoWatch(); }
            renderPreview();
            toast('Location pinned.');
            if (hasKey) {
              try {
                const address = await olaReverseGeocode(pin.lat, pin.lng);
                if (address) { pin.address = address; statusEl.textContent = 'Pinned \u2014 Threshold can tell when you\u2019re nearby.'; renderPreview(); }
              } catch (e) { console.warn('Ola Maps reverse geocode failed', e); }
            }
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
        if (isEdit) updatePlace(editing.id, { name, icon, lat: pin.lat, lng: pin.lng, address: pin.address });
        else addPlace({ name, icon, lat: pin.lat, lng: pin.lng, address: pin.address });
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
        <h2 class="section-title">Maps</h2>
        <p class="section-sub">Threshold uses <a href="${OLA.DOCS_URL}" target="_blank" rel="noopener">Ola Maps</a> to search for places and preview pinned spots. Paste your own API key below \u2014 it\u2019s stored only on this device and sent straight to olamaps.io, never anywhere else.</p>
        <div class="field-label">Ola Maps API key</div>
        <input class="text-input" id="s-ola-key" placeholder="Paste your Ola Maps API key" value="${esc(s.olaMapsKey || '')}" autocomplete="off" spellcheck="false" />
        <p class="field-hint">Don\u2019t have one? <a href="${OLA.DOCS_URL}" target="_blank" rel="noopener">Get a free key at maps.olakrutrim.com</a>. Without a key, you can still pin places using your device\u2019s current location.</p>
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
    app.querySelector('#s-ola-key').addEventListener('change', (e) => {
      state.settings.olaMapsKey = e.target.value.trim();
      save();
      toast(state.settings.olaMapsKey ? 'Ola Maps key saved.' : 'Ola Maps key cleared.');
    });
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

  /* ---------------- PWA: install prompt + offline banner ---------------- */

  let deferredInstallPrompt = null;
  let isOffline = !navigator.onLine;

  function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  }

  function renderBanners() {
    const root = document.getElementById('banner-root');
    if (!root) return;
    const parts = [];
    if (isOffline) {
      parts.push(`<div class="banner banner-offline">You\u2019re offline \u2014 everything still saves right here on this device.</div>`);
    }
    if (deferredInstallPrompt && !state.settings.installBannerDismissed && !isStandalone()) {
      parts.push(`
        <div class="banner banner-install">
          <span>Install Threshold for a faster, full-screen experience.</span>
          <div class="banner-actions">
            <button class="btn btn-light btn-sm" id="banner-install-btn">Install</button>
            <button class="banner-dismiss" id="banner-dismiss-btn" aria-label="Dismiss">\u2715</button>
          </div>
        </div>`);
    }
    root.innerHTML = parts.join('');
    const installBtn = document.getElementById('banner-install-btn');
    if (installBtn) installBtn.addEventListener('click', async () => {
      if (!deferredInstallPrompt) return;
      deferredInstallPrompt.prompt();
      try { await deferredInstallPrompt.userChoice; } catch (e) { /* ignore */ }
      deferredInstallPrompt = null;
      renderBanners();
    });
    const dismissBtn = document.getElementById('banner-dismiss-btn');
    if (dismissBtn) dismissBtn.addEventListener('click', () => {
      state.settings.installBannerDismissed = true;
      save();
      renderBanners();
    });
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    renderBanners();
  });
  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    toast('Threshold installed \u2014 find it on your home screen.');
    renderBanners();
  });
  window.addEventListener('online', () => { isOffline = false; renderBanners(); toast('Back online.'); });
  window.addEventListener('offline', () => { isOffline = true; renderBanners(); });

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
