/**
 * storage.js — System tab: drive info cards + exFAT format tool + Reboot
 *
 * Safety: the Format section is NEVER rendered for the local SD card (type !== 'usb').
 * The backend also independently enforces this at the API level.
 */

const storageTab = {
    _loaded: false,

    /** Called when the System tab is clicked. Loads/refreshes drive cards. */
    async load() {
        const list = document.getElementById('storage-drives-list');
        if (!list) return;
        list.innerHTML = '<p class="empty-message">Scanning drives…</p>';
        
        // Wire up reboot button if not already done
        const rebootBtn = document.getElementById('btn-system-reboot');
        if (rebootBtn && !this._buttonsWired) {
            rebootBtn.onclick = () => this.rebootSystem();
            this._buttonsWired = true;
        }

        try {
            const res  = await fetch('/api/storage/locations');
            const data = await res.json();
            if (!data.success || !data.locations || data.locations.length === 0) {
                list.innerHTML = '<p class="empty-message">No drives detected.</p>';
                return;
            }
            list.innerHTML = '';
            data.locations.forEach(loc => {
                list.appendChild(this._buildCard(loc, data.required_mbps));
            });
            this._loaded = true;
        } catch (e) {
            list.innerHTML = `<p class="empty-message">Error loading drives: ${e.message}</p>`;
        }
    },

    async rebootSystem() {
        if (!confirm("Are you sure you want to REBOOT the Raspberry Pi? Recording will stop.")) return;
        try {
            const res = await fetch('/api/system/reboot', { method: 'POST' });
            const data = await res.json();
            if (data.success) {
                alert("System is rebooting. Please wait 1-2 minutes then refresh.");
            } else {
                alert("Error: " + data.message);
            }
        } catch (e) {
            alert("Network error: " + e.message);
        }
    },

    /** Build a single drive info card element. */
    _buildCard(loc, requiredMbps) {
        const card = document.createElement('div');
        card.className = 'storage-drive-card' +
            (loc.type === 'usb' ? ' storage-drive-card--usb' : '') +
            (loc.active ? ' storage-drive-card--active' : '');
        card.dataset.path   = loc.path;
        card.dataset.device = loc.device || '';

        const icon      = loc.type === 'usb' ? '🔌' : '💾';
        const activeBadge = loc.active
            ? '<span class="storage-active-badge">● recording here</span>' : '';
        const fsBadge   = this._fsBadge(loc.fs_type);
        const speedTxt  = loc.write_mbps > 0
            ? `${loc.write_mbps} MB/s` : 'untested';
        const speedWarn = loc.write_mbps > 0 && !loc.sufficient
            ? ' <span class="storage-speed-warn">⚠ slow</span>' : '';
        const usagePct  = loc.percent_used || 0;
        const usageColor = usagePct > 85 ? 'var(--record-color)'
                         : usagePct > 65 ? 'var(--warn-color)'
                         : 'var(--accent)';

        card.innerHTML = `
            <div class="storage-card-header">
                <span class="storage-card-icon">${icon}</span>
                <span class="storage-card-label">${loc.label}</span>
                ${fsBadge}
                ${activeBadge}
            </div>
            <div class="storage-card-meta">
                ${loc.free_gb} GB free of ${loc.total_gb} GB
                &nbsp;·&nbsp; ${speedTxt}${speedWarn}
            </div>
            <div class="storage-usage-bar">
                <div class="storage-usage-fill"
                     style="width:${usagePct}%; background:${usageColor}"></div>
            </div>
            <div class="storage-usage-label">${usagePct}% used</div>
        `;

        // Speed test — available for all drives
        card.appendChild(this._buildBenchmarkSection(loc));

        // Format section — ONLY for external USB drives, never for local SD
        if (loc.type === 'usb') {
            card.appendChild(this._buildFormatSection(loc));
        }

        return card;
    },

    /** Build the write-speed benchmark section for a drive. */
    _buildBenchmarkSection(loc) {
        const wrap = document.createElement('div');
        wrap.className = 'storage-bench-section';

        const sizes = [
            { mb: 16,  label: '16 MB (quick)' },
            { mb: 64,  label: '64 MB (standard)' },
            { mb: 256, label: '256 MB (thorough)' },
        ];
        const optHtml = sizes.map((s, i) =>
            `<option value="${s.mb}" ${i === 1 ? 'selected' : ''}>${s.label}</option>`
        ).join('');

        wrap.innerHTML = `
            <div class="storage-bench-row">
                <select class="storage-bench-size">${optHtml}</select>
                <button class="storage-bench-btn btn-util btn btn-small">⚡ Test Speed</button>
                <span class="storage-bench-result"></span>
            </div>
        `;

        const btn    = wrap.querySelector('.storage-bench-btn');
        const sel    = wrap.querySelector('.storage-bench-size');
        const result = wrap.querySelector('.storage-bench-result');

        btn.addEventListener('click', async () => {
            const sizeMb = parseInt(sel.value, 10);
            btn.disabled = true;
            btn.textContent = `⏳ Testing ${sizeMb} MB…`;
            result.textContent = '';
            result.className = 'storage-bench-result';

            try {
                const res  = await fetch('/api/storage/benchmark', {
                    method:  'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body:    JSON.stringify({ path: loc.path, size_mb: sizeMb }),
                });
                const d = await res.json();
                if (d.success) {
                    const ratingCls = {
                        excellent: 'bench-excellent',
                        good:      'bench-good',
                        marginal:  'bench-marginal',
                        'too slow':'bench-slow',
                    }[d.rating] || '';
                    const req = d.required_mbps
                        ? ` (need ≥ ${d.required_mbps} MB/s for ${d.required_mbps > 0 ? 'current quality' : ''})`
                        : '';
                    result.textContent = `${d.write_mbps} MB/s — ${d.rating}${req}`;
                    result.className   = `storage-bench-result ${ratingCls}`;
                } else {
                    result.textContent = `✗ ${d.error}`;
                    result.className   = 'storage-bench-result bench-slow';
                }
            } catch (e) {
                result.textContent = `✗ ${e.message}`;
                result.className   = 'storage-bench-result bench-slow';
            }

            btn.disabled    = false;
            btn.textContent = '⚡ Test Speed';
        });

        return wrap;
    },

    /** Filesystem type badge. */
    _fsBadge(fsType) {
        const fs   = (fsType || '').toLowerCase();
        const cls  = fs === 'exfat' ? 'storage-fs-badge--exfat'
                   : fs === 'vfat'  ? 'storage-fs-badge--vfat'
                   : fs === 'ntfs'  ? 'storage-fs-badge--ntfs'
                   :                  'storage-fs-badge--other';
        const text = fs || '?';
        return `<span class="storage-fs-badge ${cls}">${text}</span>`;
    },

    /** Build the expandable Format section for USB drives only. */
    _buildFormatSection(loc) {
        const section = document.createElement('div');
        section.className = 'storage-fmt-section';

        const isRecording = window.recorder && window.recorder.isRecording;
        const defaultLabel = loc.label.replace(/^USB:\s*/i, '').replace(/[^A-Za-z0-9\-]/g, '')
                                      .toUpperCase().slice(0, 11) || 'MUSICPI';

        section.innerHTML = `
            <button class="storage-fmt-toggle" type="button">
                ▶ Format drive…
            </button>
            <div class="storage-fmt-body" style="display:none">
                <div class="storage-fmt-warn">
                    ⚠ WARNING: Formatting permanently erases ALL data on this drive.
                    This cannot be undone. Back up any recordings first.
                </div>
                <div class="storage-fmt-info">
                    Formats as <strong>exFAT</strong> — readable on Mac, Windows &amp; Linux,
                    no file-size limit.
                </div>
                <div class="storage-fmt-label-row">
                    <label class="storage-fmt-label-lbl">Drive label:</label>
                    <input class="storage-fmt-label-input" type="text"
                           maxlength="11" value="${defaultLabel}"
                           placeholder="MUSICPI" spellcheck="false"
                           style="text-transform:uppercase">
                </div>
                <button class="storage-fmt-btn" type="button"
                        ${isRecording ? 'disabled' : ''}
                        title="${isRecording ? 'Cannot format while recording' : 'Permanently erase and reformat this drive as exFAT'}">
                    Format as exFAT
                </button>
                <div class="storage-fmt-status"></div>
            </div>
        `;

        // Toggle expand/collapse
        const toggle = section.querySelector('.storage-fmt-toggle');
        const body   = section.querySelector('.storage-fmt-body');
        toggle.addEventListener('click', () => {
            const open = body.style.display !== 'none';
            body.style.display = open ? 'none' : 'block';
            toggle.textContent = (open ? '▶' : '▼') + ' Format drive\u2026';
        });

        const btn    = section.querySelector('.storage-fmt-btn');
        const input  = section.querySelector('.storage-fmt-label-input');
        const status = section.querySelector('.storage-fmt-status');

        btn.addEventListener('click', () => {
            const label = (input.value.trim().replace(/[^A-Za-z0-9\-]/g, '').toUpperCase().slice(0, 11)) || 'MUSICPI';
            this._confirmAndFormat(loc.path, loc.device, label, 'exfat', btn, status);
        });

        return section;
    },

    /** Show confirmation then POST to /api/storage/format. */
    async _confirmAndFormat(path, device, label, fsFormat, btn, statusEl) {
        const driveName = path.split('/').pop();
        const fsName = { exfat: 'exFAT', ext4: 'ext4', hfsplus: 'HFS+', vfat: 'FAT32' }[fsFormat] || fsFormat;
        const msg = `This will permanently erase ALL data on "${driveName}" and format it as ${fsName} with label "${label}".\n\nThis cannot be undone. Are you sure?`;
        if (!window.confirm(msg)) return;

        // ── Start progress UI ─────────────────────────────────────────────
        btn.disabled    = true;
        btn.textContent = `Formatting as ${fsName}…`;
        statusEl.textContent = '';
        statusEl.className   = 'storage-fmt-status';

        // Insert animated progress bar + elapsed timer above the status line
        const progressWrap = document.createElement('div');
        progressWrap.className = 'storage-fmt-progress';
        progressWrap.innerHTML = `
            <div class="storage-fmt-bar"><div class="storage-fmt-bar-fill"></div></div>
            <span class="storage-fmt-elapsed">0s</span>
        `;
        statusEl.parentNode.insertBefore(progressWrap, statusEl);

        const elapsedEl = progressWrap.querySelector('.storage-fmt-elapsed');
        const t0 = Date.now();
        const timer = setInterval(() => {
            elapsedEl.textContent = `${Math.round((Date.now() - t0) / 1000)}s`;
        }, 1000);

        // ── Call API ──────────────────────────────────────────────────────
        try {
            const res  = await fetch('/api/storage/format', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ path, device, label, fs_format: fsFormat }),
            });
            const data = await res.json();
            const elapsed = Math.round((Date.now() - t0) / 1000);

            clearInterval(timer);
            progressWrap.remove();

            if (data.success) {
                statusEl.textContent = `✓ ${data.message} (${elapsed}s)`;
                statusEl.className   = 'storage-fmt-status storage-fmt-status--ok';
                btn.textContent      = `Format as ${fsName}`;
                btn.disabled         = false;
                setTimeout(() => {
                    this.load();
                    if (typeof loadStorageLocations === 'function') loadStorageLocations();
                }, 1500);
            } else {
                statusEl.textContent = `✗ ${data.error || 'Format failed'}`;
                statusEl.className   = 'storage-fmt-status storage-fmt-status--err';
                btn.textContent      = `Format as ${fsName}`;
                btn.disabled         = false;
            }
        } catch (e) {
            clearInterval(timer);
            progressWrap.remove();
            statusEl.textContent = `✗ Network error: ${e.message}`;
            statusEl.className   = 'storage-fmt-status storage-fmt-status--err';
            btn.textContent      = `Format as ${fsName}`;
            btn.disabled         = false;
        }
    },
};

/** Wire up the System tab click to load drive cards lazily. */
function initSystemTab() {
    const tabBtn = document.querySelector('[data-tab="storage"]');
    if (!tabBtn) return;
    tabBtn.addEventListener('click', () => {
        storageTab.load();
    });
}
