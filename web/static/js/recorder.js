/**
 * Recorder Module
 * Handles recording control and API communication
 */

class Recorder {
    constructor() {
        this.isRecording = false;
        this.recordingStartTime = null;
        this.timerInterval = null;
        this.markers = [];
        this._waveActive  = false;
        this._wavePixels  = 0;
        this._waveSeconds = 0;
        this._lastElapsed = 0;
    }
    
    async startRecording(metadata) {
        try {
            const response = await fetch('/api/recording/start', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(metadata)
            });
            
            const data = await response.json();
            
            if (data.success) {
                this.isRecording = true;
                this.recordingStartTime = Date.now();
                this.markers = [];
                this.startTimer();
                return true;
            } else {
                throw new Error(data.message || 'Failed to start recording');
            }
        } catch (error) {
            console.error('Error starting recording:', error);
            throw error;
        }
    }
    
    async stopRecording() {
        try {
            const response = await fetch('/api/recording/stop', {
                method: 'POST'
            });
            
            const data = await response.json();
            
            if (data.success) {
                this.isRecording = false;
                this.stopTimer();
                return true;
            } else {
                throw new Error(data.message || 'Failed to stop recording');
            }
        } catch (error) {
            console.error('Error stopping recording:', error);
            throw error;
        }
    }
    
    async addMarker(label = '') {
        try {
            const response = await fetch('/api/recording/marker', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ label })
            });
            
            const data = await response.json();
            
            if (data.success) {
                this.markers.push(data.marker);
                return data.marker;
            } else {
                throw new Error(data.message || 'Failed to add marker');
            }
        } catch (error) {
            console.error('Error adding marker:', error);
            throw error;
        }
    }
    
    async getStatus() {
        try {
            const response = await fetch('/api/recording/status');
            const data = await response.json();
            
            if (data.success) {
                return data;
            } else {
                throw new Error(data.message || 'Failed to get status');
            }
        } catch (error) {
            console.error('Error getting status:', error);
            throw error;
        }
    }
    
    async getConfig() {
        try {
            const response = await fetch('/api/config');
            const data = await response.json();
            
            if (data.success) {
                return data.config;
            } else {
                throw new Error(data.message || 'Failed to get config');
            }
        } catch (error) {
            console.error('Error getting config:', error);
            throw error;
        }
    }
    
    startTimer() {
        this._initTimeline();
        this._waveActive = true;
        this.timerInterval = setInterval(() => this.updateTimer(), 1000);
    }

    stopTimer() {
        this._waveActive = false;
        if (this.timerInterval) {
            clearInterval(this.timerInterval);
            this.timerInterval = null;
        }
        const timerEl = document.getElementById('recording-time');
        if (timerEl) timerEl.textContent = '00:00:00';
    }

    updateTimer() {
        if (!this.isRecording || !this.recordingStartTime) return;
        const elapsed = Math.floor((Date.now() - this.recordingStartTime) / 1000);
        this._lastElapsed = elapsed;
        const timerEl = document.getElementById('recording-time');
        if (timerEl) timerEl.textContent = this.formatTime(elapsed);
    }

    // ── Scrolling waveform (DAW style) ───────────────────────────────────────

    // Canvas layout: LABEL_H px ruler at top, rest is waveform
    get _WH()   { return 34; }   // canvas height
    get _LH()   { return 12; }   // ruler label strip height (px)

    _initTimeline() {
        this._wavePixels  = 0;
        this._waveSeconds = 0;
        this._waveActive  = false;
        const canvas = document.getElementById('tpt-timeline');
        if (!canvas) return;
        canvas.width  = Math.max(
            canvas.parentElement.getBoundingClientRect().width || 600, 200);
        canvas.height = this._WH;
        this._drawIdleBackground(canvas);
    }

    _drawIdleBackground(canvas) {
        const ctx = canvas.getContext('2d');
        const W = canvas.width, H = this._WH, LH = this._LH;
        // Main background
        ctx.fillStyle = '#0d0d0d';
        ctx.fillRect(0, 0, W, H);
        // Label strip (slightly lighter)
        ctx.fillStyle = '#111';
        ctx.fillRect(0, 0, W, LH);
        // Separator under label strip
        ctx.fillStyle = '#1e1e1e';
        ctx.fillRect(0, LH, W, 1);
        this._drawRefLines(ctx, W, H, LH);
        // Centre line
        const mid = LH + Math.floor((H - LH) / 2);
        ctx.fillStyle = '#282828';
        ctx.fillRect(0, mid, W, 1);
    }

    _drawRefLines(ctx, W, H, LH) {
        // Faint -12 dB and -24 dB horizontal reference lines
        const wH = H - LH;
        const mid = LH + Math.floor(wH / 2);
        const ref12  = Math.round(((12) / 60) * (wH / 2));  // -12 dB above/below mid
        const ref24  = Math.round(((24) / 60) * (wH / 2));  // -24 dB
        ctx.fillStyle = '#161616';
        ctx.fillRect(0, mid - ref12, W, 1);
        ctx.fillRect(0, mid + ref12, W, 1);
        ctx.fillRect(0, mid - ref24, W, 1);
        ctx.fillRect(0, mid + ref24, W, 1);
    }

    /**
     * Push one audio sample column (called on every levels WebSocket event).
     * peakDb  – loudest armed channel peak in dB (-90…0)
     * rmsDb   – RMS of that channel in dB
     */
    pushWaveform(peakDb, rmsDb) {
        const canvas = document.getElementById('tpt-timeline');
        if (!canvas || !canvas.getContext) return;

        const H   = this._WH;
        const LH  = this._LH;
        const wH  = H - LH;          // waveform area height
        const mid = LH + Math.floor(wH / 2);

        // Sync canvas width to container
        const rect = canvas.parentElement.getBoundingClientRect();
        if (rect.width > 0 && Math.abs(canvas.width - rect.width) > 4) {
            canvas.width = rect.width;
            this._drawIdleBackground(canvas);
        }

        const ctx = canvas.getContext('2d');
        const W   = canvas.width;
        const x   = W - 1;

        // ── 1. Scroll everything left 1px ──────────────────────────────────
        ctx.drawImage(canvas, -1, 0);

        // ── 2. Clear new rightmost column ──────────────────────────────────
        ctx.fillStyle = '#0d0d0d';
        ctx.fillRect(x, LH + 1, 1, wH - 1);
        // Label strip column
        ctx.fillStyle = '#111';
        ctx.fillRect(x, 0, 1, LH);

        // Redraw persistent reference lines for this column
        const ref12 = Math.round((12 / 60) * (wH / 2));
        const ref24 = Math.round((24 / 60) * (wH / 2));
        ctx.fillStyle = '#161616';
        ctx.fillRect(x, mid - ref12, 1, 1);
        ctx.fillRect(x, mid + ref12, 1, 1);
        ctx.fillRect(x, mid - ref24, 1, 1);
        ctx.fillRect(x, mid + ref24, 1, 1);

        // ── 3. Convert dB → amplitude fraction (floor at −60 dB) ──────────
        const amp    = Math.max(0, Math.min(1, (peakDb + 60) / 60));
        const ampRms = Math.max(0, Math.min(1, (rmsDb  + 60) / 60));

        if (this._waveActive) {
            if (amp > 0.008) {
                const pkH  = Math.max(1, Math.round(amp    * (wH / 2 - 1)));
                const rmsH = Math.max(1, Math.round(ampRms * (wH / 2 - 1)));

                // Colour scheme: teal→amber→red as level rises
                let bodyCol, peakCol, capCol;
                if (amp > 0.97) {                     // clip
                    bodyCol = '#7f1d1d'; peakCol = '#ef4444'; capCol = '#fca5a5';
                } else if (amp > 0.75) {              // hot
                    bodyCol = '#78350f'; peakCol = '#f59e0b'; capCol = '#fde68a';
                } else {                               // normal
                    bodyCol = '#164e63'; peakCol = '#0ea5e9'; capCol = '#bae6fd';
                }

                // RMS body — solid fill from centre outward
                ctx.fillStyle = bodyCol;
                ctx.fillRect(x, mid - rmsH, 1, rmsH * 2);

                // Peak extension above/below RMS body
                if (pkH > rmsH) {
                    ctx.fillStyle = peakCol;
                    ctx.fillRect(x, mid - pkH,      1, pkH - rmsH);
                    ctx.fillRect(x, mid + rmsH,     1, pkH - rmsH);
                }

                // Bright 1px cap at peak extremes
                ctx.fillStyle = capCol;
                ctx.fillRect(x, mid - pkH,          1, 1);
                ctx.fillRect(x, mid + pkH - 1,      1, 1);
            } else {
                // Near-silence — draw a faint centre line so it doesn't look dead
                ctx.fillStyle = '#1e3a4c';
                ctx.fillRect(x, mid, 1, 1);
            }

            // Recording cursor — red glow at the leading edge
            ctx.fillStyle = 'rgba(239,68,68,0.25)';
            ctx.fillRect(x, LH + 1, 1, wH - 1);

        } else {
            // Idle / stopped — dim centre trace
            ctx.fillStyle = '#252525';
            ctx.fillRect(x, mid, 1, 1);
        }

        // ── 4. Time tick marks in the label strip ──────────────────────────
        this._wavePixels++;
        const FPS     = 20;
        const TICK_PX = 100;    // 1 tick per 100 px ≈ every 5 s at 20 fps
        if (this._wavePixels % TICK_PX === 0) {
            this._waveSeconds = Math.round(this._wavePixels / FPS);
            // Tick line
            ctx.fillStyle = '#666';
            ctx.fillRect(x, LH, 1, 4);
            // Label (right-aligned so it scrolls naturally)
            ctx.fillStyle  = '#aaa';
            ctx.font       = '8px "Courier New", monospace';
            ctx.textAlign  = 'right';
            ctx.fillText(this._fmtWave(this._waveSeconds), x, LH - 2);
        } else if (this._wavePixels % (TICK_PX / 2) === 0) {
            // Minor tick (half interval)
            ctx.fillStyle = '#3a3a3a';
            ctx.fillRect(x, LH, 1, 2);
        }
    }

    _fmtWave(s) {
        if (s < 60)  return `${s}s`;
        const m = Math.floor(s / 60), sec = s % 60;
        return `${m}:${String(sec).padStart(2, '0')}`;
    }
    
    formatTime(seconds) {
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const secs = seconds % 60;
        
        return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }
    
    formatFileSize(bytes) {
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        let size = bytes;
        let unitIndex = 0;
        
        while (size >= 1024 && unitIndex < units.length - 1) {
            size /= 1024;
            unitIndex++;
        }
        
        return `${size.toFixed(1)} ${units[unitIndex]}`;
    }
}
