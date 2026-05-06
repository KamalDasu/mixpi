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
        const exitKioskBtn = document.getElementById('btn-exit-kiosk');
        if (!this._buttonsWired) {
            if (rebootBtn) rebootBtn.onclick = () => this.rebootSystem();
            if (exitKioskBtn) exitKioskBtn.onclick = () => this.exitKiosk();
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

        // Initialize update functionality
        this._initUpdateUI();
        
        // Re-check updates when tab becomes visible (in case system was updated externally)
        this._setupVisibilityCheck();
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

    /** Close kiosk Chromium/Firefox on the Pi so the desktop is visible (localhost / same-host only). */
    async exitKiosk() {
        if (!confirm(
            'Close the fullscreen browser and show the Raspberry Pi desktop?\n\n'
            + 'MixPi keeps running. Use the desktop or Raspberry Pi Connect to open the browser again, or reboot.'
        )) return;
        try {
            const res = await fetch('/api/system/exit-kiosk', { method: 'POST' });
            const data = await res.json().catch(() => ({}));
            if (res.ok && data.success) {
                alert(data.message || 'Kiosk browser closing.');
            } else {
                alert(data.message || 'Could not exit kiosk.');
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

    /**
     * Label shown after "Up to date (" — package semver from API, else git tag / describe.
     */
    _upToDateLabel(data) {
        if (data.package_version) {
            return data.package_version;
        }
        const cur = data.current || {};
        if (cur.tag && /^v\d+\.\d+\.\d+$/.test(cur.tag)) {
            return cur.tag;
        }
        const d = cur.describe || '';
        const m = d.match(/^(v\d+\.\d+\.\d+)/);
        if (m) {
            return m[1];
        }
        return cur.commit || '';
    },

    /** True when HEAD is checked out at a semver stable tag (vX.Y.Z). */
    _isOnStableTag(data) {
        const tag = data.current && data.current.tag;
        return !!(tag && /^v\d+\.\d+\.\d+$/.test(tag));
    },

    /**
     * Primary status text when no newer stable tag is pending — emphasizes stable release vs main.
     *
     * When on main but ahead of the latest stable tag we format the git-describe string
     * (e.g. v1.0.2-2-g7a356d0) as "v1.0.2 +2 commits, 7a356d0" so it is unambiguous that
     * HEAD is not the stable release.
     */
    _upToDatePrimaryMessage(data) {
        if (this._isOnStableTag(data)) {
            const ver = this._upToDateLabel(data);
            return ver ? `Up to date — stable release (${ver})` : 'Up to date — stable release';
        }
        const br = data.current && data.current.branch;
        if (br === 'main') {
            const desc = data.current && data.current.describe;
            const m = desc && desc.match(/^(v[\d.]+)-(\d+)-g([0-9a-f]+)$/);
            if (m) {
                const stableTag = m[1];
                const n = parseInt(m[2], 10);
                const hash = m[3];
                const unit = n === 1 ? 'commit' : 'commits';
                return `Up to date — on main (${stableTag} +${n} ${unit}, ${hash})`;
            }
            const ver = this._upToDateLabel(data);
            return ver ? `Up to date — on main (${ver})` : 'Up to date — on main';
        }
        const ver = this._upToDateLabel(data);
        return ver ? `Up to date (${ver})` : 'Up to date';
    },

    /** Commits-ahead summary for beta (main), with singular/plural commit. */
    _formatBetaAhead(data) {
        const b = data.beta;
        if (!b || !b.available) {
            return '';
        }
        const n = b.commits_ahead || 0;
        const hash = (b.latest_commit || '').slice(0, 7);
        const unit = n === 1 ? 'commit' : 'commits';
        return `${n} ${unit} ahead (${hash})`;
    },

    /** Green strip below main status when origin/main is newer than HEAD (optional beta opt-in). */
    _setUpdateBetaLine(data) {
        const el = document.getElementById('update-status-beta-line');
        if (!el) return;
        if (!data || data.offline_mode || !data.beta || !data.beta.available) {
            el.classList.add('hidden');
            el.textContent = '';
            return;
        }
        const tail = this._formatBetaAhead(data);
        el.textContent = tail ? `Beta release available — ${tail}` : 'Beta release available';
        el.classList.remove('hidden');
    },

    _hideUpdateBetaLine() {
        const el = document.getElementById('update-status-beta-line');
        if (el) {
            el.classList.add('hidden');
            el.textContent = '';
        }
    },

    /** Set status line: fixed "MixPi Updates:" prefix (HTML) + dynamic state text. */
    _setUpdateStatus(stateClass, stateText) {
        const wrap = document.getElementById('update-status');
        const state = document.getElementById('update-status-state');
        if (state) {
            state.textContent = stateText;
        }
        if (wrap) {
            wrap.className = 'update-status ' + stateClass;
        }
    },

    /** Initialize the update UI and wire up event handlers. */
    async _initUpdateUI() {
        const updateSection = document.querySelector('.system-update-section');
        if (!updateSection) return;

        // Wire up event handlers
        const checkBtn = document.getElementById('check-updates-btn');
        const applyBtn = document.getElementById('apply-update-btn');
        const betaCheckbox = document.getElementById('beta-mode');
        const stableSelect = document.getElementById('stable-versions');

        if (checkBtn && !checkBtn._wired) {
            checkBtn.addEventListener('click', () => this.checkForUpdates());
            checkBtn._wired = true;
        }

        if (applyBtn && !applyBtn._wired) {
            applyBtn.addEventListener('click', () => this.applyUpdate());
            applyBtn._wired = true;
        }

        if (betaCheckbox && !betaCheckbox._wired) {
            betaCheckbox.addEventListener('change', () => this._updateApplyButtonState());
            betaCheckbox._wired = true;
        }

        if (stableSelect && !stableSelect._wired) {
            stableSelect.addEventListener('change', () => this._updateApplyButtonState());
            stableSelect._wired = true;
        }

        // Check PIN requirement and show/hide PIN entry
        try {
            const pinRes = await fetch('/api/system/update-pin-status', { cache: 'no-store' });
            const pinData = await pinRes.json();
            const pinEntry = document.getElementById('pin-entry');
            
            if (pinEntry) {
                if (pinData.success && pinData.pin_required) {
                    pinEntry.classList.remove('hidden');
                } else {
                    pinEntry.classList.add('hidden');
                }
            }
        } catch (e) {
            console.warn('Failed to check PIN status:', e);
        }

        // Auto-check for updates on load
        this.checkForUpdates();
    },

    /** Check for available updates and populate the UI. */
    async checkForUpdates() {
        const statusWrap = document.getElementById('update-status');
        const controlsEl = document.getElementById('update-controls');
        const checkBtn = document.getElementById('check-updates-btn');

        if (!statusWrap || !controlsEl) return;

        this._setUpdateStatus('checking', 'Checking…');
        this._hideUpdateBetaLine();
        controlsEl.classList.add('hidden');
        if (checkBtn) {
            checkBtn.disabled = true;
            checkBtn.textContent = 'Checking…';
        }

        try {
            const response = await fetch('/api/system/updates/check', { cache: 'no-store' });
            const data = await response.json();

            if (!data.success) {
                throw new Error(data.error || 'Update check failed');
            }

            this._populateUpdateOptions(data);

            const stablePending = typeof data.stable_update_available === 'boolean'
                ? data.stable_update_available
                : (data.stable && data.stable.length > 0);
            const betaPending = !!(data.beta && data.beta.available);

            if (data.offline_mode) {
                let statusText = `Offline — ${data.fetch_message}`;
                if (data.stable.length > 0) {
                    statusText += ` (${data.stable.length} cached)`;
                }
                this._setUpdateStatus('offline', statusText);
                this._hideUpdateBetaLine();
                if (checkBtn) {
                    checkBtn.textContent = 'Retry Check (Online)';
                    checkBtn.classList.add('btn-warning');
                }
            } else if (stablePending) {
                this._setUpdateStatus('available', 'Available');
                if (betaPending) {
                    this._setUpdateBetaLine(data);
                } else {
                    this._hideUpdateBetaLine();
                }
            } else if (betaPending) {
                this._setUpdateStatus('current', this._upToDatePrimaryMessage(data));
                this._setUpdateBetaLine(data);
            } else {
                this._setUpdateStatus('current', this._upToDatePrimaryMessage(data));
                this._hideUpdateBetaLine();
            }

            controlsEl.classList.remove('hidden');

            if (data.repo_status && (data.repo_status.history_diverged || data.repo_status.force_update_required)) {
                this._showRepoStatusWarning(data.repo_status);
            }
            
            // Update button text state
            if (checkBtn && !data.offline_mode) {
                checkBtn.textContent = 'Check for Updates';
                checkBtn.classList.remove('btn-warning');
            }

        } catch (error) {
            console.error('Update check failed:', error);
            this._hideUpdateBetaLine();
            const msg = error.message || String(error);
            this._setUpdateStatus(
                'error',
                msg.length > 100 ? 'Check failed — see console' : `Check failed — ${msg}`
            );
        } finally {
            if (checkBtn) {
                checkBtn.disabled = false;
                if (!statusWrap.classList.contains('offline')) {
                    checkBtn.textContent = 'Check for Updates';
                    checkBtn.classList.remove('btn-warning');
                }
            }
        }
    },

    /** Populate the update options UI with available versions. */
    _populateUpdateOptions(data) {
        const stableSelect = document.getElementById('stable-versions');
        const betaCheckbox = document.getElementById('beta-mode');
        const betaInfo = document.getElementById('beta-info');

        // Populate stable versions
        if (stableSelect) {
            stableSelect.innerHTML = '';
            
            if (data.stable.length === 0) {
                const option = document.createElement('option');
                option.value = '';
                option.textContent = 'No stable releases available';
                option.disabled = true;
                stableSelect.appendChild(option);
            } else {
                // Add empty option
                const emptyOption = document.createElement('option');
                emptyOption.value = '';
                emptyOption.textContent = 'Select a version...';
                stableSelect.appendChild(emptyOption);

                // Add stable versions
                data.stable.forEach(version => {
                    const option = document.createElement('option');
                    option.value = version;
                    option.textContent = version;
                    
                    // Mark current version
                    if (data.current.tag === version) {
                        option.textContent += ' (current)';
                        option.disabled = true;
                    }
                    
                    stableSelect.appendChild(option);
                });
            }
        }

        // Update beta option
        if (betaCheckbox && betaInfo) {
            // Disable beta in offline mode or when not available
            betaCheckbox.disabled = !data.beta.available || data.offline_mode;
            
            if (data.offline_mode) {
                betaInfo.innerHTML = 'Beta updates unavailable offline';
                betaInfo.classList.remove('hidden');
            } else if (data.beta.available) {
                const ahead = this._formatBetaAhead(data);
                betaInfo.textContent = ahead || 'Beta release available';
                betaInfo.classList.remove('hidden');
            } else {
                betaInfo.innerHTML = 'No beta updates available';
                betaInfo.classList.add('hidden');
            }
            
            // Show warning if present
            if (data.beta.warning) {
                betaInfo.innerHTML = data.beta.warning;
                betaInfo.classList.remove('hidden');
            }
        }

        this._updateApplyButtonState();
    },

    /** Update the apply button state based on selection. */
    _updateApplyButtonState() {
        const applyBtn = document.getElementById('apply-update-btn');
        const stableSelect = document.getElementById('stable-versions');
        const betaCheckbox = document.getElementById('beta-mode');

        if (!applyBtn) return;

        const hasStableSelection = stableSelect && stableSelect.value;
        const hasBetaSelection = betaCheckbox && betaCheckbox.checked && !betaCheckbox.disabled;

        if (hasStableSelection || hasBetaSelection) {
            applyBtn.classList.remove('hidden');
            applyBtn.disabled = false;
        } else {
            applyBtn.classList.add('hidden');
            applyBtn.disabled = true;
        }
    },

    /** Get the currently selected version to update to. */
    _getSelectedVersion() {
        const stableSelect = document.getElementById('stable-versions');
        const betaCheckbox = document.getElementById('beta-mode');

        if (betaCheckbox && betaCheckbox.checked && !betaCheckbox.disabled) {
            return 'main';
        } else if (stableSelect && stableSelect.value) {
            return stableSelect.value;
        }

        return null;
    },

    /** Apply the selected update. */
    async applyUpdate() {
        const version = this._getSelectedVersion();
        if (!version) {
            alert('Please select a version to update to.');
            return;
        }

        // Check if we're trying to update to main branch while offline
        if (version === 'main' && this._isOfflineMode()) {
            alert('Cannot update to beta (main branch) while offline.\n\nPlease check your internet connection and try again.');
            return;
        }

        // Check update safety first
        try {
            const safetyCheck = await this._checkUpdateSafety(version);
            if (!safetyCheck.success) {
                alert(`Safety check failed: ${safetyCheck.error}`);
                return;
            }

            // Handle unsafe updates
            if (!safetyCheck.safe) {
                const forceConfirm = await this._handleUnsafeUpdate(version, safetyCheck);
                if (!forceConfirm) {
                    return; // User cancelled
                }
            }

            // Proceed with the update
            await this._performUpdate(version, safetyCheck.requires_force);
            
        } catch (error) {
            console.error('Update failed:', error);
            alert(`Update failed: ${error.message}`);
        }
    },

    /** Check if an update would be safe. */
    async _checkUpdateSafety(version) {
        const response = await fetch('/api/system/updates/safety-check', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ version })
        });
        
        return await response.json();
    },

    /** Handle unsafe update scenarios with user confirmation. */
    async _handleUnsafeUpdate(version, safetyCheck) {
        const versionText = version === 'main' ? 'main branch' : version;
        let warningMessage = `⚠️ WARNING: Updating to ${versionText} is not safe!\n\n`;
        
        if (safetyCheck.history_rewritten) {
            warningMessage += `This update would rewrite git history. This means:\n`;
            warningMessage += `• Local changes may be permanently lost\n`;
            warningMessage += `• The update cannot be easily rolled back\n`;
            warningMessage += `• This may indicate the remote repository was force-pushed\n\n`;
        }
        
        warningMessage += `Issue: ${safetyCheck.warning}\n\n`;
        
        switch (safetyCheck.recommendation) {
            case 'rollback':
                warningMessage += `This appears to be a rollback to an older version.`;
                break;
            case 'force_required':
                warningMessage += `A force update is required, which will discard local history.`;
                break;
            default:
                warningMessage += `This update may cause issues.`;
        }
        
        warningMessage += `\n\nDo you want to force this update anyway?\n\n`;
        warningMessage += `⚠️ THIS IS POTENTIALLY DANGEROUS ⚠️`;
        
        return confirm(warningMessage);
    },

    /** Perform the actual update with proper confirmation. */
    async _performUpdate(version, forceUpdate = false) {
        // Get PIN if required
        const pinInput = document.getElementById('update-pin');
        const pin = pinInput && !pinInput.closest('.hidden') ? pinInput.value : null;

        // Final confirmation
        const versionText = version === 'main' ? 'latest beta (main branch)' : version;
        const forceWarning = forceUpdate ? '\n\n⚠️ This will FORCE UPDATE and may discard local changes!' : '';
        const offlineWarning = this._isOfflineMode() && version !== 'main' ? 
            '\n\nNote: Working offline - using cached version information.' : '';
        
        if (!confirm(`Update MixPi to ${versionText}?${forceWarning}${offlineWarning}\n\nThe system will restart automatically. Any active recording will be stopped.`)) {
            return;
        }

        // Show progress UI
        this._showUpdateProgress();

        try {
            const response = await fetch('/api/system/updates/apply', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ version, pin, force: forceUpdate })
            });

            const data = await response.json();

            if (!data.success) {
                // Handle special case where force is required
                if (data.requires_force && !forceUpdate) {
                    const forceConfirm = await this._handleUnsafeUpdate(version, data);
                    if (forceConfirm) {
                        // Retry with force
                        return this._performUpdate(version, true);
                    } else {
                        this._resetUpdateUI();
                        return;
                    }
                }
                
                throw new Error(data.error || 'Update failed');
            }

            // Update will restart the service, so show completion message
            this._updateProgress('completed', `${data.message}\n\nSystem is restarting...`, 100);

            // Clear PIN input on success
            if (pinInput) pinInput.value = '';

            // Page will likely reload due to service restart
            setTimeout(() => {
                window.location.reload();
            }, 5000);

        } catch (error) {
            console.error('Update failed:', error);
            this._updateProgress('error', `Update failed: ${error.message}`, 0);
            this._resetUpdateUI();
        }
    },

    /** Reset the update UI to initial state. */
    _resetUpdateUI() {
        const progressEl = document.getElementById('update-progress');
        const applyBtn = document.getElementById('apply-update-btn');
        const stableSelect = document.getElementById('stable-versions');
        const betaCheckbox = document.getElementById('beta-mode');
        const checkBtn = document.getElementById('check-updates-btn');

        if (progressEl) progressEl.classList.add('hidden');
        if (applyBtn) {
            applyBtn.disabled = false;
            applyBtn.textContent = 'Apply Update';
        }
        if (stableSelect) stableSelect.disabled = false;
        if (betaCheckbox) betaCheckbox.disabled = false;
        if (checkBtn) checkBtn.disabled = false;
    },

    /** Show the update progress UI. */
    _showUpdateProgress() {
        const progressEl = document.getElementById('update-progress');
        const applyBtn = document.getElementById('apply-update-btn');
        const controlsEl = document.getElementById('update-controls');

        if (progressEl) {
            progressEl.classList.remove('hidden');
        }

        if (applyBtn) {
            applyBtn.disabled = true;
            applyBtn.textContent = 'Updating...';
        }

        // Disable other controls
        const stableSelect = document.getElementById('stable-versions');
        const betaCheckbox = document.getElementById('beta-mode');
        const checkBtn = document.getElementById('check-updates-btn');

        if (stableSelect) stableSelect.disabled = true;
        if (betaCheckbox) betaCheckbox.disabled = true;
        if (checkBtn) checkBtn.disabled = true;

        this._updateProgress('starting', 'Preparing update...', 10);
    },

    /** Update the progress display. */
    _updateProgress(step, message, percentage) {
        const progressText = document.getElementById('progress-text');
        const progressFill = document.getElementById('progress-fill');

        if (progressText) {
            progressText.textContent = message;
        }

        if (progressFill) {
            progressFill.style.width = `${percentage}%`;
        }

        // Update progress bar color based on step
        if (progressFill) {
            progressFill.className = 'progress-fill';
            if (step === 'error') {
                progressFill.classList.add('progress-error');
            } else if (step === 'completed') {
                progressFill.classList.add('progress-success');
            } else if (step === 'rollback') {
                progressFill.classList.add('progress-warning');
            } else if (step === 'warning') {
                progressFill.classList.add('progress-warning');
            }
        }
    },

    /** Check if we're currently in offline mode. */
    _isOfflineMode() {
        const statusEl = document.getElementById('update-status');
        return statusEl && statusEl.classList.contains('offline');
    },

    /** Show repository status warnings. */
    _showRepoStatusWarning(repoStatus) {
        const controlsEl = document.getElementById('update-controls');
        if (!controlsEl) return;

        // Remove any existing warning
        const existingWarning = controlsEl.querySelector('.repo-status-warning');
        if (existingWarning) existingWarning.remove();

        let warningText = '';
        if (repoStatus.history_diverged) {
            warningText = '⚠️ Repository history has diverged - some updates may require force';
        } else if (repoStatus.force_update_required) {
            warningText = '⚠️ Repository state may require force updates';
        }

        if (warningText) {
            const warningDiv = document.createElement('div');
            warningDiv.className = 'repo-status-warning';
            warningDiv.textContent = warningText;
            controlsEl.insertBefore(warningDiv, controlsEl.firstChild);
        }
    },

    /** Handle WebSocket progress updates. */
    _handleUpdateProgress(data) {
        const stepMessages = {
            'validating': 'Validating repository...',
            'analyzing': 'Analyzing update safety...',
            'cleaning': 'Preparing clean state...',
            'updating': 'Installing update...',
            'restarting': 'Restarting service...',
            'rollback': 'Rolling back changes...',
            'warning': 'Update completed with warnings'
        };

        const stepPercentages = {
            'validating': 15,
            'analyzing': 25,
            'cleaning': 35,
            'updating': 70,
            'restarting': 90,
            'rollback': 60,
            'completed': 100,
            'warning': 95
        };

        const message = data.message || stepMessages[data.step] || 'Processing...';
        const percentage = stepPercentages[data.step] || 50;

        this._updateProgress(data.step, message, percentage);
    },

    /** Setup visibility change detection to refresh status when tab becomes active. */
    _setupVisibilityCheck() {
        if (typeof document.addEventListener !== 'function') return;
        
        let wasHidden = document.hidden;
        const handleVisibilityChange = () => {
            // Only refresh when coming back from hidden state
            if (wasHidden && !document.hidden) {
                // Small delay to allow any external changes to settle
                setTimeout(() => {
                    this.checkForUpdates();
                }, 1000);
            }
            wasHidden = document.hidden;
        };
        
        document.addEventListener('visibilitychange', handleVisibilityChange);
        
        // Also refresh when the storage tab is clicked (in case user switched tabs)
        const tabBtn = document.querySelector('[data-tab="storage"]');
        if (tabBtn && !tabBtn._updateRefreshBound) {
            const originalClick = tabBtn.onclick;
            tabBtn.onclick = (e) => {
                if (originalClick) originalClick.call(tabBtn, e);
                // Refresh updates when switching to system tab
                setTimeout(() => {
                    this.checkForUpdates();
                }, 500);
            };
            tabBtn._updateRefreshBound = true;
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

// Make storageTab available globally for WebSocket event handling
window.storageTab = storageTab;
