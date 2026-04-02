/**
 * LevelMeters — console/DAW-style channel strip renderer
 */

class LevelMeters {
    constructor(containerId, channelCount, channelNames) {
        this.container     = document.getElementById(containerId);
        this.channelCount  = channelCount;
        this.channelNames  = channelNames || [];
        this.meters        = [];
        this._armed           = this._loadArmedState(channelCount);
        this._presetLocked    = false;
        this._presetAllowedSet = null;  // null = Custom (all channels allowed)
        this.init();
    }

    // ── Persistence ────────────────────────────────────────────────────────
    _loadArmedState(count) {
        try {
            const saved = localStorage.getItem('musicpi_armed_channels');
            if (saved) {
                const arr = JSON.parse(saved);
                while (arr.length < count) arr.push(true);
                return arr.slice(0, count);
            }
        } catch (_) {}
        return Array(count).fill(true);
    }

    _saveArmedState() {
        try {
            localStorage.setItem('musicpi_armed_channels', JSON.stringify(this._armed));
        } catch (_) {}
    }

    // ── Init ───────────────────────────────────────────────────────────────
    init() {
        this.container.innerHTML = '';
        for (let i = 0; i < this.channelCount; i++) {
            const meter = this._createStrip(i);
            this.meters.push(meter);
            this.container.appendChild(meter.element);
            this._applyArmVisual(i);  // reflect saved state
        }
        // After layout is painted, check which names overflow and need marquee
        requestAnimationFrame(() => this.refreshAllNameScrolls());
    }

    // ── Name-scroll helpers ────────────────────────────────────────────────
    _refreshNameScroll(el) {
        el.classList.remove('ch-name--scroll');
        el.style.removeProperty('--scroll-px');
        const overflow = el.scrollWidth - el.clientWidth;
        if (overflow > 3) {
            el.style.setProperty('--scroll-px', `-${overflow}px`);
            el.classList.add('ch-name--scroll');
        }
    }

    refreshAllNameScrolls() {
        this.meters.forEach(m => this._refreshNameScroll(m.label));
    }

    _createStrip(idx) {
        // Ch 17 (index 16) and Ch 18 (index 17) are always the XR18's Main L/R USB send
        const _XR18_DEFAULTS = { 16: 'Main L', 17: 'Main R' };
        const name = this.channelNames[idx] || _XR18_DEFAULTS[idx] || `Ch ${idx + 1}`;

        // Root strip
        const el = document.createElement('div');
        el.className = 'ch-strip' + (this._armed[idx] ? ' ch-strip--armed' : '');
        el.dataset.channel = idx + 1;

        // Channel number
        const num = document.createElement('div');
        num.className = 'ch-num';
        num.textContent = idx + 1;

        // Channel name
        const nameEl = document.createElement('div');
        nameEl.className = 'ch-name';
        nameEl.textContent = name;
        nameEl.title = name;

        // Status badges (mute / phantom / gate / comp)
        const badges = document.createElement('div');
        badges.className = 'ch-badges';

        // VU meter bar
        const bar = document.createElement('div');
        bar.className = 'ch-meter-bar';

        const fill = document.createElement('div');
        fill.className = 'ch-meter-fill';
        fill.style.height = '0%';

        const peak = document.createElement('div');
        peak.className = 'ch-meter-peak';
        peak.style.bottom = '0%';

        bar.appendChild(fill);
        bar.appendChild(peak);

        // dB readout
        const dbVal = document.createElement('div');
        dbVal.className = 'ch-db-val';
        dbVal.textContent = '−∞';

        // ARM / REC dot button
        const armBtn = document.createElement('button');
        armBtn.className = 'ch-arm-btn' + (this._armed[idx] ? ' armed' : '');
        armBtn.setAttribute('aria-label', 'Toggle arm');
        armBtn.title = 'Toggle track arm for recording';
        armBtn.addEventListener('click', () => this._toggleArm(idx));

        el.appendChild(num);
        el.appendChild(nameEl);
        el.appendChild(badges);
        el.appendChild(bar);
        el.appendChild(dbVal);
        el.appendChild(armBtn);

        // In mobile view the arm button is hidden — tap the whole tile to toggle arm
        el.addEventListener('click', (e) => {
            if (!document.body.classList.contains('mobile-view')) return;
            if (e.target === armBtn) return; // avoid double-fire if button ever becomes visible
            this._toggleArm(idx);
        });

        return { element: el, label: nameEl, badges, fill, peak, value: dbVal, armBtn };
    }

    // ── ARM management ─────────────────────────────────────────────────────
    _toggleArm(idx) {
        // In preset mode, block toggling channels outside the allowed range entirely.
        // Channels inside the range (allowed) can be freely armed/disarmed.
        if (this._presetAllowedSet && !this._presetAllowedSet.has(idx)) return;
        if (this._recording) {
            // Mid-recording: only allow un-arming (stopping) an active channel
            if (!this._armed[idx]) return;
            this._armed[idx] = false;
            this._applyArmVisual(idx);
            this._saveArmedState();
            // Disable the button — can't re-arm the same channel in this take
            this.meters[idx].armBtn.disabled = true;
            this.meters[idx].armBtn.textContent = 'REC';
            // Tell the server to close this channel's file writer
            fetch(`/api/recording/channel/${idx + 1}`, { method: 'DELETE' })
                .catch(() => {});
            return;
        }
        this._armed[idx] = !this._armed[idx];
        this._applyArmVisual(idx);
        this._saveArmedState();
    }

    _applyArmVisual(idx) {
        const m = this.meters[idx];
        if (!m) return;
        const armed = this._armed[idx];
        m.armBtn.classList.toggle('armed', armed);
        m.element.classList.toggle('ch-strip--armed', armed);
        m.element.classList.toggle('ch-strip--disarmed', !armed);
    }

    /** True if channel i is currently muted on the mixer */
    _isMuted(i) {
        return !!this.meters[i]?.element.classList.contains('ch-strip--muted');
    }

    armAll() {
        for (let i = 0; i < this._armed.length; i++) {
            this._armed[i] = !this._isMuted(i);
        }
        this.meters.forEach((_, i) => this._applyArmVisual(i));
        this._saveArmedState();
    }

    armNone() {
        this._armed.fill(false);
        this.meters.forEach((_, i) => this._applyArmVisual(i));
        this._saveArmedState();
    }

    /** Arm only channels startCh..endCh (1-based, inclusive), disarm the rest.
     *  Muted channels within the range are skipped. */
    armRange(startCh, endCh) {
        for (let i = 0; i < this._armed.length; i++) {
            const inRange = (i + 1 >= startCh && i + 1 <= endCh);
            this._armed[i] = inRange && !this._isMuted(i);
        }
        this.meters.forEach((_, i) => this._applyArmVisual(i));
        this._saveArmedState();
    }

    getArmedChannels() {
        return this._armed
            .map((on, i) => (on ? i + 1 : null))
            .filter(n => n !== null);
    }

    /** Legacy alias kept for call-sites that still use it. */
    setArmLocked(locked) {
        this.setRecordingMode(locked);
    }

    /**
     * Set the preset's allowed channel range.
     * allowedSet — a Set of 0-based channel indices that are part of the preset,
     *              or null for Custom (all channels freely toggleable).
     *
     * Channels INSIDE the set: REC button always enabled — engineer can arm or
     *   disarm them freely, including re-arming after a disarm.
     * Channels OUTSIDE the set: REC button disabled with tooltip.
     * Has no effect during active recording — setRecordingMode() takes precedence.
     */
    setPresetRange(allowedSet) {
        this._presetAllowedSet = allowedSet || null;
        this._presetLocked     = !!allowedSet;
        if (this._recording) return;
        this.meters.forEach((m, i) => {
            if (!m.armBtn) return;
            const allowed = !allowedSet || allowedSet.has(i);
            m.armBtn.disabled = !allowed;
            m.armBtn.title = allowed
                ? 'Toggle track arm for recording'
                : 'Excluded by preset — switch to Custom to add this channel';
            // Excluded strips: keep meter visible — only the locked REC button
            // signals exclusion. The class is removed when preset is cleared.
            m.element.classList.toggle('ch-strip--preset-excluded', !allowed);
        });
    }

    /** Legacy shim — kept so existing call-sites don't break. */
    setPresetLocked(locked) {
        if (!locked) {
            this.setPresetRange(null);
            // Clear any lingering exclusion classes
            this.meters.forEach(m => m.element.classList.remove('ch-strip--preset-excluded'));
        }
    }

    /**
     * Enter / leave recording mode.
     * - Armed channels: REC button stays enabled but triggers an API un-arm call.
     * - Unarmed channels: REC button is disabled (can't arm a new channel mid-take).
     */
    setRecordingMode(active) {
        this._recording = active;
        this.meters.forEach((m, i) => {
            if (active) {
                if (this._armed[i]) {
                    m.armBtn.disabled = false;
                    m.armBtn.title = 'Click to stop recording this channel';
                } else {
                    m.armBtn.disabled = true;   // can't add a new channel mid-take
                }
            } else {
                m.armBtn.disabled = false;
                m.armBtn.textContent = 'REC';
                m.armBtn.title = 'Toggle track arm for recording';
            }
        });
    }

    // ── OSC channel strip data ─────────────────────────────────────────────
    updateStrip(channelIndex, strip) {
        if (channelIndex >= this.meters.length) return;
        const m = this.meters[channelIndex];

        if (strip.name) {
            m.label.textContent = strip.name;
            m.label.title = strip.name;
        }

        m.element.classList.toggle('ch-strip--muted', !!strip.muted);

        // Auto-disarm muted channels (only when not actively recording)
        if (strip.muted && !this._recording && this._armed[channelIndex]) {
            this._armed[channelIndex] = false;
            this._applyArmVisual(channelIndex);
            this._saveArmedState();
        }

        // Rebuild badges
        m.badges.innerHTML = '';
        const addBadge = (text, cls, tip) => {
            const b = document.createElement('span');
            b.className = `badge badge--${cls}`;
            b.textContent = text;
            b.title = tip;
            m.badges.appendChild(b);
        };
        if (strip.muted)   addBadge('M',   'mute',    'Muted on mixer — disarmed');
        if (strip.phantom) addBadge('48V', 'phantom', '48V Phantom power');
        if (strip.gate_on) addBadge('G',   'gate',    'Gate engaged');
        if (strip.comp_on) addBadge('C',   'comp',    'Compressor engaged');
        if (!strip.eq_on)  addBadge('EQ☓', 'eq-off',  'EQ bypassed');
    }

    applyChannelStrips(channels) {
        channels.forEach((ch, i) => {
            if (i < this.meters.length) this.updateStrip(i, ch);
        });
    }

    updateChannelNames(names) {
        this.channelNames = names;
        const _XR18_DEFAULTS = { 16: 'Main L', 17: 'Main R' };
        this.meters.forEach((m, i) => {
            m.label.textContent = names[i] || _XR18_DEFAULTS[i] || `Ch ${i + 1}`;
        });
        requestAnimationFrame(() => this.refreshAllNameScrolls());
    }

    // ── Level updates (dBFS values from server) ───────────────────────────
    /** Returns a Set of 0-based indices of currently armed channels */
    getArmedIndices() {
        const s = new Set();
        for (let i = 0; i < this._armed.length; i++) {
            if (this._armed[i]) s.add(i);
        }
        return s;
    }

    updateLevels(levels) {
        if (!levels || !levels.rms) return;
        const isMobile = document.body.classList.contains('mobile-view');

        for (let i = 0; i < this.channelCount; i++) {
            if (i >= this.meters.length) break;
            const m = this.meters[i];

            const rmsDb      = levels.rms?.[i]        ?? -90;
            const peakHoldDb = levels.peak_hold?.[i]  ?? levels.peak?.[i] ?? -90;
            const instDb     = levels.peak?.[i]        ?? rmsDb;

            if (!isMobile) {
                // Desktop: update VU meter bar, peak line, dB readout
                m.fill.style.height  = `${this.dbToPercent(rmsDb)}%`;
                m.peak.style.bottom  = `${this.dbToPercent(peakHoldDb)}%`;
                m.value.textContent  = instDb <= -89 ? '−∞' : `${Math.round(instDb)}`;
            }

            // Mobile: wiggle the top bar when armed and signal is present (> -60 dBFS)
            m.element.classList.toggle(
                'has-signal',
                isMobile && this._armed[i] && rmsDb > -60
            );
        }
    }

    dbToPercent(db) {
        const min = -60, max = 0;
        if (db <= min) return 0;
        if (db >= max) return 100;
        return ((db - min) / (max - min)) * 100;
    }
}
