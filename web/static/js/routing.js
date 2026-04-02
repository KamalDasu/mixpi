/**
 * Routing Module — Compact category summary view.
 *
 * Groups USB outputs into logical categories:
 *   USB 1-16  → Channel inputs (Analog, pre-fader)
 *   USB 17-18 → Main L/R (Post-fader stereo mix)
 *
 * Shows individual deviation rows if routing is non-standard.
 */

const TAP_COLOR = {
    analog:     '#ff5f5f',  // Red   — Analog pre-fader
    post_fader: '#00bcd4',  // Cyan  — Post fader (Main L/R)
    pre_fader:  '#e040fb',  // Pink  — Pre fader
    aux:        '#ff9800',  // Amber — Aux bus
    unknown:    '#666',
};

function tapInfo(label) {
    const l = (label || '').toLowerCase();
    if (l.startsWith('an') || l.startsWith('in') || l.includes('analog'))
        return { color: TAP_COLOR.analog,     tap: 'Pre-fader' };
    if (l.includes('main') || l === 'l' || l === 'r')
        return { color: TAP_COLOR.post_fader, tap: 'Post-fader' };
    if (l.startsWith('aux'))
        return { color: TAP_COLOR.aux,        tap: 'Aux' };
    if (l.startsWith('bus') || l.startsWith('effect'))
        return { color: TAP_COLOR.pre_fader,  tap: 'Bus' };
    return { color: TAP_COLOR.unknown, tap: '' };
}

function parsePairNums(label) {
    const m = (label || '').match(/(\d+)[^0-9]+(\d+)/);
    return m ? [parseInt(m[1]), parseInt(m[2])] : null;
}

class RoutingManager {
    constructor() {
        this._pairs     = [];
        this._sources   = [];
        this._oscOnline = false;
    }

    async load() {
        try {
            const res  = await fetch('/api/routing');
            const data = await res.json();
            this._sources   = data.sources || [];
            this._pairs     = data.pairs   || [];
            this._oscOnline = !!data.osc_connected;
            this._updateOscBadge();
            this._render();
        } catch (err) {
            console.error('RoutingManager.load error:', err);
            this._showError('Failed to load routing data.');
        }
    }

    setOscOnline(online) {
        this._oscOnline = online;
        this._updateOscBadge();
    }

    _updateOscBadge() {
        const badge = document.getElementById('routing-osc-badge');
        if (!badge) return;
        badge.textContent = this._oscOnline ? 'OSC online' : 'OSC offline';
        badge.className   = `routing-osc-badge ${this._oscOnline ? 'routing-osc-online' : 'routing-osc-offline'}`;
    }

    _render() {
        const container = document.getElementById('routing-grid');
        if (!container) return;

        if (!this._oscOnline || this._pairs.length === 0) {
            container.innerHTML = '<p class="empty-message">Connect OSC to mixer to view routing…</p>';
            return;
        }

        // ── Expand pairs into individual USB outputs 1-18 ────────────────────
        const usb = [];  // [{ usbNum, srcLabel, recommended }]
        this._pairs.forEach(pair => {
            const srcLabel = this._sources[pair.source] || '?';
            [pair.ch_a, pair.ch_b].forEach((usbNum, withinPair) => {
                const nums = parsePairNums(srcLabel);
                const l    = srcLabel.toLowerCase();
                let recommended = false;

                if (usbNum <= 16) {
                    // Standard: USB N → AN N (same number, pre-fader analog)
                    if ((l.startsWith('an') || l.includes('analog')) && nums) {
                        recommended = nums[withinPair] === usbNum;
                    }
                } else if (usbNum === 17) {
                    recommended = l.includes('main') && withinPair === 0;
                } else if (usbNum === 18) {
                    recommended = l.includes('main') && withinPair === 1;
                }

                usb.push({ usbNum, srcLabel, recommended });
            });
        });

        // ── Group into categories ─────────────────────────────────────────────
        const ch116  = usb.filter(u => u.usbNum >= 1  && u.usbNum <= 16);
        const ch1718 = usb.filter(u => u.usbNum >= 17 && u.usbNum <= 18);

        const allCh116Std  = ch116.every(u => u.recommended);
        const allCh1718Std = ch1718.every(u => u.recommended);

        // ── Build category rows ───────────────────────────────────────────────
        const rows = [];

        if (allCh116Std) {
            rows.push({
                range: 'USB 1 – 16',
                srcLabel: 'Analog In 1–16',
                tap: 'Pre-fader',
                color: TAP_COLOR.analog,
                ok: true,
                detail: '16 individual mono tracks — fader moves never affect these recordings',
            });
        } else {
            // Show each deviating USB individually under a "non-standard" header
            rows.push({ heading: 'USB 1–16 (non-standard — some channels differ)' });
            ch116.forEach(({ usbNum, srcLabel, recommended }) => {
                const { color, tap } = tapInfo(srcLabel);
                rows.push({
                    range: `USB ${usbNum}`,
                    srcLabel,
                    tap,
                    color,
                    ok: recommended,
                    detail: recommended ? '' : 'Change in X Air Edit → Routing → USB Send',
                });
            });
        }

        if (allCh1718Std) {
            rows.push({
                range: 'USB 17 – 18',
                srcLabel: 'Main L / Main R',
                tap: 'Post-fader',
                color: TAP_COLOR.post_fader,
                ok: true,
                detail: 'Stereo mix reference — reflects exactly what the audience hears',
            });
        } else {
            rows.push({ heading: 'USB 17–18 (non-standard)' });
            ch1718.forEach(({ usbNum, srcLabel, recommended }) => {
                const { color, tap } = tapInfo(srcLabel);
                rows.push({
                    range: `USB ${usbNum}`,
                    srcLabel,
                    tap,
                    color,
                    ok: recommended,
                    detail: recommended ? '' : 'Change in X Air Edit → Routing → USB Send',
                });
            });
        }

        // ── Recommendation banner ─────────────────────────────────────────────
        const allOk = allCh116Std && allCh1718Std;
        const banner = document.createElement('div');
        banner.className = `rsum-banner ${allOk ? 'rsum-banner-ok' : 'rsum-banner-warn'}`;
        banner.innerHTML = allOk
            ? `<span class="rsum-banner-icon">✓</span>
               <span>Optimal 18-channel setup detected. USB 1-16 capture individual analog inputs
               (pre-fader); USB 17-18 carry the Main L/R stereo mix — giving you all 16 mono
               tracks plus a full stereo reference in a single USB connection.</span>`
            : `<span class="rsum-banner-icon">⚠</span>
               <span>Routing differs from the recommended setup. To record 16 channels plus a stereo
               mix: set <strong>Routing › USB Send 1-16 → Analog In 1-16</strong> for individual
               tracks, then set <strong>USB 17 → Main L</strong> and
               <strong>USB 18 → Main R</strong> (pre- or post-fader) to capture the stereo mix.
               This uses all 18 USB channels for the full session.</span>`;

        // ── Render ────────────────────────────────────────────────────────────
        const table = document.createElement('table');
        table.className = 'rsum-table';

        rows.forEach(row => {
            if (row.heading) {
                const tr = document.createElement('tr');
                tr.innerHTML = `<td colspan="5" class="rsum-section-hdr">${row.heading}</td>`;
                table.appendChild(tr);
                return;
            }

            const badge = row.ok
                ? `<span class="rsum-ok">✓ Recommended</span>`
                : `<span class="rsum-warn">⚠ Non-standard</span>`;

            const tr = document.createElement('tr');
            tr.className = 'rsum-row';
            tr.innerHTML = `
                <td class="rsum-range">${row.range}</td>
                <td class="rsum-circle"><span style="color:${row.color};font-size:1.1rem">○</span></td>
                <td class="rsum-src">${row.srcLabel}</td>
                <td class="rsum-tap" style="color:${row.color}">${row.tap}</td>
                <td class="rsum-status">${badge}${row.detail ? `<span class="rsum-detail">${row.detail}</span>` : ''}</td>`;
            table.appendChild(tr);
        });

        container.innerHTML = '';
        container.appendChild(banner);
        container.appendChild(table);

        // ── Legend ────────────────────────────────────────────────────────────
        const legend = document.createElement('div');
        legend.className = 'rmx-legend';
        legend.innerHTML = `
            <span class="rmx-legend-item"><span style="color:${TAP_COLOR.analog}">○</span> Analog — Pre-fader individual inputs (Ch 1-16)</span>
            <span class="rmx-legend-item"><span style="color:${TAP_COLOR.post_fader}">○</span> Post-fader — Stereo mix as the audience hears it (Main L/R)</span>
            <span class="rmx-legend-item"><span style="color:${TAP_COLOR.aux}">○</span> Aux bus</span>`;
        container.appendChild(legend);
    }

    _showError(msg) {
        const g = document.getElementById('routing-grid');
        if (g) g.innerHTML = `<p class="empty-message">${msg}</p>`;
    }
}

const routingManager = new RoutingManager();
