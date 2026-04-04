/**
 * Sessions Module
 * Two-level hierarchy: Shows (collapsible) → Recordings
 */

class SessionsManager {
    constructor() {
        this.shows = [];
        this._bouncePollers  = {};   // rel_path -> interval id
        this._mixerPoller    = null; // interval id for mixer timeline polling
        this._mixerRelPath   = null; // rel_path of the session playing on mixer
    }

    async loadSessions() {
        try {
            const response = await fetch('/api/sessions');
            const data = await response.json();
            if (data.success) {
                this.shows = data.sessions;
                this.renderSessions();
                // Let app.js update the SONG placeholder (e.g. "song3")
                if (typeof _updateTrackPlaceholder === 'function') _updateTrackPlaceholder();
            }
        } catch (error) {
            console.error('Error loading sessions:', error);
        }
    }

    _isAudioPlaying() {
        return Array.from(
            document.querySelectorAll('#sessions-list audio')
        ).some(a => !a.paused && !a.ended);
    }

    _isMixerPlaying() {
        return !!this._mixerRelPath;
    }

    renderSessions() {
        const container = document.getElementById('sessions-list');

        // Never wipe the DOM while audio is playing (browser or mixer).
        if (this._isAudioPlaying() || this._isMixerPlaying()) return;

        if (!this.shows || this.shows.length === 0) {
            container.innerHTML = '<p class="empty-message">No recordings yet</p>';
            return;
        }
        container.innerHTML = '';
        this.shows.forEach(show => {
            container.appendChild(this._createShowGroup(show));
        });
        // Start bounce-status polling for any recording that is still mixing
        this.shows.forEach(show => {
            (show.recordings || []).forEach(rec => {
                if (!rec.bounce_ready) {
                    this._pollBounceStatus(rec.rel_path);
                }
            });
        });
    }

    // ----------------------------------------------------------------
    // Show group (collapsible)
    // ----------------------------------------------------------------

    _createShowGroup(show) {
        const recCount = (show.recordings || []).length;
        const wrap = document.createElement('div');
        wrap.className = 'show-group';
        wrap.dataset.show = show.name;

        const safeName = this._esc(show.name);
        const mixesFmtId = `show-mixes-fmt-${this._safeId(show.name)}`;

        wrap.innerHTML = `
            <div class="show-header" onclick="sessionsManager.toggleShow('${safeName}')">
                <span class="show-chevron">&#9660;</span>
                <span class="show-title">${safeName}</span>
                <button class="btn-download show-zip-btn" title="Download entire session as ZIP"
                    onclick="event.stopPropagation(); sessionsManager.downloadSession('${safeName}')">
                    &#8659; ZIP &middot; ${recCount} rec
                </button>
                <button class="btn-download show-zip-btn" title="Download only stereo mixes as ZIP"
                    id="btn-mixes-zip-${this._safeId(show.name)}"
                    onclick="event.stopPropagation(); sessionsManager._toggleFmt('${mixesFmtId}', this)">
                    &#8659; Stereo Mixes ZIP
                </button>
                <span class="share-fmt-picker" id="${mixesFmtId}" style="display:none;" onclick="event.stopPropagation();">
                    <button onclick="sessionsManager.downloadMixesZip('${safeName}','wav')" title="Original quality WAV">WAV</button>
                    <button onclick="sessionsManager.downloadMixesZip('${safeName}','m4a')" title="AAC 256 kbps">M4A</button>
                    <button onclick="sessionsManager.downloadMixesZip('${safeName}','mp3')" title="MP3 320 kbps">MP3</button>
                </span>
                <button class="btn-delete show-delete-btn" title="Delete entire session"
                    onclick="event.stopPropagation(); sessionsManager.deleteSession('${safeName}')">
                    &#128465;
                </button>
            </div>
            ${show.notes ? `<div class="show-notes">${this._esc(show.notes)}</div>` : ''}
            <div class="show-recordings" id="show-body-${safeName}"></div>
        `;

        const body = wrap.querySelector('.show-recordings');
        if (!show.recordings || show.recordings.length === 0) {
            body.innerHTML = '<p class="empty-message" style="padding:8px 12px">No recordings</p>';
        } else {
            show.recordings.forEach(rec => {
                body.appendChild(this._createRecordingCard(rec));
            });
        }
        return wrap;
    }

    toggleShow(showName) {
        const body = document.getElementById(`show-body-${showName}`);
        const chevron = document.querySelector(
            `.show-group[data-show="${showName}"] .show-chevron`);
        if (!body) return;
        const hidden = body.style.display === 'none';
        body.style.display = hidden ? '' : 'none';
        if (chevron) chevron.innerHTML = hidden ? '&#9660;' : '&#9658;';
    }

    // ----------------------------------------------------------------
    // Recording card
    // ----------------------------------------------------------------

    _createRecordingCard(rec) {
        const div = document.createElement('div');
        div.className = 'session-item recording-card';
        div.id = `rec-card-${this._safeId(rec.rel_path)}`;

        const sizeStr    = this._formatSize(rec.size);
        const date       = new Date(rec.modified).toLocaleString();
        const dur        = this._fmtDuration(rec.duration_s);
        const meta       = rec.metadata || {};
        const WAV_HDR    = 44;
        const isEmpty    = rec.files > 0 && rec.size <= WAV_HDR * rec.files;

        const emptyBadge  = isEmpty
            ? `<span class="session-empty-badge" title="Recording stopped without audio data">&#9888; Empty</span>`
            : '';

        let qualityTag = '';
        if (meta.sample_rate && meta.bit_depth) {
            const khz = (meta.sample_rate / 1000).toFixed(1).replace('.0', '');
            qualityTag = `<span class="session-quality-badge">${khz}&nbsp;kHz&nbsp;/&nbsp;${meta.bit_depth}-bit</span>`;
        }
        const chBadge  = meta.channels
            ? `<span class="session-quality-badge">${meta.channels}&nbsp;CH</span>` : '';
        const durBadge = dur
            ? `<span class="session-quality-badge session-dur-badge">&#9201; ${dur}</span>` : '';

        const relPath  = rec.rel_path;
        const safePath = this._esc(relPath);

        div.innerHTML = `
            <div class="session-header">
                <div class="session-name-row">
                    <span class="session-name">${this._esc(rec.name)}</span>
                    ${emptyBadge}${qualityTag}${chBadge}${durBadge}
                    <button class="btn-delete rec-delete-btn" title="Delete this recording"
                        onclick="sessionsManager.deleteRecording('${safePath}')">
                        &#128465;
                    </button>
                </div>
            </div>
            <div class="session-info">
                <span>&#128196; ${rec.files} ch</span>
                <span>&#128190; ${sizeStr}</span>
                <span>&#128197; ${date}</span>
            </div>
            <div class="session-actions">
                ${!isEmpty ? `<button class="btn-stereo-mix" id="bounce-btn-${this._safeId(relPath)}"
                    onclick="sessionsManager.handleBounceBtn('${safePath}')">
                    &#9836; Stereo Mix
                </button>` : ''}
                <button class="btn-mixer-play" id="mixer-btn-${this._safeId(relPath)}"
                    ${isEmpty ? 'disabled' : ''}
                    onclick="sessionsManager.handleMixerPlay('${safePath}')">
                    &#9654; Mixer
                </button>
                <button class="btn-download" onclick="sessionsManager.toggleFiles('${safePath}', this)">
                    &#128203; Files
                </button>
                <button class="btn-download" onclick="sessionsManager.downloadSession('${safePath}')">
                    &#8659; ZIP &middot; ${rec.files}&nbsp;ch
                </button>
            </div>
            <div id="bounce-result-${this._safeId(relPath)}" class="mix-result" style="display:none;"></div>
            <div id="files-${this._safeId(relPath)}" class="file-list" style="display:none;">
                <p class="empty-message">Loading…</p>
            </div>
        `;

        // Restore bounce state immediately if already ready
        if (rec.bounce_ready) {
            this._showBouncePlayer(relPath);
        }

        return div;
    }

    // ----------------------------------------------------------------
    // Bounce (stereo mix) flow
    // ----------------------------------------------------------------

    /** Called by the Stereo Mix button */
    async handleBounceBtn(relPath) {
        const btn = document.getElementById(`bounce-btn-${this._safeId(relPath)}`);
        if (!btn) return;

        // Check current status first
        try {
            const res  = await fetch(`/api/sessions/${relPath}/bounce-status`);
            const data = await res.json();
            if (data.ready) {
                this._showBouncePlayer(relPath);
                return;
            }
            if (data.status === 'mixing') {
                btn.textContent = '⏳ Mixing…';
                btn.disabled = true;
                this._pollBounceStatus(relPath);
                return;
            }
        } catch (_) {}

        // Trigger manual mix
        btn.disabled = true;
        btn.textContent = '⏳ Mixing…';
        try {
            const res  = await fetch(`/api/sessions/${relPath}/downmix`, { method: 'POST' });
            const data = await res.json();
            if (data.success) {
                if (data.status === 'mixing') {
                    this._pollBounceStatus(relPath);
                } else {
                    this._showBouncePlayer(relPath);
                }
            } else {
                this._setBounceError(relPath, data.message || 'Mix failed');
            }
        } catch (err) {
            this._setBounceError(relPath, err.message);
        }
    }

    _pollBounceStatus(relPath) {
        const key = relPath;
        if (this._bouncePollers[key]) return;   // already polling

        const btn = document.getElementById(`bounce-btn-${this._safeId(relPath)}`);
        if (btn) { btn.textContent = '⏳ Mixing…'; btn.disabled = true; }

        const interval = setInterval(async () => {
            try {
                const res  = await fetch(`/api/sessions/${relPath}/bounce-status`);
                const data = await res.json();
                if (data.ready) {
                    clearInterval(this._bouncePollers[key]);
                    delete this._bouncePollers[key];
                    this._showBouncePlayer(relPath);
                } else if (data.status === 'error') {
                    clearInterval(this._bouncePollers[key]);
                    delete this._bouncePollers[key];
                    this._setBounceError(relPath, 'Bounce failed on server');
                }
            } catch (_) {}
        }, 2000);
        this._bouncePollers[key] = interval;
    }

    _showBouncePlayer(relPath) {
        const btn       = document.getElementById(`bounce-btn-${this._safeId(relPath)}`);
        const resultDiv = document.getElementById(`bounce-result-${this._safeId(relPath)}`);
        if (!resultDiv) return;

        const streamUrl  = `/api/sessions/${relPath}/bounce`;
        const playId     = `mixplay-${this._safeId(relPath)}`;
        const panelId    = `mixpanel-${this._safeId(relPath)}`;
        const dlId       = `mixdl-${this._safeId(relPath)}`;
        const dlFmtId    = `mixdlfmt-${this._safeId(relPath)}`;
        const shareId    = `mixshare-${this._safeId(relPath)}`;
        const shareFmtId = `mixsharefmt-${this._safeId(relPath)}`;
        const safePath   = this._esc(relPath);

        // Show Share button only when the Web Share API with files is available (HTTPS + supported browser)
        const canShare = typeof navigator.share === 'function';

        resultDiv.innerHTML = `
            <span class="mix-label">Stereo mix ready:</span>
            <button class="btn-play-file" id="${playId}">&#9654; Play</button>
            <button class="btn-download-file" id="${dlId}"
                onclick="sessionsManager._toggleFmt('${dlFmtId}', this)">
                &#8659; Download
            </button>
            <span class="share-fmt-picker" id="${dlFmtId}" style="display:none;">
                <button onclick="sessionsManager.downloadMix('${safePath}','wav')" title="Original quality WAV">WAV</button>
                <button onclick="sessionsManager.downloadMix('${safePath}','m4a')" title="AAC 256 kbps">M4A</button>
                <button onclick="sessionsManager.downloadMix('${safePath}','mp3')" title="MP3 320 kbps">MP3</button>
            </span>
            ${canShare ? `
            <button class="btn-share-mix" id="${shareId}"
                onclick="sessionsManager._toggleFmt('${shareFmtId}', this)">
                &#8679; Share
            </button>
            <span class="share-fmt-picker" id="${shareFmtId}" style="display:none;">
                <button onclick="sessionsManager.shareMix('${safePath}','wav')" title="Original quality WAV">WAV</button>
                <button onclick="sessionsManager.shareMix('${safePath}','m4a')" title="AAC 256 kbps">M4A</button>
                <button onclick="sessionsManager.shareMix('${safePath}','mp3')" title="MP3 320 kbps">MP3</button>
            </span>` : ''}
            <div id="${panelId}" class="inline-player" style="display:none;">
                <audio controls preload="auto" style="width:100%;margin-top:6px;"></audio>
            </div>`;
        resultDiv.style.display = 'block';

        if (btn) { btn.innerHTML = '&#9836; Stereo Mix'; btn.disabled = false; }

        // Wire play button with reliable canplay approach
        const playBtn = document.getElementById(playId);
        const panel   = document.getElementById(panelId);
        if (playBtn && panel) {
            const audio = panel.querySelector('audio');
            playBtn.addEventListener('click', () => {
                const visible = panel.style.display !== 'none';
                if (visible) {
                    audio.pause();
                    panel.style.display = 'none';
                    playBtn.innerHTML = '&#9654; Play';
                } else {
                    audio.src = streamUrl;
                    audio.load();
                    panel.style.display = 'block';
                    playBtn.innerHTML = '&#9646;&#9646; Pause';
                    audio.addEventListener('canplay', () => audio.play().catch(() => {}),
                                          { once: true });
                }
            });
            audio.addEventListener('pause', () => { playBtn.innerHTML = '&#9654; Play'; });
            audio.addEventListener('play',  () => { playBtn.innerHTML = '&#9646;&#9646; Pause'; });
            audio.addEventListener('ended', () => {
                panel.style.display = 'none';
                playBtn.innerHTML = '&#9654; Play';
            });
        }
    }

    _setBounceError(relPath, msg) {
        const btn = document.getElementById(`bounce-btn-${this._safeId(relPath)}`);
        const resultDiv = document.getElementById(`bounce-result-${this._safeId(relPath)}`);
        if (btn) { btn.innerHTML = '&#9836; Stereo Mix'; btn.disabled = false; }
        if (resultDiv) {
            resultDiv.innerHTML = `<span class="mix-error">Mix failed: ${msg}</span>`;
            resultDiv.style.display = 'block';
        }
    }

    // ----------------------------------------------------------------
    // Play on Mixer
    // ----------------------------------------------------------------

    async handleMixerPlay(relPath) {
        const btn = document.getElementById(`mixer-btn-${this._safeId(relPath)}`);

        // If something is already playing on the mixer, stop it
        if (this._mixerRelPath) {
            const wasPlaying = this._mixerRelPath; // capture before _stopMixerTimeline nullifies it
            this._stopMixerTimeline();
            await fetch('/api/playback/stop', { method: 'POST' }).catch(() => {});
            // If the user clicked the same card's button, just stop
            if (wasPlaying === relPath) return;
        }

        if (btn) btn.innerHTML = '&#9646;&#9646; Stop';

        try {
            const res  = await fetch(`/api/sessions/${relPath}/playback/start`, { method: 'POST' });
            const data = await res.json();
            if (!data.success) {
                alert('Mixer playback failed: ' + (data.message || ''));
                if (btn) btn.innerHTML = '&#9654; Mixer';
                return;
            }
        } catch (err) {
            alert('Error starting mixer playback: ' + err.message);
            if (btn) btn.innerHTML = '&#9654; Mixer';
            return;
        }

        this._startMixerTimeline(relPath);
    }

    _startMixerTimeline(relPath) {
        this._mixerRelPath = relPath;
        const safeId = this._safeId(relPath);
        const card   = document.getElementById(`rec-card-${safeId}`);
        if (!card) return;

        // Inject the timeline bar below the action buttons
        const existing = document.getElementById(`mixer-timeline-${safeId}`);
        if (!existing) {
            const tl = document.createElement('div');
            tl.className = 'mixer-timeline';
            tl.id        = `mixer-timeline-${safeId}`;
            tl.innerHTML = `
                <div class="mixer-tl-bar">
                    <div class="mixer-tl-fill" id="mixer-tl-fill-${safeId}" style="width:0%"></div>
                </div>
                <div class="mixer-tl-info">
                    <span class="mixer-tl-pos"  id="mixer-tl-pos-${safeId}">0:00</span>
                    <span class="mixer-tl-sep">/</span>
                    <span class="mixer-tl-dur"  id="mixer-tl-dur-${safeId}">—</span>
                    <span class="mixer-tl-label">▶ Playing on mixer</span>
                </div>
            `;
            // Insert right after .session-actions
            const actions = card.querySelector('.session-actions');
            if (actions && actions.nextSibling) {
                card.insertBefore(tl, actions.nextSibling);
            } else if (actions) {
                card.appendChild(tl);
            }
        }

        // Poll every second
        this._mixerPoller = setInterval(async () => {
            try {
                const st = await (await fetch('/api/playback/status')).json();
                this._updateMixerTimeline(safeId, st);
                if (!st.playing) this._stopMixerTimeline();
            } catch (_) {
                this._stopMixerTimeline();
            }
        }, 1000);
    }

    _updateMixerTimeline(safeId, st) {
        const fill = document.getElementById(`mixer-tl-fill-${safeId}`);
        const pos  = document.getElementById(`mixer-tl-pos-${safeId}`);
        const dur  = document.getElementById(`mixer-tl-dur-${safeId}`);
        if (fill) fill.style.width = `${st.progress_pct || 0}%`;
        if (pos)  pos.textContent  = this._fmtSec(st.position_sec || 0);
        if (dur)  dur.textContent  = this._fmtSec(st.duration_sec || 0);
    }

    _stopMixerTimeline() {
        if (this._mixerPoller) { clearInterval(this._mixerPoller); this._mixerPoller = null; }
        const safeId = this._safeId(this._mixerRelPath || '');

        // Remove the timeline element
        const tl = document.getElementById(`mixer-timeline-${safeId}`);
        if (tl) tl.remove();

        // Reset the mixer button
        const btn = document.getElementById(`mixer-btn-${safeId}`);
        if (btn) { btn.innerHTML = '&#9654; Mixer'; btn.disabled = false; }

        this._mixerRelPath = null;
    }

    /** Format seconds as m:ss */
    _fmtSec(sec) {
        const s = Math.round(sec);
        return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    }

    // ----------------------------------------------------------------
    // File browser (individual channel files)
    // ----------------------------------------------------------------

    async toggleFiles(relPath, triggerBtn) {
        const filesDiv = document.getElementById(`files-${this._safeId(relPath)}`);
        if (!filesDiv) return;
        if (filesDiv.style.display === 'none') {
            filesDiv.style.display = 'block';
            await this.loadFiles(relPath);
            if (triggerBtn) triggerBtn.innerHTML = '&#128203; Hide';
        } else {
            filesDiv.style.display = 'none';
            if (triggerBtn) triggerBtn.innerHTML = '&#128203; Files';
        }
    }

    async loadFiles(relPath) {
        const filesDiv = document.getElementById(`files-${this._safeId(relPath)}`);
        try {
            const response = await fetch(`/api/sessions/${relPath}/files`);
            const data     = await response.json();
            if (data.success) {
                this.renderFiles(filesDiv, relPath, data.files);
            }
        } catch (error) {
            console.error('Error loading files:', error);
            filesDiv.innerHTML = '<p class="empty-message">Error loading files</p>';
        }
    }

    renderFiles(container, relPath, files) {
        if (files.length === 0) {
            container.innerHTML = '<p class="empty-message">No files</p>';
            return;
        }
        container.innerHTML = '';
        files.forEach(file => {
            const fileEl   = document.createElement('div');
            fileEl.className = 'file-item';
            const sizeMB   = (file.size / (1024 ** 2)).toFixed(1);
            const isAudio  = /\.(wav|flac|mp3|ogg)$/i.test(file.name);
            const playerId = `player-${this._safeId(relPath + '/' + file.name)}`;
            const streamUrl = `/api/sessions/${relPath}/stream/${file.name}`;
            const downloadUrl = `/api/sessions/${relPath}/download/${file.name}`;

            const row = document.createElement('div');
            row.innerHTML = `
                <span class="file-name">${file.name}</span>
                <div class="file-actions">
                    <span class="file-size">${sizeMB} MB</span>
                    ${isAudio ? `<button class="btn-play-file" id="playbtn-${playerId}">&#9654; Play</button>` : ''}
                    <button class="btn-download-file" onclick="window.location.href='${downloadUrl}'">&#8659; Download</button>
                </div>
                ${isAudio ? `<div id="${playerId}" class="inline-player" style="display:none;">
                    <audio controls preload="auto" style="width:100%;margin-top:6px;"></audio>
                </div>` : ''}
            `;
            fileEl.appendChild(row);

            if (isAudio) {
                const btn   = row.querySelector(`#playbtn-${playerId}`);
                const panel = row.querySelector(`#${playerId}`);
                if (btn && panel) {
                    const audio = panel.querySelector('audio');
                    btn.addEventListener('click', () => {
                        const showing = panel.style.display !== 'none';
                        if (showing) {
                            audio.pause();
                            panel.style.display = 'none';
                            btn.innerHTML = '&#9654; Play';
                        } else {
                            audio.src = streamUrl;
                            audio.load();
                            panel.style.display = 'block';
                            btn.innerHTML = '&#9646;&#9646; Pause';
                            audio.addEventListener('canplay', () => audio.play().catch(() => {}),
                                                  { once: true });
                        }
                    });
                    audio.addEventListener('pause', () => { btn.innerHTML = '&#9654; Play'; });
                    audio.addEventListener('play',  () => { btn.innerHTML = '&#9646;&#9646; Pause'; });
                    audio.addEventListener('ended', () => {
                        panel.style.display = 'none';
                        btn.innerHTML = '&#9654; Play';
                    });
                }
            }
            container.appendChild(fileEl);
        });
    }

    // ----------------------------------------------------------------
    // Share & Download
    // ----------------------------------------------------------------

    _toggleFmt(fmtId, btn) {
        const picker = document.getElementById(fmtId);
        if (!picker) return;
        const visible = picker.style.display !== 'none';
        picker.style.display = visible ? 'none' : 'inline-flex';
        btn.classList.toggle('active', !visible);
    }

    async _downloadWithSpinner(url, filename, btnEl, fmtPickerEl, originalText) {
        const _reset = () => {
            if (btnEl) { btnEl.innerHTML = originalText; btnEl.disabled = false; }
            if (fmtPickerEl) { fmtPickerEl.style.display = 'none'; }
            if (btnEl) { btnEl.classList.remove('active'); }
        };

        if (fmtPickerEl) fmtPickerEl.style.display = 'none';
        if (btnEl) {
            btnEl.innerHTML = `<span class="share-spinner" style="margin-right: 6px; vertical-align: middle;"></span><span style="vertical-align: middle;">${filename}</span>`;
            btnEl.disabled = true;
        }

        try {
            const res = await fetch(url);
            if (!res.ok) {
                let errMsg = `HTTP ${res.status}`;
                try {
                    const errData = await res.json();
                    errMsg = errData.message || errMsg;
                } catch(e) {}
                throw new Error(errMsg);
            }
            const blob = await res.blob();
            const blobUrl = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.style.display = 'none';
            a.href = blobUrl;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            setTimeout(() => {
                window.URL.revokeObjectURL(blobUrl);
                a.remove();
            }, 1000);
        } catch (e) {
            console.error('Download failed:', e);
            alert('Download failed: ' + e.message);
        } finally {
            _reset();
        }
    }

    async downloadMixesZip(showName, fmt, btnEl) {
        if (typeof recorder !== 'undefined' && recorder.isRecording) {
            alert("Cannot batch zip mixes while recording is active.");
            return;
        }
        const url = `/api/sessions/${this._esc(showName)}/download-mixes?format=${fmt}`;
        const filename = `${showName}_StereoMixes.zip`;
        const fmtPickerEl = document.getElementById(`show-mixes-fmt-${this._safeId(showName)}`);
        // Find the Mixes ZIP button that was clicked. It's the previous sibling of the fmtPickerEl.
        const mixBtnEl = fmtPickerEl ? fmtPickerEl.previousElementSibling : null;
        await this._downloadWithSpinner(url, filename, mixBtnEl, fmtPickerEl, '&#8659; Stereo Mixes ZIP');
    }

    downloadMix(relPath, fmt) {
        const url = `/api/sessions/${relPath}/bounce/export?format=${fmt}`;
        const recName = relPath.split('/').pop() || 'stereo_mix';
        const filename = `${recName}.${fmt}`;
        const id = this._safeId(relPath);
        const btnEl = document.getElementById(`mixdl-${id}`);
        const fmtPickerEl = document.getElementById(`mixdlfmt-${id}`);
        this._downloadWithSpinner(url, filename, btnEl, fmtPickerEl, '&#8659; Download');
    }

    // Invokes the native OS share sheet (AirDrop, Messages, Files…).
    // Only shown when navigator.share is available (HTTPS + supported browser).
    async shareMix(relPath, fmt) {
        const url        = `/api/sessions/${relPath}/bounce/export?format=${fmt}`;
        const recName    = relPath.split('/').pop() || 'stereo_mix';
        const filename   = `${recName}.${fmt}`;
        const id         = this._safeId(relPath);
        const shareBtn   = document.getElementById(`mixshare-${id}`);
        const fmtPicker  = document.getElementById(`mixsharefmt-${id}`);

        const _reset = () => {
            if (shareBtn)  { shareBtn.innerHTML = '&#8679; Share'; shareBtn.disabled = false; }
            if (fmtPicker) { fmtPicker.style.display = 'none'; }
            if (shareBtn)  { shareBtn.classList.remove('active'); }
        };

        // Hide format picker, show spinner on the Share button
        if (fmtPicker) fmtPicker.style.display = 'none';
        if (shareBtn) {
            shareBtn.innerHTML = '<span class="share-spinner"></span>';
            shareBtn.disabled = true;
        }

        try {
            const res  = await fetch(url);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const blob = await res.blob();
            const file = new File([blob], filename, { type: blob.type });
            await navigator.share({ files: [file], title: filename });
        } catch (e) {
            if (e.name !== 'AbortError') console.warn('Share failed:', e.message);
        } finally {
            _reset();
        }
    }

    // ----------------------------------------------------------------
    // Download / Delete
    // ----------------------------------------------------------------

    downloadSession(relPath) {
        window.location.href = `/api/sessions/${relPath}/download-all`;
    }

    async deleteRecording(relPath) {
        if (typeof recorder !== 'undefined' && recorder.isRecording) {
            alert("Cannot delete recordings while a recording is active. Please stop recording first.");
            return;
        }
        const name = relPath.split('/').pop();
        const ok = await showConfirm(
            `Delete recording "${name}"?\n\nThis cannot be undone.`);
        if (!ok) return;
        try {
            const res  = await fetch(`/api/sessions/${relPath}`, { method: 'DELETE' });
            const data = await res.json();
            if (data.success) {
                this.loadSessions();
            } else {
                alert('Failed to delete: ' + data.message);
            }
        } catch (e) {
            alert('Error deleting recording');
        }
    }

    async deleteSession(showName) {
        const show = this.shows.find(s => s.name === showName);
        if (!show) return;

        const recordings = show.recordings || [];
        if (recordings.length === 0) {
            // If it's an empty show, just delete it directly
            const ok = await showConfirm(`Delete empty session "${showName}"?\n\nThis cannot be undone.`);
            if (!ok) return;
            try {
                const res = await fetch(`/api/sessions/${showName}`, { method: 'DELETE' });
                const data = await res.json();
                if (data.success) this.loadSessions();
                else alert('Failed to delete: ' + data.message);
            } catch (e) {
                alert('Error deleting show');
            }
            return;
        }

        const selectedPaths = await showDeleteSessionModal(showName, recordings);
        if (!selectedPaths) return; // Cancelled

        // Check if any recording is currently active
        if (typeof recorder !== 'undefined' && recorder.isRecording) {
            alert("Cannot delete recordings while a recording is active. Please stop recording first.");
            return;
        }

        // If they selected all recordings, delete the whole show folder
        if (selectedPaths.length === recordings.length) {
            try {
                const res = await fetch(`/api/sessions/${showName}`, { method: 'DELETE' });
                const data = await res.json();
                if (data.success) this.loadSessions();
                else alert('Failed to delete show: ' + data.message);
            } catch (e) {
                alert('Error deleting show');
            }
            return;
        }

        // Otherwise, delete individual recordings
        let hasError = false;
        for (const relPath of selectedPaths) {
            try {
                const res = await fetch(`/api/sessions/${relPath}`, { method: 'DELETE' });
                const data = await res.json();
                if (!data.success) {
                    console.error('Failed to delete:', data.message);
                    hasError = true;
                }
            } catch (e) {
                console.error('Error deleting recording:', e);
                hasError = true;
            }
        }
        
        if (hasError) alert('Some recordings failed to delete. Check console for details.');
        this.loadSessions();
    }

    // ----------------------------------------------------------------
    // Utilities
    // ----------------------------------------------------------------

    _formatSize(bytes) {
        if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(2) + ' GB';
        if (bytes >= 1048576)    return (bytes / 1048576).toFixed(1)  + ' MB';
        if (bytes >= 1024)       return (bytes / 1024).toFixed(0)     + ' KB';
        return bytes + ' B';
    }

    _fmtDuration(secs) {
        if (!secs || secs < 1) return null;
        if (secs < 60) return Math.round(secs) + 's';
        const m = Math.floor(secs / 60), s = Math.round(secs % 60);
        return m + ':' + String(s).padStart(2, '0');
    }

    _safeId(str) {
        return str.replace(/[^a-z0-9]/gi, '-');
    }

    _esc(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // kept for any residual legacy calls
    createStereoMix(relPath) { return this.handleBounceBtn(relPath); }
    togglePlayer(id) {
        const panel = document.getElementById(id);
        if (!panel) return;
        const audio = panel.querySelector('audio');
        panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
        if (audio) {
            if (panel.style.display === 'block') audio.play().catch(() => {});
            else audio.pause();
        }
    }
}


/**
 * Styled confirmation modal.
 */
function showConfirm(message) {
    return new Promise(resolve => {
        const overlay   = document.getElementById('confirm-modal');
        const msgEl     = document.getElementById('modal-message');
        const btnOk     = document.getElementById('modal-confirm');
        const btnCancel = document.getElementById('modal-cancel');

        msgEl.textContent = message;
        overlay.style.display = 'flex';
        btnCancel.focus();

        function finish(result) {
            overlay.style.display = 'none';
            btnOk.removeEventListener('click', onOk);
            btnCancel.removeEventListener('click', onCancel);
            overlay.removeEventListener('keydown', onKey);
            resolve(result);
        }
        function onOk()     { finish(true);  }
        function onCancel() { finish(false); }
        function onKey(e) {
            if (e.key === 'Escape') finish(false);
            if (e.key === 'Enter')  finish(true);
        }

        btnOk.addEventListener('click', onOk);
        btnCancel.addEventListener('click', onCancel);
        overlay.addEventListener('keydown', onKey);
    });
}

/**
 * Styled session delete modal allowing selection of recordings.
 */
function showDeleteSessionModal(showName, recordings) {
    return new Promise(resolve => {
        const overlay = document.getElementById('session-delete-modal');
        const titleEl = document.getElementById('session-delete-title');
        const listEl  = document.getElementById('session-delete-list');
        const btnOk   = document.getElementById('session-delete-confirm');
        const btnCancel = document.getElementById('session-delete-cancel');
        const chkAll  = document.getElementById('session-delete-all');

        titleEl.textContent = `Delete from "${showName}"`;
        listEl.innerHTML = '';
        chkAll.checked = false;
        btnOk.disabled = true;

        const checkboxes = [];

        recordings.forEach(rec => {
            const label = document.createElement('label');
            label.style.display = 'block';
            label.style.marginBottom = '5px';
            label.style.cursor = 'pointer';

            const chk = document.createElement('input');
            chk.type = 'checkbox';
            chk.value = rec.rel_path;
            chk.style.marginRight = '10px';
            
            chk.addEventListener('change', () => {
                const checkedCount = checkboxes.filter(c => c.checked).length;
                chkAll.checked = (checkedCount === checkboxes.length);
                btnOk.disabled = (checkedCount === 0);
            });

            const span = document.createElement('span');
            span.textContent = rec.name;

            label.appendChild(chk);
            label.appendChild(span);
            listEl.appendChild(label);
            checkboxes.push(chk);
        });

        chkAll.addEventListener('change', (e) => {
            const isChecked = e.target.checked;
            checkboxes.forEach(c => c.checked = isChecked);
            btnOk.disabled = !isChecked;
        });

        overlay.style.display = 'flex';
        btnCancel.focus();

        function finish(result) {
            overlay.style.display = 'none';
            btnOk.removeEventListener('click', onOk);
            btnCancel.removeEventListener('click', onCancel);
            overlay.removeEventListener('keydown', onKey);
            
            // chkAll listener is anonymous but we recreate it every time anyway,
            // better to cloneNode to strip old listeners if we cared, 
            // but we can just replace chkAll to be safe.
            const newChkAll = chkAll.cloneNode(true);
            chkAll.parentNode.replaceChild(newChkAll, chkAll);

            resolve(result);
        }

        function onOk() {
            const selected = checkboxes.filter(c => c.checked).map(c => c.value);
            finish(selected);
        }
        function onCancel() { finish(null); }
        function onKey(e) {
            if (e.key === 'Escape') finish(null);
        }

        btnOk.addEventListener('click', onOk);
        btnCancel.addEventListener('click', onCancel);
        overlay.addEventListener('keydown', onKey);
    });
}

const sessionsManager = new SessionsManager();
