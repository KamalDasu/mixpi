/**
 * MusicPi Recorder Main Application
 * Coordinates UI, WebSocket, and recording functionality
 */

// Global instances
let socket;
let recorder;
let meters;

// UI Elements
const elements = {
    btnRecord: null,
    btnStop: null,
    btnMarker: null,
    btnResetPeaks: null,
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

// Initialize application
document.addEventListener('DOMContentLoaded', () => {
    console.log('MusicPi Recorder starting...');

    initElements();
    initViewToggle();    // mobile/desktop view toggle (must run before initTabs)
    initTabs();          // wire up bottom-panel tabs
    initDiscovery();     // network discovery panel
    initSystemTab();     // wire up System tab lazy load

    recorder = new Recorder();
    recorder._initTimeline();   // draw idle waveform on load
    initWebSocket();
    setupEventListeners();
    loadConfig();
    loadStorageLocations();  // populate STORAGE dropdown (includes write-speed benchmark)
});

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

/** Return an inline SVG mixer icon sized to fit the discovery bar. */
function _xairMixerSVG(model) {
    const m = (model || '').toUpperCase();
    const ch = m.includes('18') ? 18 : m.includes('16') ? 16 : m.includes('12') ? 12 : 0;
    const label = ch ? `${ch}CH` : 'XAIR';
    // Minimal rack-unit mixer board representation
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

const discovery = {
    _scanning: false,
    _found: false,        // true once a mixer has been confirmed via OSC
    _retryTimer: null,    // interval handle for OSC retry-when-not-found
    _usbTimer:   null,    // interval handle for USB polling

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

    async scan(isManual = false) {
        if (this._scanning) return;
        this._scanning = true;

        const dot  = document.getElementById('disc-xair-dot');
        const val  = document.getElementById('disc-xair-val');
        const icon = document.getElementById('disc-xair-icon');
        const btn  = document.getElementById('btn-disc-scan');

        if (isManual || !this._found) {
            if (dot)  dot.className = 'disc-dot disc-dot--search';
            if (val)  val.textContent = 'Searching…';
            if (icon) icon.innerHTML = '';
        }
        if (btn) { btn.disabled = true; btn.textContent = '⟳ Scanning…'; }

        try {
            const res = await fetch('/api/discover?timeout=3',
                { signal: AbortSignal.timeout(6000) });
            const d = await res.json();
            if (d.success && d.mixers && d.mixers.length > 0) {
                const m = d.mixers[0];
                if (dot)  dot.className = 'disc-dot disc-dot--found';
                if (icon) icon.innerHTML = _xairMixerSVG(m.model);
                const model = m.model || 'XAir';
                const fw    = m.firmware ? ` fw${m.firmware}` : '';
                const fullText  = `${model}${fw} @ ${m.ip}`;
                const shortText = model;
                if (val) {
                    val.dataset.full  = fullText;
                    val.dataset.short = shortText;
                    val.textContent   = document.body.classList.contains('mobile-view')
                        ? shortText : fullText;
                    val.title = fullText;
                }
                if (icon) icon.title = `${model} — ${m.name || m.ip}${fw}`;

                // Tell the backend to connect/reconnect OSC to the discovered IP
                try {
                    const cr = await fetch('/api/osc/connect', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({ip: m.ip})
                    });
                    const cd = await cr.json();
                    const oscVal = document.getElementById('disc-osc-val');
                    const oscDot = document.getElementById('disc-osc-dot');
                    if (cd.connected) {
                        if (oscVal) oscVal.textContent = 'Live';
                        if (oscVal) oscVal.style.color = '#22c55e';
                        if (oscDot) oscDot.className = 'disc-dot disc-dot--found';
                        // Refresh channel names now that OSC is live
                        setTimeout(() => loadChannels(), 500);
                    } else {
                        if (oscVal) oscVal.textContent = m.ip;
                        if (oscVal) oscVal.style.color = '#888';
                    }
                } catch (_) {}

                if (!this._found) {
                    this._found = true;
                    if (this._retryTimer) {
                        clearInterval(this._retryTimer);
                        this._retryTimer = null;
                    }
                }
            } else {
                if (dot)  dot.className = 'disc-dot disc-dot--error';
                if (val)  val.textContent = 'Not found';
                if (icon) icon.innerHTML = '';
                this._found = false;
                if (!this._retryTimer) {
                    this._retryTimer = setInterval(() => this.scan(), 30000);
                }
            }
        } catch (_) {
            if (dot)  dot.className = 'disc-dot disc-dot--error';
            if (val)  val.textContent = 'Error';
            if (icon) icon.innerHTML = '';
            this._found = false;
        } finally {
            this._scanning = false;
            if (btn) { btn.disabled = false; btn.textContent = '⟳ Scan'; }
        }
    },

    /** Poll /api/devices/usb and update the USB status item */
    async pollUsb() {
        const dot = document.getElementById('disc-usb-dot');
        const val = document.getElementById('disc-usb-val');
        try {
            const res = await fetch('/api/devices/usb');
            const d   = await res.json();
            if (d.success && d.devices && d.devices.length > 0) {
                const dev = d.devices[0];
                // Show first matched device name, strip redundant vendor prefix
                const name      = dev.name.replace(/^(Behringer\s+)/i, '');
                const ch        = dev.input_channels ? ` · ${dev.input_channels}ch` : '';
                const fullText  = `${name}${ch}`;
                // Mobile short: recording channel count only (e.g. "18ch")
                const recCh     = dev.input_channels || 0;
                const shortText = recCh ? `${recCh}ch` : name;
                if (dot) dot.className = 'disc-dot disc-dot--ok';
                if (val) {
                    val.dataset.full  = fullText;
                    val.dataset.short = shortText;
                    val.textContent   = document.body.classList.contains('mobile-view')
                        ? shortText : fullText;
                    val.title = `${dev.name} — ${dev.input_channels} in / ${dev.output_channels} out @ ${dev.sample_rate} Hz`;
                }
                // If we found more than one mixer, hint it
                if (d.devices.length > 1) {
                    if (val) val.textContent += ` +${d.devices.length - 1}`;
                }
            } else {
                if (dot) dot.className = 'disc-dot disc-dot--error';
                if (val) val.textContent = 'Not connected';
                if (val) val.title = 'No known mixer USB audio device found';
            }
        } catch (_) {
            if (dot) dot.className = 'disc-dot disc-dot--error';
            if (val) val.textContent = 'Error';
        }
    },

    /** Update the OSC dot based on connection state text */
    updateOscDot(connected) {
        const dot = document.getElementById('disc-osc-dot');
        if (!dot) return;
        dot.className = connected
            ? 'disc-dot disc-dot--ok'
            : 'disc-dot disc-dot--search';
    },

    init() {
        this.loadNetwork();
        this.scan();
        this.pollUsb();
        // Re-check USB every 15 s (plug/unplug events)
        this._usbTimer = setInterval(() => this.pollUsb(), 15000);
        const btn = document.getElementById('btn-disc-scan');
        if (btn) btn.addEventListener('click', () => {
            this.scan(true);
            this.pollUsb();
            loadStorageLocations();   // re-detect USB drives on manual scan
        });
    }
};

function initDiscovery() {
    discovery.init();

    const btnNames = document.getElementById('btn-disc-names');
    if (btnNames) btnNames.addEventListener('click', async () => {
        btnNames.disabled = true;
        btnNames.textContent = '…';
        await loadChannels();
        btnNames.textContent = '↺ Labels';
        btnNames.disabled = false;
    });

    // Restart service button — tries soft audio restart first, full service restart if that fails
    const btnRestart = document.getElementById('btn-restart-service');
    if (btnRestart) btnRestart.addEventListener('click', async () => {
        const ok = await showConfirmRestart();
        if (!ok) return;
        btnRestart.disabled = true;
        btnRestart.textContent = '⏳ Restarting audio…';
        try {
            const res = await fetch('/api/monitoring/restart', { method: 'POST' });
            const d   = await res.json();
            if (d.success) {
                // Soft restart worked — just reload the page
                btnRestart.textContent = '✓ Audio restarted';
                setTimeout(() => window.location.reload(), 1200);
                return;
            }
        } catch (_) {}
        // Soft restart failed — do a full service restart
        btnRestart.textContent = '⏳ Service restart…';
        try {
            await fetch('/api/system/restart', { method: 'POST' });
        } catch (_) {}
        setTimeout(() => window.location.reload(), 4000);
    });

    // Auto-refresh channel names/strip data every 15 s when not recording
    setInterval(() => {
        if (!recorder || !recorder.isRecording) loadChannels();
    }, 15000);
}

function showConfirmRestart() {
    return new Promise(resolve => {
        if (confirm('Restart the MusicPi service?\n\nThis will interrupt any active recording and reload the page.')) {
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
    const invalid    = isMobile ? ['routing'] : [];
    
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

function initViewToggle() {
    const btn     = document.getElementById('btn-view-toggle');
    const homeEl  = document.getElementById('tab-home');
    const content = document.querySelector('.panel-content');
    if (!btn) return;

    // Determine starting view:
    //   1. Respect an explicit user preference saved in localStorage.
    //   2. Otherwise, auto-detect: mobile if the viewport is narrower than 768 px.
    const savedView  = localStorage.getItem('musicpi_view');
    const autoMobile = window.innerWidth < 768;
    const startMobile = savedView ? savedView === 'mobile' : autoMobile;

    if (startMobile) {
        document.body.classList.add('mobile-view');
        btn.textContent = 'Desktop';
        // initTabs() (which runs next) will call activateTab('home') and set up state
    }

    btn.addEventListener('click', () => {
        const enterMobile = !document.body.classList.contains('mobile-view');
        document.body.classList.toggle('mobile-view', enterMobile);
        btn.textContent = enterMobile ? 'Desktop' : 'Mobile';
        localStorage.setItem('musicpi_view', enterMobile ? 'mobile' : 'desktop');

        // Re-render discovery bar values for the new mode (short vs full)
        document.querySelectorAll('[data-full][data-short]').forEach(el => {
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
    });
}

function initElements() {
    elements.btnRecord = document.getElementById('btn-record');
    elements.btnStop = document.getElementById('btn-stop');
    elements.btnMarker = document.getElementById('btn-marker');
    elements.btnResetPeaks = document.getElementById('btn-reset-peaks');
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
    elements.inputNotes       = document.getElementById('input-notes');
    // Transport confirmed display
    elements.tptConfirmedName   = document.getElementById('tpt-confirmed-name');
    elements.tptConfirmedConfig = document.getElementById('tpt-confirmed-config');
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
    
    socket.on('disconnect', () => {
        console.log('WebSocket disconnected');
        updateConnectionStatus(false);
    });
    
    socket.on('levels', (data) => {
        if (meters) {
            meters.updateLevels(data);
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
}

function setupEventListeners() {
    elements.btnRecord.addEventListener('click', handleRecordClick);
    elements.btnStop.addEventListener('click', handleStopClick);
    elements.btnMarker.addEventListener('click', handleMarkerClick);
    elements.btnResetPeaks.addEventListener('click', handleResetPeaksClick);

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

    // Session name / notes / track — auto-save as the user types (no Apply needed)
    if (elements.inputSessionName) {
        elements.inputSessionName.addEventListener('input', () => {
            _savePrerecordState();
            _updateConfirmedDisplay();
            _flashSaved(elements.inputSessionName);
            _updateTrackPlaceholder();
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

/**
 * Persist ALL pre-record fields to the server (ui_state.json) so every
 * browser on the network sees the same state.
 * Also mirrors to localStorage as a fast offline fallback.
 */
function _savePrerecordState() {
    const state = {
        sessionName : (elements.inputSessionName && elements.inputSessionName.value) || '',
        notes       : (elements.inputNotes       && elements.inputNotes.value)       || '',
        trackName   : (elements.inputTrackName   && elements.inputTrackName.value)   || '',
        chPreset    : (elements.selectChPreset   && elements.selectChPreset.value)   || '',
        storagePath : (elements.selectStorage    && elements.selectStorage.value)    || '',
        quality     : (elements.selectQuality    && elements.selectQuality.value)    || '',
    };
    // localStorage — instant, no network
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (_e) {}
    // Server — shared across all browsers (fire-and-forget)
    fetch('/api/ui-state', {
        method:  'POST',
        headers: {'Content-Type': 'application/json'},
        body:    JSON.stringify(state),
    }).catch(() => {}); // non-critical
}

/**
 * Load UI state from the server, then fall back to localStorage.
 * Called once on page load AFTER presetManager.load() sets the active quality.
 */
async function _restorePrerecordState() {
    let s = {};
    let serverHasData = false;

    // 1. Try server first (shared state)
    try {
        const res  = await fetch('/api/ui-state');
        const data = await res.json();
        if (data.success && data.state && Object.keys(data.state).length > 0) {
            s = data.state;
            serverHasData = true;
        }
    } catch (_e) {}

    // 2. Fall back to localStorage if server returned nothing
    if (!serverHasData) {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (raw) s = JSON.parse(raw);
        } catch (_e) {}
    }

    // Apply: session name (default to 'session1' so the show folder always has a name)
    if (elements.inputSessionName)
        elements.inputSessionName.value = s.sessionName || 'session1';
    // Apply: notes
    if (s.notes && elements.inputNotes)
        elements.inputNotes.value = s.notes;
    // Apply: track/song name (do NOT restore — should be blank for each new page load
    // so the engineer is prompted to enter the next song name; placeholder shows auto-number)
    if (elements.inputTrackName)
        elements.inputTrackName.value = '';
    // Apply: channel preset + arm channels
    if (s.chPreset && elements.selectChPreset) {
        elements.selectChPreset.value = s.chPreset;
        _applyChPreset(s.chPreset);
    }
    // Apply: quality — only if it differs from server's active preset.
    // presetManager.load() already set the correct quality from /api/presets;
    // don't auto-apply — user must click Apply to change it.
    if (s.quality && elements.selectQuality && s.quality !== presetManager.activeId) {
        elements.selectQuality.value = s.quality;
    }

    // If server had no ui_state.json yet, bootstrap it now so the next
    // browser to load gets the same values (e.g. session name from localStorage).
    if (!serverHasData) {
        _savePrerecordState();
    }
    // Storage: loadStorageLocations() already restores this via server active flag
    // + the storagePath saved here. No extra call needed.
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
}

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
    } else {
        _markApplyPending();
    }
}

async function handleApplyConfig() {
    const btn = elements.btnApplyConfig;

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
    _clearRecordBlocked();
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
    if (elements.tptConfirmedConfig) elements.tptConfirmedConfig.textContent =
        `${tag} · ${armed} CH armed`;
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

async function handleRecordClick() {
    try {
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
            elements.btnRecord.disabled = false;
            return;
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

        // Update UI
        elements.btnRecord.classList.add('recording');
        elements.btnStop.disabled = false;
        elements.btnMarker.disabled = false;
        elements.recordingStatus.textContent = 'Recording'; elements.recordingStatus.classList.add('recording');
        
        
        // Clear markers list
        clearMarkersList();
        
    } catch (error) {
        alert(`Failed to start recording: ${error.message}`);
        elements.btnRecord.disabled = false;
    }
}

async function handleStopClick() {
    try {
        elements.btnStop.disabled = true;
        
        await recorder.stopRecording();

        // Unlock pre-record row and arm buttons
        if (meters) meters.setArmLocked(false);
        presetManager.lockDuringRecording(false);

        // Update UI
        elements.btnRecord.classList.remove('recording');
        elements.btnRecord.disabled = false;
        elements.btnMarker.disabled = true;
        elements.recordingStatus.textContent = 'Ready'; elements.recordingStatus.classList.remove('recording');
        

        // Clear the TRACK/SONG field — engineer should name the next song fresh
        if (elements.inputTrackName) {
            elements.inputTrackName.value = '';
            _updateTrackPlaceholder();
        }

        // Refresh session list so the new recording appears immediately
        setTimeout(() => sessionsManager.loadSessions(), 500);

    } catch (error) {
        alert(`Failed to stop recording: ${error.message}`);
        elements.btnStop.disabled = false;
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

function handleResetPeaksClick() {
    socket.emit('reset_peaks');
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
        elements.btnRecord.disabled = true;
        elements.btnStop.disabled = false;
        elements.btnMarker.disabled = false;
        elements.recordingStatus.textContent = 'Recording'; elements.recordingStatus.classList.add('recording');
        
        clearMarkersList();
    } catch (err) {
        console.error('Auto-start recording failed:', err);
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
        elements.btnRecord.disabled = false;
        elements.btnStop.disabled = true;
        elements.btnMarker.disabled = true;
        elements.recordingStatus.textContent = 'Ready'; elements.recordingStatus.classList.remove('recording');
        

        recorder.isRecording = false;
        recorder.stopTimer();
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
        meters = new LevelMeters('meters-container', config.audio.channels, config.channels.names);

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

    } catch (error) {
        console.error('Failed to load config:', error);
    }
}

async function loadChannels() {
    try {
        const res = await fetch('/api/channels');
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
        // Update discovery bar OSC status + dot
        const discOsc = document.getElementById('disc-osc-val');
        if (discOsc) {
            discOsc.textContent = data.osc_connected ? 'Live' : 'Offline';
            discOsc.style.color = data.osc_connected ? '#22c55e' : '#555';
        }
        discovery.updateOscDot(!!data.osc_connected);
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
                elements.btnRecord.classList.add('recording');
                elements.btnRecord.disabled = true;
                elements.btnStop.disabled = false;
                elements.btnMarker.disabled = false;
                elements.recordingStatus.textContent = 'Recording'; elements.recordingStatus.classList.add('recording');
                
                
                recorder.isRecording = true;
                recorder.recordingStartTime = Date.now() - (status.recording.duration * 1000);
                recorder.startTimer();
            }
        }
        
        // Load sessions
        sessionsManager.loadSessions();
        
    } catch (error) {
        console.error('Failed to load status:', error);
    }
}


function updateConnectionStatus(connected) {
    if (connected) {
        elements.connectionStatus.classList.add('connected');
        elements.connectionStatus.classList.remove('disconnected');
        elements.connectionText.textContent = 'Connected';
        elements.btnRecord.disabled = false;
    } else {
        elements.connectionStatus.classList.add('disconnected');
        elements.connectionStatus.classList.remove('connected');
        elements.connectionText.textContent = 'Disconnected';
        elements.btnRecord.disabled = true;
        elements.btnStop.disabled = true;
        elements.btnMarker.disabled = true;
    }
}

function addMarkerToList(marker) {
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
    
    // M: Add marker
    if (e.code === 'KeyM' && !e.target.matches('input, textarea')) {
        e.preventDefault();
        if (recorder.isRecording) {
            handleMarkerClick();
        }
    }
});
