/**
 * MusicPi Recorder Main Application
 * Coordinates UI, WebSocket, and recording functionality
 */

// Global instances
let socket;
let recorder;
let meters;

/** From GET /api/version: true on Raspberry Pi hardware; false after fetch if not; null before first response. */
let mixpiHostIsRaspberryPi = null;

/** From GET /api/version: true when this browser's request came from the recorder (loopback / Pi's own IP), not a phone on Wi‑Fi. */
let mixpiClientOnRecorder = null;

/** Last session folder name confirmed with Apply — drives confirm-on-change for Apply. */
let _sessionNameAtLastApply = '';

// UI Elements
const elements = {
    btnRecord: null,
    btnMarker: null,
    connectionStatus: null,
    connectionText: null,
    recordingTime: null,
    diskSpace: null,
    recordingStatus: null,
    markersList: null,
    inputVenue: null,
    inputArtist: null,
    inputEngineer: null,
    inputNotes: null,
    settingSamplerate: null,
    settingBitdepth: null,
    settingChannels: null,
    settingAutostart: null,
    settingDevice: null,
};

/** Touch-primary UI: Pi touchscreen / tablet finger input, not mouse-first desktop. */
function mixpiTouchPrimaryDisplay() {
    try {
        return window.matchMedia('(hover: none) and (pointer: coarse)').matches;
    } catch (_) {
        return false;
    }
}

let _exitKioskMqBound = false;

/** Show “Exit fullscreen browser” only on the Pi's own touchscreen (not a phone browsing to the Pi). */
function syncExitKioskSectionVisibility() {
    const el = document.getElementById('exit-kiosk-section');
    if (!el) return;
    const show = (
        mixpiTouchPrimaryDisplay()
        && mixpiHostIsRaspberryPi === true
        && mixpiClientOnRecorder === true
    );
    el.toggleAttribute('hidden', !show);
    if (_exitKioskMqBound) return;
    _exitKioskMqBound = true;
    try {
        const mq = window.matchMedia('(hover: none) and (pointer: coarse)');
        const onChange = () => syncExitKioskSectionVisibility();
        if (mq.addEventListener) mq.addEventListener('change', onChange);
        else mq.addListener(onChange);
    } catch (_) { /* ignore */ }
}

// Initialize application
document.addEventListener('DOMContentLoaded', () => {
    console.log('MusicPi Recorder starting...');

    initElements();
    initBuildVersion();  // fetch git hash and show in panel bar
    initViewToggle();    // mobile/desktop view toggle (must run before initTabs)
    syncExitKioskSectionVisibility();
    initPageReload();    // full reload for kiosk / no keyboard
    initTabs();          // wire up bottom-panel tabs
    initDiscovery();     // network discovery panel
    initSystemTab();     // wire up System tab lazy load

    recorder = new Recorder();
    recorder._initTimeline();   // draw idle waveform on load
    initWebSocket();
    setupEventListeners();
    _syncSkipSilenceWarnCheckbox();
    syncRecordTransportButton();
    loadConfig();
    loadStorageLocations();  // populate STORAGE dropdown (includes write-speed benchmark)
});

// ── Build version badge ──────────────────────────────────────────────────────
function initBuildVersion() {
    fetch('/api/version', { cache: 'no-store' })
        .then(r => r.json())
        .then(data => {
            mixpiHostIsRaspberryPi = data.raspberry_pi === true;
            mixpiClientOnRecorder = data.client_on_recorder === true;
            syncExitKioskSectionVisibility();

            const el = document.getElementById('build-version');
            if (!el || !data.hash) return;
            const ver = data.semver || 'v1.0';
            // Format date suffix as "Mon0626" when a date is available
            let dateSuffix = '';
            if (data.date) {
                const d = new Date(data.date + 'T00:00:00');
                const mon = ['Jan','Feb','Mar','Apr','May','Jun',
                             'Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()];
                const dd  = String(d.getDate()).padStart(2, '0');
                const yy  = String(d.getFullYear()).slice(-2);
                dateSuffix = `${mon}${dd}${yy}`;
            }
            let tag;
            const desc = data.describe || '';
            const mDesc = desc.match(/^(v[\d.]+)-(\d+)-g([0-9a-f]+)$/);
            if (mDesc) {
                // Ahead of a stable tag: "v1.0.2 +5 (993e884) May0626"
                tag = dateSuffix
                    ? `${mDesc[1]} +${mDesc[2]} (${data.hash}) ${dateSuffix}`
                    : `${mDesc[1]} +${mDesc[2]} (${data.hash})`;
            } else if (/^v\d+\.\d+\.\d+$/.test(desc)) {
                // Exactly on a stable tag: "v1.0.2 (993e884)"
                tag = `${ver} (${data.hash})`;
            } else {
                // rsync/no-git deploy: "v1.0.2 (993e884) May0626"
                tag = dateSuffix
                    ? `${ver} (${data.hash}) ${dateSuffix}`
                    : `${ver} (${data.hash})`;
            }
            el.textContent = tag;
        })
        .catch(() => {
            mixpiHostIsRaspberryPi = false;
            mixpiClientOnRecorder = false;
            syncExitKioskSectionVisibility();
        });
}

// ── HTTPS setup banner ────────────────────────────────────────────────────────
function initHttpsBanner() {
    // Only show when the page is loaded over plain HTTP (not HTTPS or localhost dev)
    if (window.location.protocol !== 'http:') return;
    // Skip on localhost (dev machine)
    if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') return;

    const banner   = document.getElementById('https-banner');
    const certLink = document.getElementById('https-cert-link');
    const after    = document.getElementById('https-banner-after');
    const switchLk = document.getElementById('https-switch-link');
    if (!banner) return;

    // Build the HTTPS equivalent of the current URL
    const httpsUrl = `https://${window.location.hostname}:${window.location.port}`;
    if (switchLk) switchLk.href = httpsUrl;

    // Show the banner
    banner.style.display = 'flex';

    // After the cert link is clicked, reveal the "install in Settings" instruction
    if (certLink) {
        certLink.addEventListener('click', () => {
            setTimeout(() => {
                if (after) after.style.display = 'inline';
                certLink.style.display = 'none';
            }, 400);
        });
    }
}

// ── Panel tab switching ────────────────────────────────────────────────────
// ── Network discovery panel ───────────────────────────────────────────────────

/** Return an inline SVG mixer (rack) icon for the discovery bar — desktop + mobile. */
function _xairMixerSVG(model) {
    const m = (model || '').toUpperCase();
    const ch = m.includes('18') ? 18 : m.includes('16') ? 16 : m.includes('12') ? 12 : 0;
    const label = ch ? `${ch}CH` : 'XAIR';
    return `<svg viewBox="0 0 34 22" width="34" height="22" xmlns="http://www.w3.org/2000/svg">
  <rect x="0.5" y="0.5" width="33" height="21" rx="2" fill="none" stroke="currentColor" stroke-width="1"/>
  <line x1="5"  y1="4" x2="5"  y2="14" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
  <rect x="3"   y="9"   width="4" height="2.2" rx="0.4" fill="currentColor"/>
  <line x1="11" y1="4" x2="11" y2="14" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
  <rect x="9"   y="6.5" width="4" height="2.2" rx="0.4" fill="currentColor"/>
  <line x1="17" y1="4" x2="17" y2="14" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
  <rect x="15"  y="11"  width="4" height="2.2" rx="0.4" fill="currentColor"/>
  <line x1="23" y1="4" x2="23" y2="14" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
  <rect x="21"  y="7.5" width="4" height="2.2" rx="0.4" fill="currentColor"/>
  <circle cx="29" cy="6"  r="1.4" fill="currentColor"/>
  <circle cx="29" cy="10" r="1.4" fill="currentColor"/>
  <text x="17" y="20.5" font-size="4.2" text-anchor="middle" fill="currentColor"
        font-family="monospace" font-weight="bold">${label}</text>
</svg>`;
}

/** Rack glyph always visible — avoids empty #disc-xair-icon (CSS :empty would hide it). */
function _setMixerDiscoveryIcon(iconEl, model, title) {
    if (!iconEl) return;
    iconEl.innerHTML = _xairMixerSVG(model || '');
    if (typeof title === 'string') iconEl.title = title;
}

/** Label for mixer dropdown / discovery (name or model, plus IP). */
function _mixerDiscoveryLabel(m) {
    const name = (m.name || '').trim();
    const model = m.model || 'XAir';
    const base = name || model;
    return `${base} — ${m.ip}`;
}

const discovery = {
    /** In-flight /api/discover — aborted when a new scan starts so manual ↻ always works. */
    _discoverAbort: null,
    _found: false,        // true once a mixer has been confirmed via OSC
    _retryTimer: null,    // interval handle for OSC retry-when-not-found
    _usbTimer:   null,    // interval handle for USB polling
    _lastMixers: [],      // last sorted /discover list (for icons after select change)
    _oscMixerIp: '',      // last IP we connected via UI
    /** Last JSON from GET /api/devices/usb — drives REC enable when idle. */
    _lastUsb: null,

    _loadOscMixerIpFromStorage() {
        try {
            const raw = localStorage.getItem('musicpi_prerecord');
            if (!raw) return;
            const j = JSON.parse(raw);
            if (j.oscMixerIp) this._oscMixerIp = String(j.oscMixerIp);
        } catch (_e) { /* ignore */ }
    },

    async loadNetwork() {
        try {
            const res = await fetch('/api/network');
            const d = await res.json();
            if (d.success) {
                const name = d.mdns || d.primary_ip || d.hostname;
                const val  = document.getElementById('disc-pi-val');
                if (val) val.textContent = name;
                // Also populate the compact header hostname shown in mobile
                const hdrPi = document.getElementById('hdr-pi-name');
                if (hdrPi) hdrPi.textContent = name;
            }
        } catch (_) {}
    },

    /**
     * Connect OSC to a mixer IP; refresh rack icon + tooltips from _lastMixers when possible.
     */
    async connectOscToIp(ip) {
        if (!ip) return;
        try {
            const cr = await fetch('/api/osc/connect', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ip})
            });
            const cd = await cr.json();
            const icon = document.getElementById('disc-xair-icon');
            const xair = document.getElementById('disc-xair');
            const mix = (this._lastMixers || []).find(x => String(x.ip) === String(ip));
            if (mix && icon) {
                icon.innerHTML = _xairMixerSVG(mix.model);
                const model = mix.model || 'XAir';
                const fw = mix.firmware ? ` fw${mix.firmware}` : '';
                const tip = `${model} — ${mix.name || ip}${fw}`;
                icon.title = tip;
                if (xair) xair.title = tip;
            } else if (icon) {
                _setMixerDiscoveryIcon(icon, '', 'XAir');
            }
            if (cd.connected) {
                this._oscMixerIp = ip;
                setTimeout(() => loadChannels(), 500);
                _savePrerecordState();
            }
        } catch (_) {}
    },

    _setMixerUiMode(multi) {
        const val = document.getElementById('disc-xair-val');
        const sel = document.getElementById('disc-mixer-select');
        if (val) val.hidden = !!multi;
        if (sel) {
            if (multi) {
                sel.hidden = false;
            } else {
                sel.hidden = true;
                sel.innerHTML = '';
            }
        }
    },

    async scan(isManual = false) {
        try {
            this._discoverAbort?.abort();
        } catch (_e) { /* ignore */ }
        const ac = new AbortController();
        this._discoverAbort = ac;

        const dot  = document.getElementById('disc-xair-dot');
        const val  = document.getElementById('disc-xair-val');
        const icon = document.getElementById('disc-xair-icon');
        const xair = document.getElementById('disc-xair');
        const btn  = document.getElementById('btn-disc-scan');

        if (isManual || !this._found) {
            if (dot)  dot.className = 'disc-dot disc-dot--search';
            if (val) {
                val.hidden = false;
                val.textContent = 'Searching…';
            }
            this._setMixerUiMode(false);
            _setMixerDiscoveryIcon(icon, '', 'Searching for mixer…');
            if (xair) xair.title = '';
        }
        if (btn) { btn.disabled = true; btn.textContent = '…'; }

        const clientTimeoutMs = 12000;
        const tOut = setTimeout(() => {
            try {
                ac.abort();
            } catch (_e) { /* ignore */ }
        }, clientTimeoutMs);

        try {
            const res = await fetch('/api/discover?timeout=3', {
                signal: ac.signal,
                cache: 'no-store',
            });
            if (this._discoverAbort !== ac) return;
            const d = await res.json();
            if (this._discoverAbort !== ac) return;
            if (d.success && d.mixers && d.mixers.length > 0) {
                const sorted = [...d.mixers].sort((a, b) =>
                    String(a.ip || '').localeCompare(String(b.ip || '')));
                this._lastMixers = sorted;

                if (sorted.length > 1) {
                    this._setMixerUiMode(true);
                    const sel = document.getElementById('disc-mixer-select');
                    if (dot) dot.className = 'disc-dot disc-dot--found';
                    if (sel) {
                        sel.innerHTML = '';
                        sorted.forEach((m) => {
                            const opt = document.createElement('option');
                            opt.value = m.ip;
                            opt.textContent = _mixerDiscoveryLabel(m);
                            const fw = m.firmware ? ` fw${m.firmware}` : '';
                            opt.title = `${m.model || 'XAir'}${fw} @ ${m.ip}`;
                            sel.appendChild(opt);
                        });
                        const preferred = this._oscMixerIp && sorted.some(x => String(x.ip) === String(this._oscMixerIp))
                            ? String(this._oscMixerIp)
                            : sorted[0].ip;
                        sel.value = preferred;
                        await this.connectOscToIp(sel.value);
                        if (this._discoverAbort !== ac) return;
                    }
                } else {
                    const m = sorted[0];
                    this._setMixerUiMode(false);
                    if (dot)  dot.className = 'disc-dot disc-dot--found';
                    if (icon) icon.innerHTML = _xairMixerSVG(m.model);
                    const model = m.model || 'XAir';
                    const fw    = m.firmware ? ` fw${m.firmware}` : '';
                    const fullText  = `${model}${fw} @ ${m.ip}`;
                    const shortText = model;
                    if (val) {
                        val.dataset.full  = fullText;
                        val.dataset.short = shortText;
                        val.textContent   = fullText;
                        val.title = fullText;
                    }
                    const tip = `${model} — ${m.name || m.ip}${fw}`;
                    if (icon) icon.title = tip;
                    if (xair) xair.title = tip;
                    await this.connectOscToIp(m.ip);
                    if (this._discoverAbort !== ac) return;
                }

                if (!this._found) {
                    this._found = true;
                    if (this._retryTimer) {
                        clearInterval(this._retryTimer);
                        this._retryTimer = null;
                    }
                }
            } else {
                this._lastMixers = [];
                if (dot)  dot.className = 'disc-dot disc-dot--error';
                this._setMixerUiMode(false);
                if (val)  val.textContent = 'Not found';
                _setMixerDiscoveryIcon(icon, '', 'No XAir mixer on LAN');
                if (xair) xair.title = '';
                this._found = false;
                if (!this._retryTimer) {
                    this._retryTimer = setInterval(() => this.scan(), 30000);
                }
            }
        } catch (e) {
            if (this._discoverAbort !== ac) return;
            if (e && e.name === 'AbortError') {
                return;
            }
            this._lastMixers = [];
            if (dot)  dot.className = 'disc-dot disc-dot--error';
            this._setMixerUiMode(false);
            if (val)  val.textContent = 'Error';
            _setMixerDiscoveryIcon(icon, '', 'Mixer discovery failed');
            if (xair) xair.title = '';
            this._found = false;
        } finally {
            clearTimeout(tOut);
            const wasCurrent = this._discoverAbort === ac;
            if (wasCurrent) {
                this._discoverAbort = null;
            }
            if (btn && wasCurrent) {
                btn.disabled = false;
                btn.textContent = '↻';
            }
        }
    },

    /** Poll /api/devices/usb and update the USB status item */
    async pollUsb() {
        const dot = document.getElementById('disc-usb-dot');
        const val = document.getElementById('disc-usb-val');
        try {
            const res = await fetch('/api/devices/usb', { cache: 'no-store' });
            const d   = await res.json();
            this._lastUsb = d;
            if (d.success && d.devices && d.devices.length > 0) {
                const dev = d.devices[0];
                // Show first matched device name, strip redundant vendor prefix
                const name      = dev.name.replace(/^(Behringer\s+)/i, '');
                const ch        = dev.input_channels ? ` · ${dev.input_channels}ch` : '';
                const fullText  = `${name}${ch}`;
                // Mobile short: recording channel count only (e.g. "18ch")
                const recCh     = dev.input_channels || 0;
                const shortText = recCh ? `${recCh}ch` : name;
                const aligned = d.input_device_aligned;
                if (dot) {
                    dot.className = aligned === false
                        ? 'disc-dot disc-dot--warn'
                        : 'disc-dot disc-dot--ok';
                }
                if (val) {
                    val.dataset.full  = fullText;
                    val.dataset.short = shortText;
                    val.textContent   = fullText;
                    let tip = `${dev.name} — ${dev.input_channels} in / ${dev.output_channels} out @ ${dev.sample_rate} Hz`;
                    if (aligned === false && d.active_input_name) {
                        tip += `. Recording engine is using a different input: "${d.active_input_name}". Reconnect USB or check Audio device in config.`;
                        val.textContent = `${fullText} ⚠`;
                    }
                    val.title = tip;
                }
                // If we found more than one mixer, hint it
                if (d.devices.length > 1) {
                    if (val && aligned !== false) val.textContent += ` +${d.devices.length - 1}`;
                }
            } else {
                if (dot) dot.className = 'disc-dot disc-dot--error';
                if (val) {
                    delete val.dataset.full;
                    delete val.dataset.short;
                    val.textContent = 'Not connected';
                    val.title = 'No known mixer USB audio device found';
                }
            }
        } catch (err) {
            console.warn('pollUsb failed:', err);
            this._lastUsb = { success: false, devices: [], input_device_aligned: null };
            if (dot) dot.className = 'disc-dot disc-dot--error';
            if (val) {
                delete val.dataset.full;
                delete val.dataset.short;
                val.textContent = 'Error';
            }
        }
        try {
            syncRecordTransportAvailability();
        } catch (e) {
            console.warn('syncRecordTransportAvailability:', e);
        }
    },

    init() {
        this._loadOscMixerIpFromStorage();
        this.loadNetwork();
        this.scan();
        this.pollUsb();
        // Re-check USB often enough that unplug/replug updates the UI without a long wait
        this._usbTimer = setInterval(() => this.pollUsb(), 4000);
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') void this.pollUsb();
        });
        const btn = document.getElementById('btn-disc-scan');
        if (btn) {
            btn.addEventListener('click', async () => {
                // USB first — network scan can take 10+ s; user expects immediate USB rescan
                await this.pollUsb();
                await this.scan(true);
                loadStorageLocations();   // re-detect USB drives on manual scan
            });
        }
        const mixSel = document.getElementById('disc-mixer-select');
        if (mixSel) {
            mixSel.addEventListener('change', () => {
                const ip = mixSel.value;
                if (ip) this.connectOscToIp(ip);
            });
        }

    }
};

/**
 * Enable REC only when WebSocket is up and /api/devices/usb reports a usable mixer input
 * (device present and aligned with the recording engine). While recording, REC stays enabled to stop.
 */
function syncRecordTransportAvailability() {
    const rec = elements.btnRecord;
    if (!rec) return;
    const recording =
        (recorder && recorder.isRecording) ||
        rec.classList.contains('recording');
    const applyPending =
        elements.btnApplyConfig && elements.btnApplyConfig.classList.contains('pending');

    if (recording) {
        rec.disabled = false;
        if (!applyPending) rec.title = '';
        syncRecordTransportButton();
        return;
    }

    const wsUp =
        (socket && socket.connected) ||
        (elements.connectionStatus &&
            elements.connectionStatus.classList.contains('connected'));
    if (!wsUp) {
        rec.disabled = true;
        if (!applyPending) rec.title = '';
        syncRecordTransportButton();
        return;
    }

    const usb = discovery._lastUsb;
    let inputReady = false;
    if (usb == null) {
        inputReady = false;
    } else if (!usb.success) {
        inputReady = false;
    } else {
        const hasDevice = usb.devices && usb.devices.length > 0;
        const aligned = usb.input_device_aligned;
        inputReady = hasDevice && aligned !== false;
    }

    rec.disabled = !inputReady;
    if (!inputReady) {
        if (!applyPending) {
            const misaligned =
                usb &&
                usb.success &&
                usb.devices &&
                usb.devices.length > 0 &&
                usb.input_device_aligned === false;
            rec.title = misaligned
                ? 'Recording engine is using a different input than this USB device. Reconnect USB or check Audio device in Settings.'
                : 'No mixer USB audio input detected. Connect your interface.';
        }
    } else if (!applyPending) {
        rec.title = '';
    }
    syncRecordTransportButton();
}

function initDiscovery() {
    discovery.init();

    document.querySelectorAll('.js-mixer-refresh').forEach((el) => {
        el.addEventListener('click', handleMixerRefreshClick);
    });

    // Full systemd restart — same as `scripts/sync.sh` restart (reloads Python + ALSA/PortAudio).
    document.querySelectorAll(
        '#btn-restart-service, #btn-usb-restart-service'
    ).forEach((btn) => {
        btn.addEventListener('click', () => performMixPiSystemRestart(btn));
    });

    // Auto-refresh channel names/strip data every 15 s when not recording
    setInterval(() => {
        if (!recorder || !recorder.isRecording) loadChannels();
    }, 15000);
}

async function performMixPiSystemRestart(buttonEl) {
    const ok = await showConfirmRestart();
    if (!ok) return;
    if (buttonEl) {
        buttonEl.disabled = true;
        buttonEl.textContent = '…';
    }
    try {
        await fetch('/api/system/restart', { method: 'POST' });
    } catch (_) {}
    setTimeout(() => window.location.reload(), 4000);
}

function showConfirmRestart() {
    return new Promise(resolve => {
        if (confirm('Restart the MixPi service?\n\nThis will interrupt any active recording and reload the page.')) {
            resolve(true);
        } else {
            resolve(false);
        }
    });
}

function initTabs() {
    const tabs = document.querySelectorAll('.panel-tab');
    let routingLoaded = false;
    let sessionsRefreshTimer = null;

    function activateTab(target) {
        // Routing tab is hidden in mobile; redirect to files
        if (target === 'routing' && document.body.classList.contains('mobile-view')) {
            target = 'files';
        }
        tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === target));

        const isMobile = document.body.classList.contains('mobile-view');
        const homeEl      = document.getElementById('tab-home');
        const contentEl   = document.querySelector('.panel-content');

        if (isMobile) {
            // In mobile mode #tab-home is a proper tab pane; toggle it vs panel-content
            const showHome = target === 'home';
            if (homeEl) homeEl.classList.toggle('active', showHome);
            if (contentEl) contentEl.style.display = showHome ? 'none' : '';
            // Only switch inner panes when not on home
            if (!showHome) {
                document.querySelectorAll('.tab-pane').forEach(pane => {
                    pane.classList.toggle('active', pane.id === `tab-${target}`);
                });
            }
        } else {
            // Desktop: #tab-home is now a proper tab pane (same logic as mobile)
            const showHome = target === 'home';
            if (homeEl)    homeEl.classList.toggle('active', showHome);
            if (contentEl) contentEl.style.display = showHome ? 'none' : '';
            if (!showHome) {
                document.querySelectorAll('.tab-pane').forEach(pane => {
                    pane.classList.toggle('active', pane.id === `tab-${target}`);
                });
            }
        }

        if (target === 'routing' && !routingLoaded) {
            routingLoaded = true;
            routingManager.load();
        }
        if (target === 'storage') {
            storageTab.load();
        }
        clearInterval(sessionsRefreshTimer);
        if (target === 'files') {
            sessionsManager.loadSessions();
            // No auto-poll — list refreshes on tab open and after each recording stops.
            // Polling every 10s was rebuilding the full DOM and resetting expanded/
            // collapsed state while the user was browsing.
        }
        localStorage.setItem('musicpi_active_tab', target);
    }

    // Expose activateTab so initViewToggle can call it
    window._activateTab = activateTab;

    tabs.forEach(tab => {
        tab.addEventListener('click', () => activateTab(tab.dataset.tab));
    });

    // Restore last active tab; skip 'routing' in mobile (tab is hidden)
    const isMobile   = document.body.classList.contains('mobile-view');
    const defaultTab = 'home';
    const invalid    = ['markers', ...(isMobile ? ['routing'] : [])];
    
    // Check if this is a fresh session (no saved tab) or if we should force home
    let saved = localStorage.getItem('musicpi_active_tab');
    
    // If the user just installed/cleared cache, start on home.
    // Otherwise, respect their last tab (unless it's invalid for their view).
    const target = (saved && !invalid.includes(saved)) ? saved : defaultTab;
    if (document.querySelector(`[data-tab="${target}"]`)) {
        activateTab(target);
    } else {
        activateTab(defaultTab);
    }

    // Refresh button
    const btnRefreshRouting = document.getElementById('btn-routing-refresh');
    if (btnRefreshRouting) {
        btnRefreshRouting.addEventListener('click', () => routingManager.load());
    }
}

function initPageReload() {
    const btn = document.getElementById('btn-page-reload');
    if (!btn) return;
    btn.addEventListener('click', () => window.location.reload());
}

/** SVG icons for compact layout toggle (phone = go to mobile, monitor = go to desktop). */
const _VIEW_TOGGLE_SVG_PHONE = `<svg class="hdr-view-toggle-svg" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path fill="currentColor" d="M17 1H7C5.9 1 5 1.9 5 3v18c0 1.1.9 2 2 2h10c1.1 0 2-.9 2-2V3c0-1.1-.9-2-2-2zm0 18H7V5h10v14z"/></svg>`;
const _VIEW_TOGGLE_SVG_MONITOR = `<svg class="hdr-view-toggle-svg" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path fill="currentColor" d="M21 3H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h7v2H8v2h8v-2h-2v-2h7c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 14H3V5h18v12z"/></svg>`;

function _syncViewToggleButton(btn) {
    if (!btn) return;
    const wrap = btn.querySelector('.hdr-view-toggle-icon');
    const mobile = document.body.classList.contains('mobile-view');
    if (wrap) wrap.innerHTML = mobile ? _VIEW_TOGGLE_SVG_MONITOR : _VIEW_TOGGLE_SVG_PHONE;
    const toDesktop = mobile;
    btn.setAttribute('aria-label', toDesktop ? 'Switch to desktop layout' : 'Switch to mobile layout');
    btn.title = toDesktop ? 'Switch to desktop layout' : 'Switch to mobile layout';
}

function initViewToggle() {
    const btn = document.getElementById('btn-view-toggle');
    if (!btn) return;

    // Determine starting view:
    //   1. Respect an explicit user preference saved in localStorage.
    //   2. Otherwise, auto-detect: mobile if the viewport is narrower than 768 px.
    const savedView  = localStorage.getItem('musicpi_view');
    const autoMobile = window.innerWidth < 768;
    const startMobile = savedView ? savedView === 'mobile' : autoMobile;

    if (startMobile) {
        document.body.classList.add('mobile-view');
        // initTabs() (which runs next) will call activateTab('home') and set up state
    }
    _syncViewToggleButton(btn);

    btn.addEventListener('click', () => {
        const enterMobile = !document.body.classList.contains('mobile-view');
        document.body.classList.toggle('mobile-view', enterMobile);
        _syncViewToggleButton(btn);
        localStorage.setItem('musicpi_view', enterMobile ? 'mobile' : 'desktop');

        // Re-render discovery bar values for the new mode (short vs full)
        document.querySelectorAll('[data-full][data-short]').forEach(el => {
            if (el.id === 'disc-usb-val' || el.id === 'disc-xair-val') return;
            el.textContent = enterMobile ? el.dataset.short : el.dataset.full;
        });

        if (enterMobile) {
            if (window._activateTab) window._activateTab('home');
        } else {
            const lastTab = localStorage.getItem('musicpi_active_tab');
            // Don't restore routing tab when coming from mobile (was hidden)
            const safeTab = (lastTab && lastTab !== 'routing') ? lastTab : 'home';
            if (window._activateTab) window._activateTab(safeTab);
        }

        // Re-check which channel names overflow in the new layout
        if (meters) requestAnimationFrame(() => meters.refreshAllNameScrolls());
        syncExitKioskSectionVisibility();
    });
}

function initElements() {
    elements.btnRecord = document.getElementById('btn-record');
    elements.btnMarker = document.getElementById('btn-marker');
    elements.connectionStatus = document.getElementById('connection-status');
    elements.connectionText = document.getElementById('connection-text');
    elements.recordingTime = document.getElementById('recording-time');
    elements.diskSpace = document.getElementById('disk-space');
    elements.recordingStatus = document.getElementById('recording-status');
    elements.markersList = document.getElementById('markers-list');
    elements.inputSessionName = document.getElementById('input-session-name');
    elements.inputTrackName   = document.getElementById('input-track-name');
    elements.inputVenue = document.getElementById('input-venue');
    elements.inputArtist = document.getElementById('input-artist');
    elements.inputEngineer = document.getElementById('input-engineer');
    elements.inputNotes = document.getElementById('input-notes');
    elements.settingSamplerate = document.getElementById('setting-samplerate');
    elements.settingBitdepth = document.getElementById('setting-bitdepth');
    elements.settingChannels = document.getElementById('setting-channels');
    elements.settingAutostart = document.getElementById('setting-autostart');
    elements.settingDevice = document.getElementById('setting-device');
    elements.settingMixer = document.getElementById('setting-mixer');
    elements.settingOsc = document.getElementById('setting-osc');
    elements.settingDetection = document.getElementById('setting-detection');
    elements.settingBitrate = document.getElementById('setting-bitrate');
    elements.settingStorage = document.getElementById('setting-storage');
    elements.btnArm2ch  = document.getElementById('btn-arm-2ch');
    elements.btnArm16ch = document.getElementById('btn-arm-16ch');
    elements.btnArmAll  = document.getElementById('btn-arm-all');
    elements.btnArmNone = document.getElementById('btn-arm-none');
    elements.btnApplyPreset     = document.getElementById('btn-apply-preset');
    elements.presetGrid         = document.getElementById('preset-grid');
    elements.qualityStatus      = document.getElementById('quality-status');
    elements.qualityEstimateVal = document.getElementById('quality-estimate-val');
    // Pre-record row controls
    elements.selectQuality    = document.getElementById('select-quality');
    elements.selectChPreset   = document.getElementById('select-ch-preset');
    elements.selectStorage    = document.getElementById('select-storage');
    elements.btnApplyConfig      = document.getElementById('btn-apply-config');
    elements.btnRefreshStorage   = document.getElementById('btn-refresh-storage');
    elements.chkSkipSilenceWarn  = document.getElementById('chk-skip-silence-warn');
    elements.inputNotes       = document.getElementById('input-notes');
    // Transport confirmed display
    elements.tptConfirmedName   = document.getElementById('tpt-confirmed-name');
    elements.tptConfirmedConfig = document.getElementById('tpt-confirmed-config');
    elements.tptConfirmedArmed  = document.getElementById('tpt-confirmed-armed');
    elements.tptCurrentTake     = document.getElementById('tpt-current-take');
}

/** Recent peak dBFS on armed channels — used before REC to detect silence / wrong USB routing. */
const inputActivity = {
    _samples: [],
    MAX_AGE_MS: 3200,
    /** Heuristic only (not calibration): peaks above this dBFS count as "signal" for the pre-REC check. */
    THRESHOLD_DB: -60,
    push(levelsData) {
        if (!meters || !levelsData) return;
        const peakArr = levelsData.peak || [];
        const armed = meters.getArmedIndices();
        let maxDb = -90;
        for (let i = 0; i < peakArr.length; i++) {
            if (armed && armed.size > 0 && !armed.has(i)) continue;
            const p = peakArr[i] ?? -90;
            if (p > maxDb) maxDb = p;
        }
        const now = Date.now();
        this._samples.push({ t: now, db: maxDb });
        const cutoff = now - this.MAX_AGE_MS;
        this._samples = this._samples.filter((x) => x.t >= cutoff);
    },
    recentMaxDb() {
        if (!this._samples.length) return -90;
        return Math.max(...this._samples.map((s) => s.db));
    },
    hasMeaningfulSignal() {
        return this.recentMaxDb() > this.THRESHOLD_DB;
    },
};

const SESSION_SKIP_SILENCE_WARN_KEY = 'musicpi_skip_silence_warn';

function _silenceWarnSkippedForTab() {
    try {
        return sessionStorage.getItem(SESSION_SKIP_SILENCE_WARN_KEY) === '1';
    } catch (_e) {
        return false;
    }
}

function _setSilenceWarnSkippedForTab(on) {
    try {
        if (on) sessionStorage.setItem(SESSION_SKIP_SILENCE_WARN_KEY, '1');
        else sessionStorage.removeItem(SESSION_SKIP_SILENCE_WARN_KEY);
    } catch (_e) { /* ignore */ }
}

function _syncSkipSilenceWarnCheckbox() {
    const el = elements.chkSkipSilenceWarn;
    if (!el) return;
    el.checked = _silenceWarnSkippedForTab();
}

function initWebSocket() {
    socket = io();
    
    socket.on('connect', () => {
        console.log('WebSocket connected');
        updateConnectionStatus(true);
        loadStatus();
        loadDeviceInfo();
        // Refresh channel names on reconnect — OSC may have come online since last load
        setTimeout(() => loadChannels(), 500);
    });

    socket.on('reconnect', () => {
        setTimeout(() => {
            void discovery.pollUsb();
            void discovery.scan(false);
        }, 600);
    });

    socket.on('disconnect', () => {
        console.log('WebSocket disconnected');
        updateConnectionStatus(false);
    });
    
    socket.on('levels', (data) => {
        if (meters) {
            meters.updateLevels(data);
            inputActivity.push(data);
        }
        // Feed scrolling waveform — use loudest armed channel
        if (recorder) {
            const rmsArr  = data.rms  || [];
            const peakArr = data.peak || [];
            let peakDb = -90, rmsDb = -90;
            // Find the hottest channel (prefer armed channels if meters available)
            const armedSet = meters ? meters.getArmedIndices() : null;
            for (let i = 0; i < rmsArr.length; i++) {
                if (armedSet && armedSet.size > 0 && !armedSet.has(i)) continue;
                if ((peakArr[i] ?? -90) > peakDb) peakDb = peakArr[i] ?? -90;
                if ((rmsArr[i]  ?? -90) > rmsDb)  rmsDb  = rmsArr[i]  ?? -90;
            }
            recorder.pushWaveform(peakDb, rmsDb);
        }
    });
    
    socket.on('status', (data) => {
        handleStatusUpdate(data);
    });
    
    socket.on('zip_progress', (data) => {
        const btnId = `btn-mixes-zip-${sessionsManager._safeId(data.session)}`;
        const btn = document.getElementById(btnId);
        if (btn && btn.disabled) {
            btn.innerHTML = `<span class="share-spinner" style="margin-right: 6px; vertical-align: middle;"></span><span style="vertical-align: middle;">${data.file}</span>`;
        }
    });

    socket.on('ui_state', (payload) => {
        if (payload && payload.state) {
            _applyRemoteUiState(payload.state);
        }
    });

    socket.on('error', (data) => {
        console.error('Server error:', data.message);
        alert(`Error: ${data.message}`);
    });

    // Real-time channel strip update pushed from OSC subscription
    socket.on('channel_update', (data) => {
        if (meters && data.channel && data.strip) {
            meters.updateStrip(data.channel - 1, data.strip);
        }
    });

    // Update progress from system updates
    socket.on('update_progress', (data) => {
        // Forward to storageTab if it exists and has the handler
        if (window.storageTab && typeof window.storageTab._handleUpdateProgress === 'function') {
            window.storageTab._handleUpdateProgress(data);
        }
    });
}

function setupEventListeners() {
    elements.btnRecord.addEventListener('click', handleRecordClick);
    if (elements.btnMarker) {
        elements.btnMarker.addEventListener('click', handleMarkerClick);
    }
    // Channel dropdown — arm channels immediately on selection and mark button as pending
    if (elements.selectChPreset) {
        elements.selectChPreset.addEventListener('change', () => {
            _applyChPreset(elements.selectChPreset.value);
            _markApplyPending();
            _savePrerecordState();
        });
    }

    // Quality dropdown — mark button as pending on change
    if (elements.selectQuality) {
        elements.selectQuality.addEventListener('change', () => {
            _markApplyPending();
            _savePrerecordState();
        });
    }

    // Session name / notes / track — auto-save as the user types (POST /api/ui-state).
    // Apply is only for quality + storage + channel preset (hardware paths).
    if (elements.inputSessionName) {
        elements.inputSessionName.addEventListener('input', () => {
            _savePrerecordState();
            _updateConfirmedDisplay();
            _flashSaved(elements.inputSessionName);
            _updateTrackPlaceholder();
            if (typeof refreshSessionListHighlight === 'function') refreshSessionListHighlight();
        });
    }
    if (elements.inputNotes) {
        elements.inputNotes.addEventListener('input', () => {
            _savePrerecordState();
            _flashSaved(elements.inputNotes);
        });
    }
    if (elements.inputTrackName) {
        elements.inputTrackName.addEventListener('input', () => {
            _flashSaved(elements.inputTrackName);
            _updateTakeLine();
        });
    }

    // Storage dropdown — refresh list every time the user opens it, then track change
    if (elements.selectStorage) {
        // Silently rescan on focus (fires when user clicks/taps to open the dropdown)
        elements.selectStorage.addEventListener('mousedown', () => {
            loadStorageLocations();   // fire-and-forget; options update before list is read
        });
        elements.selectStorage.addEventListener('change', () => {
            _markApplyPending();
            _savePrerecordState();
        });
    }

    // Apply config button
    if (elements.btnApplyConfig) {
        elements.btnApplyConfig.addEventListener('click', handleApplyConfig);
    }

    // Storage rescan button
    if (elements.btnRefreshStorage) {
        elements.btnRefreshStorage.addEventListener('click', async () => {
            const btn = elements.btnRefreshStorage;
            btn.classList.add('spinning');
            await loadStorageLocations();
            btn.classList.remove('spinning');
        });
    }

    // Refresh sessions button
    const btnRefreshSessions = document.getElementById('btn-refresh-sessions');
    if (btnRefreshSessions) {
        btnRefreshSessions.addEventListener('click', () => sessionsManager.loadSessions());
    }

    window.addEventListener('pagehide', () => {
        try {
            const state = _buildPrerecordPayload();
            const blob = new Blob([JSON.stringify(state)], { type: 'application/json' });
            navigator.sendBeacon('/api/ui-state', blob);
        } catch (_e) { /* ignore */ }
    });

    if (elements.chkSkipSilenceWarn) {
        elements.chkSkipSilenceWarn.addEventListener('change', () => {
            _setSilenceWarnSkippedForTab(elements.chkSkipSilenceWarn.checked);
        });
    }
}

/** Arm channels based on channel-preset dropdown value. */
function _applyChPreset(val) {
    if (!meters) return;
    const ch = meters.channelCount;
    switch (val) {
        case '2ch':         meters.armRange(1, 2);                 break;
        case '16ch':        meters.armRange(1, Math.min(16, ch));  break;
        case 'mainlr':      meters.armRange(ch - 1, ch);           break;
        case '16ch+mainlr': meters.armAll();                       break;
        case 'all':         meters.armAll();                       break;
        case 'custom': /* leave REC buttons as-is */               break;
    }
    meters.setChPreset(val);
    // Compute the allowed channel set (0-based indices) for this preset.
    // Channels inside the set stay freely toggleable; channels outside are greyed.
    // null = no restriction (Custom and full-range presets).
    let allowedSet = null;
    switch (val) {
        case '2ch':    allowedSet = new Set([0, 1]); break;
        case '16ch':   allowedSet = new Set(Array.from({length: Math.min(16, ch)}, (_, i) => i)); break;
        case 'mainlr': allowedSet = new Set([ch - 2, ch - 1]); break;
        // 'all', '16ch+mainlr', 'custom': all channels allowed — no locking needed
    }
    meters.setPresetRange(allowedSet);
}

/** Apply quality + channel selection and update transport bar summary. */
const STORAGE_KEY = 'musicpi_prerecord';

function _parseLocalPrerecord() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return raw ? JSON.parse(raw) : {};
    } catch (_) {
        return {};
    }
}

function _stateSavedAtMs(st) {
    if (!st || !st.stateSavedAt) return 0;
    const n = Date.parse(String(st.stateSavedAt));
    return Number.isNaN(n) ? 0 : n;
}

/**
 * Merge server and browser ui_state using stateSavedAt when present.
 * Legacy (no timestamps): if server still has default session1 but local has a real name, prefer local.
 */
function _mergePrerecordStates(serverS, localS) {
    const server = serverS || {};
    const local = localS || {};
    const ts = (st) => _stateSavedAtMs(st);
    let useServer = ts(server) >= ts(local);
    if (ts(server) === 0 && ts(local) === 0) {
        const snS = String(server.sessionName || '');
        const snL = String(local.sessionName || '');
        if (snL && snL !== 'session1' && (!snS || snS === 'session1')) {
            useServer = false;
        }
    }
    const pick = (key, def) => {
        const sv = server[key];
        const lv = local[key];
        const sStr = sv != null ? String(sv) : '';
        const lStr = lv != null ? String(lv) : '';
        if (useServer) {
            if (sStr.length) return sStr;
            if (lStr.length) return lStr;
            return def;
        }
        if (lStr.length) return lStr;
        if (sStr.length) return sStr;
        return def;
    };
    const pickOsc = () => {
        const sv = String(server.oscMixerIp || '');
        const lv = String(local.oscMixerIp || '');
        if (useServer) {
            if (sv.length) return sv;
            return lv;
        }
        if (lv.length) return lv;
        return sv;
    };
    return {
        sessionName: pick('sessionName', 'session1'),
        notes: pick('notes', ''),
        chPreset: pick('chPreset', ''),
        storagePath: pick('storagePath', ''),
        quality: pick('quality', ''),
        oscMixerIp: pickOsc(),
    };
}

function _buildPrerecordPayload() {
    return {
        sessionName: (elements.inputSessionName && elements.inputSessionName.value) || '',
        notes: (elements.inputNotes && elements.inputNotes.value) || '',
        trackName: (elements.inputTrackName && elements.inputTrackName.value) || '',
        chPreset: (elements.selectChPreset && elements.selectChPreset.value) || '',
        storagePath: (elements.selectStorage && elements.selectStorage.value) || '',
        quality: (elements.selectQuality && elements.selectQuality.value) || '',
        oscMixerIp: (typeof discovery !== 'undefined' && discovery._oscMixerIp) || '',
        stateSavedAt: new Date().toISOString(),
    };
}

/**
 * Apply shared UI state pushed from the server when another browser/tab edits
 * fields. Skips inputs that currently have focus so local typing is not overwritten.
 */
function _applyRemoteUiState(s) {
    if (!s || typeof s !== 'object') return;
    const ae = document.activeElement;
    let touched = false;

    const setIfBlurred = (el, val) => {
        if (!el || ae === el) return;
        const v = val ?? '';
        if (el.value !== v) {
            el.value = v;
            touched = true;
        }
    };

    if (elements.inputSessionName) {
        setIfBlurred(elements.inputSessionName, s.sessionName ? String(s.sessionName) : 'session1');
    }
    if (elements.inputNotes) {
        setIfBlurred(elements.inputNotes, s.notes != null ? String(s.notes) : '');
    }
    if (elements.inputTrackName) {
        setIfBlurred(elements.inputTrackName, s.trackName != null ? String(s.trackName) : '');
    }

    if (elements.selectChPreset && ae !== elements.selectChPreset && s.chPreset) {
        const cp = String(s.chPreset);
        if (elements.selectChPreset.value !== cp) {
            elements.selectChPreset.value = cp;
            _applyChPreset(cp);
            touched = true;
        }
    }

    if (elements.selectQuality && ae !== elements.selectQuality && s.quality) {
        const q = String(s.quality);
        if ([...elements.selectQuality.options].some(o => o.value === q)
            && elements.selectQuality.value !== q) {
            elements.selectQuality.value = q;
            touched = true;
        }
    }

    if (elements.selectStorage && ae !== elements.selectStorage && s.storagePath !== undefined) {
        const path = String(s.storagePath || '');
        if (elements.selectStorage.options.length === 0 && path) {
            loadStorageLocations();
        } else {
            const opt = [...elements.selectStorage.options].find(o => o.value === path);
            if (opt && elements.selectStorage.value !== path) {
                elements.selectStorage.value = path;
                touched = true;
            } else if (path && !opt && elements.selectStorage.options.length > 0) {
                loadStorageLocations();
            }
        }
    }

    if (touched) {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(_buildPrerecordPayload()));
        } catch (_e) {}
        _updateConfirmedDisplay();
        _updateTrackPlaceholder();
        _syncApplyButtonState();
    }
}

/**
 * Persist ALL pre-record fields to the server (ui_state.json) so every
 * browser on the network sees the same state.
 * Also mirrors to localStorage as a fast offline fallback.
 */
function _savePrerecordState() {
    const state = _buildPrerecordPayload();
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (_e) {}
    fetch('/api/ui-state', {
        method:  'POST',
        headers: {'Content-Type': 'application/json'},
        body:    JSON.stringify(state),
    }).catch(() => {}); // non-critical
}

/**
 * Load UI state from the server, merge with localStorage (last-write wins),
 * then apply. Called once on page load AFTER presetManager.load().
 */
async function _restorePrerecordState() {
    let serverS = {};
    let serverHasData = false;
    try {
        const res  = await fetch('/api/ui-state');
        const data = await res.json();
        if (data.success && data.state && Object.keys(data.state).length > 0) {
            serverS = data.state;
            serverHasData = true;
        }
    } catch (_e) {}

    const localS = _parseLocalPrerecord();
    const s = _mergePrerecordStates(serverHasData ? serverS : {}, localS);

    if (elements.inputSessionName) {
        elements.inputSessionName.value = s.sessionName || 'session1';
    }
    if (s.notes != null && elements.inputNotes) {
        elements.inputNotes.value = s.notes;
    }
    if (elements.inputTrackName) {
        elements.inputTrackName.value = '';
    }
    if (s.chPreset && elements.selectChPreset) {
        elements.selectChPreset.value = s.chPreset;
        _applyChPreset(s.chPreset);
    }
    if (s.quality && elements.selectQuality && s.quality !== presetManager.activeId) {
        elements.selectQuality.value = s.quality;
    }

    _sessionNameAtLastApply = (elements.inputSessionName && elements.inputSessionName.value.trim()) || '';

    if (s.oscMixerIp) {
        discovery._oscMixerIp = String(s.oscMixerIp);
        void discovery.connectOscToIp(discovery._oscMixerIp);
    }

    if (!serverHasData) {
        _savePrerecordState();
    }

    if (typeof refreshSessionListHighlight === 'function') refreshSessionListHighlight();
}

/** Server's currently-active storage path — set by loadStorageLocations(). */
let _serverActiveStoragePath = null;

/**
 * Fetch available storage locations and populate the STORAGE dropdown.
 * Each option shows the drive label, free space, and benchmarked write speed.
 * Called on page load and when the Scan button is clicked.
 */
async function loadStorageLocations() {
    const sel = elements.selectStorage;
    if (!sel) return;
    try {
        const res  = await fetch('/api/storage/locations');
        const data = await res.json();
        if (!data.success || !data.locations) return;

        sel.innerHTML = '';
        data.locations.forEach(loc => {
            const opt = document.createElement('option');
            opt.value = loc.path;
            const speed = loc.write_mbps > 0 ? ` · ${loc.write_mbps} MB/s` : '';
            const flag  = loc.write_mbps > 0
                ? (loc.sufficient ? ' ✓' : ' ⚠')
                : '';
            opt.textContent = `${loc.label} — ${loc.free_gb} GB${speed}${flag}`;
            if (loc.active) {
                opt.selected = true;
                _serverActiveStoragePath = loc.path; // track what server has active
            }
            sel.appendChild(opt);
        });

        // Prefer server ui-state, fall back to localStorage
        let savedPath = '';
        try {
            const uiRes  = await fetch('/api/ui-state');
            const uiData = await uiRes.json();
            savedPath = (uiData.success && uiData.state && uiData.state.storagePath) || '';
        } catch (_e) {}
        if (!savedPath) {
            try { savedPath = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}').storagePath || ''; }
            catch (_e) {}
        }
        if (savedPath && [...sel.options].some(o => o.value === savedPath)) {
            sel.value = savedPath;
        }

    } catch (e) {
        console.warn('Storage locations load failed:', e);
    }
}

/**
 * Update the SONG/TRACK input placeholder to reflect the next auto-number
 * for the current session (e.g. "song3" if 2 recordings already exist).
 */
function _updateTrackPlaceholder() {
    const el = elements.inputTrackName;
    if (!el) return;
    const sessionName = (elements.inputSessionName && elements.inputSessionName.value.trim()) || '';
    if (!sessionName || !sessionsManager.shows) {
        el.placeholder = 'song1';
        return;
    }
    const show = sessionsManager.shows.find(
        s => s.name.toLowerCase() === sessionName.toLowerCase()
    );
    const n = show ? (show.recordings || []).length + 1 : 1;
    el.placeholder = `song${n}`;
    _updateTakeLine();
}

/** Song / take line under session+quality (idle: next take; recording: folder name from API). */
function _updateTakeLine() {
    const el = elements.tptCurrentTake;
    if (!el) return;
    if (recorder && recorder.isRecording) {
        const name = (recorder.takeDisplayName || '').trim();
        el.textContent = name ? `Now: ${name}` : 'Now: …';
        el.classList.add('tpt-current-take--live');
        return;
    }
    el.classList.remove('tpt-current-take--live');
    const v = (elements.inputTrackName && elements.inputTrackName.value.trim()) || '';
    const ph = (elements.inputTrackName && elements.inputTrackName.placeholder) || 'song1';
    el.textContent = v ? `Next take: ${v}` : `Next take: ${ph}`;
}

/**
 * Mark the show row that matches the current SESSION input (for next recording folder).
 */
function refreshSessionListHighlight() {
    const cur = (elements.inputSessionName && elements.inputSessionName.value.trim()) || '';
    const rec = typeof recorder !== 'undefined' && recorder && recorder.isRecording;
    document.querySelectorAll('#sessions-list .show-group').forEach((g) => {
        const sn = g.dataset.show || '';
        const match = !!cur && sn.toLowerCase() === cur.toLowerCase();
        g.classList.toggle('show-group--active-session', match);
        if (match) g.setAttribute('aria-current', 'true');
        else g.removeAttribute('aria-current');

        const btn = g.querySelector('.show-use-session-btn');
        const badge = g.querySelector('.show-session-current-badge');
        if (btn) {
            btn.hidden = match;
            btn.disabled = !!rec && !match;
        }
        if (badge) badge.hidden = !match;
    });
}

/**
 * Called from Recordings list: set the active session folder for the next take.
 * @param {string} name Show folder name (as returned by /api/sessions).
 */
function setActiveSessionFromList(name) {
    if (name == null || typeof name !== 'string') return;
    if (recorder && recorder.isRecording) {
        alert('Cannot change session while recording.');
        return;
    }
    const s = name.trim();
    if (!s) return;
    if (elements.inputSessionName) {
        elements.inputSessionName.value = s;
    }
    _sessionNameAtLastApply = s;
    _savePrerecordState();
    _updateConfirmedDisplay();
    _updateTrackPlaceholder();
    if (elements.inputSessionName) _flashSaved(elements.inputSessionName);
    refreshSessionListHighlight();
}

window.refreshSessionListHighlight = refreshSessionListHighlight;
window.setActiveSessionFromList = setActiveSessionFromList;

/** Briefly highlight an input to confirm it auto-saved. */
function _flashSaved(el) {
    if (!el) return;
    clearTimeout(el._flashTimer);
    el.classList.add('input-autosaved');
    el._flashTimer = setTimeout(() => el.classList.remove('input-autosaved'), 800);
}

/** Mark the Apply button as pending (selection changed, not yet applied). */
function _markApplyPending() {
    const btn = elements.btnApplyConfig;
    if (!btn || btn.disabled) return;
    btn.classList.remove('applied');
    btn.classList.add('pending');
    btn.textContent = 'Apply';
    // Dim the RECORD button to signal settings need confirming first
    if (elements.btnRecord && !elements.btnRecord.classList.contains('recording')) {
        elements.btnRecord.classList.add('record-blocked');
        elements.btnRecord.title = 'Click APPLY first to confirm settings';
    }
}

function _clearRecordBlocked() {
    if (elements.btnRecord) {
        elements.btnRecord.classList.remove('record-blocked');
        elements.btnRecord.title = '';
    }
}

/**
 * On page load, show ✓ if the current UI selections already match what the
 * server has active, otherwise show APPLY (pending).
 * Called after both presetManager.load() and loadStorageLocations() have run.
 */
function _syncApplyButtonState() {
    const btn = elements.btnApplyConfig;
    if (!btn) return;

    const qualityMatch =
        !elements.selectQuality ||
        elements.selectQuality.value === presetManager.activeId;

    const storageMatch =
        !elements.selectStorage ||
        !_serverActiveStoragePath ||
        elements.selectStorage.value === _serverActiveStoragePath;

    if (qualityMatch && storageMatch) {
        btn.classList.remove('pending');
        btn.classList.add('applied');
        btn.textContent = '✓';
        btn.disabled = false;
        _clearRecordBlocked();
        syncRecordTransportAvailability();
    } else {
        _markApplyPending();
        syncRecordTransportAvailability();
    }
}

async function handleApplyConfig() {
    const btn = elements.btnApplyConfig;
    const nameNow = (elements.inputSessionName && elements.inputSessionName.value.trim()) || '';
    if (nameNow !== _sessionNameAtLastApply) {
        const ok = confirm(
            `Apply will confirm quality and storage using session folder "${nameNow || 'session1'}" for new takes. Continue?`
        );
        if (!ok) {
            _syncApplyButtonState();
            return;
        }
    }

    // Loading state
    if (btn) {
        btn.disabled = true;
        btn.textContent = '…';
        btn.classList.remove('pending', 'applied');
    }

    // 1. Apply storage location if selected
    if (elements.selectStorage && elements.selectStorage.value) {
        try {
            const res  = await fetch('/api/storage/select', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ path: elements.selectStorage.value }),
            });
            const data = await res.json();
            if (data.success && elements.diskSpace) {
                elements.diskSpace.textContent =
                    `${data.free_gb} / ${data.total_gb} GB`;
            }
        } catch (e) {
            console.warn('Storage select failed:', e);
        }
    }

    // 2. Apply quality preset (API call — may restart audio engine)
    await presetManager.apply();

    // 3. Re-apply channel preset
    if (elements.selectChPreset) {
        _applyChPreset(elements.selectChPreset.value);
    }

    // 4. Update confirmed display in transport bar
    _updateConfirmedDisplay();

    // 5. Persist the full UI state to the server so all browsers stay in sync
    _savePrerecordState();

    // 6. Stay green — confirmed state persists until next change
    if (btn) {
        btn.textContent = '✓';
        btn.classList.add('applied');
        btn.disabled = false;
    }
    _sessionNameAtLastApply = nameNow;
    _clearRecordBlocked();
    void discovery.pollUsb();
    syncRecordTransportAvailability();
}

/** Refresh the transport bar's confirmed session/config line. */
function _updateConfirmedDisplay() {
    const name   = (elements.inputSessionName && elements.inputSessionName.value.trim()) || '';
    const preset = presetManager.presets.find(p => p.id === presetManager.activeId);
    const tag    = preset ? preset.tag : '—';
    const armed  = meters ? meters.getArmedChannels().length : 0;

    if (elements.tptConfirmedName) {
        elements.tptConfirmedName.textContent = name;
        elements.tptConfirmedName.style.display = name ? '' : 'none';
    }
    if (elements.tptConfirmedConfig) elements.tptConfirmedConfig.textContent = tag;
    if (elements.tptConfirmedArmed) elements.tptConfirmedArmed.textContent = `${armed} CH armed`;
    _updateTakeLine();
}

/** Rebuild the channel preset dropdown using the real channel count. */
function _updateChPresetDropdown(ch) {
    const sel = elements.selectChPreset;
    if (!sel) return;
    const mainL = ch - 1, mainR = ch;
    sel.innerHTML = `
        <option value="all">Full Mix - Ch 1-${ch}</option>
        <option value="16ch+mainlr">Mix Ch 1-16 + Main LR (Ch 17-18)</option>
        <option value="2ch">Ch 1-2 Stereo — Input Pair</option>
        <option value="16ch">Ch 1-16 — Mono Inputs Only</option>
        <option value="mainlr">Main LR (Ch 17-18)</option>
        <option value="custom">Custom (use REC buttons)</option>
    `;
}

/** REC / STOP combined control — update aria-label for screen readers */
function syncRecordTransportButton() {
    const rec = elements.btnRecord;
    if (!rec) return;
    const recording = rec.classList.contains('recording') || (recorder && recorder.isRecording);
    rec.setAttribute('aria-label', recording ? 'Stop recording' : 'Record');
}

async function handleRecordClick() {
    try {
        // Same button stops when already recording
        if (recorder.isRecording || elements.btnRecord.classList.contains('recording')) {
            void handleStopClick();
            return;
        }

        // Block recording if quality/storage settings haven't been applied yet
        const applyBtn = elements.btnApplyConfig;
        if (applyBtn && applyBtn.classList.contains('pending')) {
            alert('Please click APPLY first to confirm your quality and storage settings before recording.');
            return;
        }

        elements.btnRecord.disabled = true;
        
        // Get session name (sanitize for filename)
        let sessionName = elements.inputSessionName.value.trim();
        if (sessionName) {
            // Remove invalid filename characters
            sessionName = sessionName.replace(/[^a-zA-Z0-9_-]/g, '_');
        }
        
        // Get armed channels (null = all)
        const armedChannels = meters ? meters.getArmedChannels() : null;
        const totalChannels = meters ? meters.channelCount : 18;
        if (armedChannels && armedChannels.length === 0) {
            alert('No channels are armed for recording.\nPress at least one REC button first.');
            syncRecordTransportAvailability();
            return;
        }

        if (!_silenceWarnSkippedForTab() && !inputActivity.hasMeaningfulSignal()) {
            const ok = confirm(
                'No meaningful input was detected on armed channels in the last few seconds ' +
                '(check USB routing to the mixer, gain/trim, or that sources are unmuted). Record anyway?'
            );
            if (!ok) {
                syncRecordTransportAvailability();
                return;
            }
        }

        // Get song/track name
        const trackName = (elements.inputTrackName && elements.inputTrackName.value.trim()) || '';

        // Get metadata
        const metadata = {
            session_name: sessionName,
            track_name:   trackName,
            ch_preset: (elements.selectChPreset && elements.selectChPreset.value) || 'all',
            venue: elements.inputVenue.value,
            artist: elements.inputArtist.value,
            engineer: elements.inputEngineer.value,
            notes: elements.inputNotes.value,
            // Only include channels array if it's a subset
            channels: (armedChannels && armedChannels.length < totalChannels) ? armedChannels : null,
        };

        await recorder.startRecording(metadata);

        // Lock pre-record row and individual arm buttons while recording
        if (meters) meters.setArmLocked(true);
        presetManager.lockDuringRecording(true);
        _updateConfirmedDisplay();
        _updateTakeLine();

        // Update UI — keep REC button enabled so user can tap again to stop
        elements.btnRecord.classList.add('recording');
        syncRecordTransportAvailability();
        if (elements.btnMarker) elements.btnMarker.disabled = false;
        elements.recordingStatus.textContent = 'Recording'; elements.recordingStatus.classList.add('recording');

        clearMarkersList();

        if (typeof refreshSessionListHighlight === 'function') refreshSessionListHighlight();

    } catch (error) {
        alert(`Failed to start recording: ${error.message}`);
        syncRecordTransportAvailability();
    }
}

async function handleStopClick() {
    try {
        elements.btnRecord.disabled = true;

        await recorder.stopRecording();

        // Unlock pre-record row and arm buttons
        if (meters) meters.setArmLocked(false);
        presetManager.lockDuringRecording(false);

        // Update UI
        elements.btnRecord.classList.remove('recording');
        if (elements.btnMarker) elements.btnMarker.disabled = true;
        elements.recordingStatus.textContent = 'Ready'; elements.recordingStatus.classList.remove('recording');
        syncRecordTransportAvailability();

        // Clear the TRACK/SONG field — engineer should name the next song fresh
        if (elements.inputTrackName) {
            elements.inputTrackName.value = '';
            _updateTrackPlaceholder();
        }
        _updateTakeLine();

        // Refresh session list so the new recording appears immediately
        setTimeout(() => sessionsManager.loadSessions(), 500);

    } catch (error) {
        alert(`Failed to stop recording: ${error.message}`);
        syncRecordTransportAvailability();
    }
}

async function handleMarkerClick() {
    try {
        const label = prompt('Marker label (optional):');
        if (label === null) return; // User cancelled
        
        const marker = await recorder.addMarker(label);
        addMarkerToList(marker);
        
    } catch (error) {
        alert(`Failed to add marker: ${error.message}`);
    }
}

let _mixerRefreshInFlight = false;

async function handleMixerRefreshClick() {
    const btns = document.querySelectorAll('.js-mixer-refresh');
    if (!btns.length) return;
    if (_mixerRefreshInFlight) {
        return;
    }
    _mixerRefreshInFlight = true;
    const prev = [...btns].map((b) => b.textContent);
    btns.forEach((b) => {
        b.disabled = true;
        b.textContent = '…';
    });
    try {
        // Channel strips only — USB status / rescan is the top-bar row (poll + red restart).
        await loadChannels({ refresh: true });
        if (socket && socket.connected) socket.emit('reset_peaks');
    } catch (e) {
        console.warn('Mixer refresh:', e);
    } finally {
        _mixerRefreshInFlight = false;
        btns.forEach((b, i) => {
            b.textContent = prev[i];
            b.disabled = false;
        });
    }
}

// ─── Recording Quality Preset Manager ────────────────────────────────────────
const presetManager = {
    presets: [],
    selectedId: null,
    activeId: null,   // what the engine is currently running

    async load() {
        try {
            const res = await fetch('/api/presets');
            const data = await res.json();
            if (!data.success) return;
            this.presets = data.presets;
            this.activeId = (data.presets.find(p => p.active) || {}).id || null;
            this.selectedId = this.activeId;
            this._render();
            // Sync only the quality key in localStorage to match server's active preset.
            // Do NOT call _savePrerecordState() here — other fields (session, notes) are
            // not yet populated in the DOM at this point and would be wiped.
            try {
                const _ls = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
                _ls.quality = this.activeId;
                localStorage.setItem(STORAGE_KEY, JSON.stringify(_ls));
            } catch (_e) { /* ignore */ }
        } catch (e) {
            console.error('Failed to load presets:', e);
        }
    },

    _render() {
        // Populate the quality dropdown (no ✓ in option text — confirmed state shown via button)
        const sel = elements.selectQuality;
        if (sel) {
            const prev = sel.value || this.selectedId;
            sel.innerHTML = '';
            this.presets.forEach(p => {
                const opt = document.createElement('option');
                opt.value = p.id;
                // Compact tag: "48 kHz / 16-bit" → "48kHz/16bit"
                const compactTag = p.tag
                    .replace(/\s*\/\s*/g, '/')        // spaces around slash
                    .replace(/(\d)\s+(kHz)/g, '$1$2') // "48 kHz" → "48kHz"
                    .replace(/-bit\b/g, 'bit')         // "16-bit" → "16bit"
                    .replace(/\s*Float$/, 'Float');    // "32-bit Float" tidy
                opt.textContent = `${p.label} ${compactTag}`;
                sel.appendChild(opt);
            });
            if (prev) sel.value = prev;
            this.selectedId = sel.value || (this.presets[0] || {}).id;
        }
    },

    _select(id) {
        this.selectedId = id;
        if (elements.selectQuality) elements.selectQuality.value = id;
    },

    /** Returns true if the quality was applied successfully, false otherwise. */
    async apply() {
        // Read current dropdown selection
        if (elements.selectQuality) this.selectedId = elements.selectQuality.value;
        const p = this.presets.find(p => p.id === this.selectedId);
        if (!p) return false;
        // Skip API call if already active
        if (this.selectedId === this.activeId) return true;

        try {
            const res = await fetch('/api/settings', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({bit_depth: p.bit_depth}),
            });
            const data = await res.json();
            if (data.success) {
                this.activeId = this.selectedId;
                this._render();  // refresh dropdown to show ✓ on active
                return true;
            } else {
                alert('Could not apply quality: ' + data.message);
                return false;
            }
        } catch (e) {
            alert('Error applying quality settings');
            return false;
        }
    },

    lockDuringRecording(locked) {
        // Lock every pre-record control while a take is in progress
        if (elements.selectQuality)    elements.selectQuality.disabled    = locked;
        if (elements.selectChPreset)   elements.selectChPreset.disabled   = locked;
        if (elements.selectStorage)    elements.selectStorage.disabled    = locked;
        if (elements.inputSessionName) elements.inputSessionName.disabled = locked;
        if (elements.inputNotes)       elements.inputNotes.disabled       = locked;
        if (elements.inputTrackName)   elements.inputTrackName.disabled   = locked;
        if (elements.inputVenue)       elements.inputVenue.disabled       = locked;
        if (elements.inputArtist)      elements.inputArtist.disabled      = locked;
        if (elements.inputEngineer)    elements.inputEngineer.disabled    = locked;
        if (elements.btnApplyConfig)   elements.btnApplyConfig.disabled   = locked;
        // Restore RECORD button appearance after stop (Apply-pending state handled elsewhere)
        if (!locked) _clearRecordBlocked();
    },
};
// ─────────────────────────────────────────────────────────────────────────────

async function _startAutoRecording() {
    // Called when the engine fires auto_start_triggered.
    // Kick off a real API recording start using whatever channels are armed.
    try {
        const armedChannels = meters ? meters.getArmedChannels() : null;
        const totalChannels = meters ? meters.channelCount : 18;
        const metadata = {
            session_name: null,   // engine will generate a timestamp name
            channels: (armedChannels && armedChannels.length < totalChannels) ? armedChannels : null,
        };
        await recorder.startRecording(metadata);

        if (meters) meters.setArmLocked(true);
        presetManager.lockDuringRecording(true);

        elements.btnRecord.classList.add('recording');
        syncRecordTransportAvailability();
        if (elements.btnMarker) elements.btnMarker.disabled = false;
        elements.recordingStatus.textContent = 'Recording'; elements.recordingStatus.classList.add('recording');

        clearMarkersList();
        _updateTakeLine();
    } catch (err) {
        console.error('Auto-start recording failed:', err);
        syncRecordTransportAvailability();
    }
}

function handleStatusUpdate(data) {
    console.log('Status update:', data);
    
    if (data.event === 'auto_start_triggered') {
        // Auto-start: actually call the API so recording really begins
        if (!recorder.isRecording) {
            _startAutoRecording();
        }
    }
    
    if (data.event === 'auto_stop_triggered') {
        // Auto-stop triggered
        if (meters) meters.setArmLocked(false);
        presetManager.lockDuringRecording(false);

        elements.btnRecord.classList.remove('recording');
        if (elements.btnMarker) elements.btnMarker.disabled = true;
        elements.recordingStatus.textContent = 'Ready'; elements.recordingStatus.classList.remove('recording');
        syncRecordTransportAvailability();

        recorder.isRecording = false;
        recorder.stopTimer();
        _updateTakeLine();
        setTimeout(() => sessionsManager.loadSessions(), 500);
    }
}

async function loadConfig() {
    try {
        const config = await recorder.getConfig();

        // Update settings display
        elements.settingSamplerate.textContent = `${config.audio.sample_rate} Hz`;
        const bitLabel = config.audio.bit_depth === 32 ? '32-bit Float'
                       : config.audio.bit_depth === 24 ? '24-bit PCM'
                       : `${config.audio.bit_depth}-bit PCM`;
        elements.settingBitdepth.textContent = bitLabel;
        elements.settingChannels.textContent = config.audio.channels;
        elements.settingAutostart.textContent = config.recording.auto_start.enabled ? 'Enabled' : 'Disabled';

        // Initialize meters with config names; OSC names will override via loadChannels()
        meters = new LevelMeters(
            'meters-container',
            config.audio.channels,
            config.channels.names,
            _updateConfirmedDisplay
        );

        // Update channel dropdown options with real channel count
        _updateChPresetDropdown(config.audio.channels);

        // Load live channel strip data from mixer (or config fallback)
        await loadChannels();

        // Load recording quality presets (populates quality dropdown)
        await presetManager.load();

        // Restore pre-record fields from server state (shared across browsers)
        await _restorePrerecordState();

        // Show initial confirmed display; button state depends on whether
        // current UI matches the server's active config
        _updateConfirmedDisplay();
        _syncApplyButtonState();
        _updateTakeLine();

    } catch (error) {
        console.error('Failed to load config:', error);
    }
}

async function loadChannels(options = {}) {
    try {
        let q = '';
        if (options.refresh) {
            const scope = options.scope === 'full' ? '&scope=full' : '&scope=names';
            q = `?refresh=1${scope}`;
        }
        const res = await fetch(`/api/channels${q}`);
        if (!res.ok) return;
        const data = await res.json();
        if (!data.success || !meters) return;

        meters.applyChannelStrips(data.channels);

        // Update the OSC indicator in the Settings panel
        if (elements.settingOsc) {
            const src = data.osc_connected ? '✓ Connected (live data)' : '✗ Not connected (using config)';
            elements.settingOsc.textContent = src;
            elements.settingOsc.style.color = data.osc_connected
                ? 'var(--accent-color)'
                : 'var(--text-secondary)';
        }
    } catch (error) {
        // Non-critical
    }
}

async function loadDeviceInfo() {
    try {
        const res = await fetch('/api/mixer');
        if (!res.ok) return;
        const data = await res.json();
        if (!data.success) return;

        const det = data.detection;
        const profile = det.profile;

        if (elements.settingMixer) {
            if (profile) {
                elements.settingMixer.textContent = profile.name;
                elements.settingMixer.title =
                    `${profile.usb_in}ch in · ${profile.usb_out}ch out · ` +
                    `${profile.sample_rates.join('/')} Hz · ${profile.bit_format}`;
            } else {
                elements.settingMixer.textContent = 'Unknown (no profile matched)';
            }
        }

        if (profile) {
            if (elements.settingBitrate) {
                elements.settingBitrate.textContent =
                    `${profile.total_bit_rate_mbps} Mbps`;
                elements.settingBitrate.title =
                    `${profile.bit_rate_per_channel_kbps} kbps per channel`;
            }
            if (elements.settingStorage) {
                const gbHr = profile.storage_per_hour_gb;
                // Also show per-channel for reference
                const perCh = (profile.storage_per_hour_gb / (profile.usb_in || 1));
                elements.settingStorage.textContent =
                    `${gbHr} GB / hr`;
                elements.settingStorage.title =
                    `≈ ${perCh.toFixed(2)} GB/hr per channel  ·  ` +
                    `Uncompressed WAV at active settings`;
            }
        }

        if (elements.settingDevice) {
            elements.settingDevice.textContent = det.device_name || 'system default';
        }

        if (elements.settingOsc) {
            elements.settingOsc.textContent = det.osc_reachable ? '✓ Reachable' : '✗ Not reachable';
            elements.settingOsc.style.color = det.osc_reachable
                ? 'var(--success-color, #4caf50)'
                : 'var(--text-secondary)';
        }

        if (elements.settingDetection) {
            const methodLabels = {
                osc: 'OSC /xinfo',
                osc_unknown: 'OSC (model unknown)',
                usb: 'USB device name',
                highest_channels: 'Highest channel count',
                default: 'System default',
                manual: 'Manual (config)',
            };
            elements.settingDetection.textContent = methodLabels[det.method] || det.method;
        }

    } catch (error) {
        // Non-critical - detection info is informational only
    }
}

async function loadStatus() {
    try {
        const status = await recorder.getStatus();
        
        // Update disk space - annotate with estimated recording time if bit rate known
        if (status.disk_space) {
            const freeGB = (status.disk_space.free / (1024 ** 3));
            const totalGB = (status.disk_space.total / (1024 ** 3)).toFixed(1);

            // Estimated recording time remaining based on active bit rate
            let timeAnnotation = '';
            if (status.audio_device && status.audio_device.storage_per_hour_gb) {
                const gbPerHr = status.audio_device.storage_per_hour_gb;
                const hoursLeft = freeGB / gbPerHr;
                timeAnnotation = ` (~${hoursLeft.toFixed(1)} hr left)`;
            }

            const color = freeGB < 10 ? 'var(--warning-color, #ff9800)' : '';
            elements.diskSpace.textContent =
                `${freeGB.toFixed(1)} / ${totalGB} GB${timeAnnotation}`;
            elements.diskSpace.style.color = color;
        }
        
        // Update recording status
        if (status.recording) {
            if (status.recording.is_recording) {
                recorder.takeDisplayName = (status.recording.take_display_name || '').trim();
                elements.btnRecord.classList.add('recording');
                syncRecordTransportAvailability();
                if (elements.btnMarker) elements.btnMarker.disabled = false;
                elements.recordingStatus.textContent = 'Recording'; elements.recordingStatus.classList.add('recording');

                recorder.isRecording = true;
                recorder.recordingStartTime = Date.now() - (status.recording.duration * 1000);
                recorder.startTimer();
            } else {
                recorder.takeDisplayName = '';
            }
        }
        _updateTakeLine();
        
        // Load sessions
        sessionsManager.loadSessions();

        syncRecordTransportAvailability();
        
    } catch (error) {
        console.error('Failed to load status:', error);
    }
}


function updateConnectionStatus(connected) {
    if (connected) {
        elements.connectionStatus.classList.add('connected');
        elements.connectionStatus.classList.remove('disconnected');
        elements.connectionText.textContent = '';
        syncRecordTransportAvailability();
    } else {
        elements.connectionStatus.classList.add('disconnected');
        elements.connectionStatus.classList.remove('connected');
        elements.connectionText.textContent = 'Disconnected';
        if (elements.btnMarker) elements.btnMarker.disabled = true;
        syncRecordTransportAvailability();
    }
}

function addMarkerToList(marker) {
    if (!elements.markersList) return;
    // Remove empty message if present
    const emptyMessage = elements.markersList.querySelector('.empty-message');
    if (emptyMessage) {
        emptyMessage.remove();
    }
    
    // Create marker item
    const item = document.createElement('div');
    item.className = 'marker-item';
    
    const time = document.createElement('span');
    time.className = 'marker-time';
    time.textContent = recorder.formatTime(Math.floor(marker.time));
    
    const label = document.createElement('span');
    label.className = 'marker-label';
    label.textContent = marker.label || '(no label)';
    
    item.appendChild(time);
    item.appendChild(label);
    
    elements.markersList.appendChild(item);
}

function clearMarkersList() {
    if (!elements.markersList) return;
    elements.markersList.innerHTML = '<p class="empty-message">No markers yet</p>';
}

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
    // Space: Record/Stop
    if (e.code === 'Space' && !e.target.matches('input, textarea')) {
        e.preventDefault();
        if (recorder.isRecording) {
            handleStopClick();
        } else if (!elements.btnRecord.disabled) {
            handleRecordClick();
        }
    }
    
    // M: marker hotkey — off while MARK button is hidden (see #btn-marker in style.css)
});
