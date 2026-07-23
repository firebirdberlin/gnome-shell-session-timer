import GObject from 'gi://GObject';
import St from 'gi://St';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';
import Cairo from 'gi://cairo';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';

Gio._promisify(Gio.File.prototype, 'load_contents_async', 'load_contents_finish');
Gio._promisify(Gio.File.prototype, 'replace_contents_async', 'replace_contents_finish');

const TICK_INTERVAL_SECONDS = 20;
const BATTERY_ICON_WIDTH = 18;
const BATTERY_ICON_HEIGHT = 10;

// Rainbow gradient stops for the fill bar, keyed to horizontal position
// across the full icon width (0 = left, 1 = right) so a given point on the
// bar always shows the same colour as more of the bar fills in, rather than
// the gradient being rescaled to whatever fraction is currently filled.
const RAINBOW_GRADIENT_STOPS = [
    [0.00, 0.86, 0.15, 0.15], // red
    [0.17, 0.92, 0.50, 0.10], // orange
    [0.33, 0.85, 0.80, 0.10], // yellow
    [0.50, 0.20, 0.70, 0.25], // green
    [0.67, 0.15, 0.45, 0.85], // blue
    [0.83, 0.35, 0.20, 0.75], // indigo
    [1.00, 0.65, 0.15, 0.65], // violet
];

const SessionTimerIndicator = GObject.registerClass(
    class SessionTimerIndicator extends PanelMenu.Button {
        _init(extensionPath, metadata, settings, openPreferences) {
            super._init(0.0, 'Gnome Shell Session Timer', false);

            this._metadata = metadata || {};
            this._stateFile = Gio.File.new_for_path(extensionPath).get_child('state.json');
            this._iconFile = Gio.File.new_for_path(extensionPath).get_child('icon.svg');
            this._settings = settings;
            this._openPreferences = openPreferences;
            this._settingsChangedId = this._settings.connect('changed', () => this._updateLabel());

            // Today's total, in whole seconds, from segments that have
            // already ended (screen got locked). The currently-open
            // segment (if any) is tracked separately below and only
            // folded in here on tick/lock/destroy, so we never lose more
            // than one tick's worth of data to a crash. Time is always
            // accruing to exactly one of these two buckets: accumulated
            // while active, paused while locked or manually paused.
            this._accumulatedSeconds = 0;
            this._pausedSeconds = 0;
            this._breakCount = 0; // number of active->paused transitions today
            this._today = null; // 'YYYY-MM-DD', local time
            this._isLocked = false;
            this._isPaused = false; // user-requested pause, independent of lock state
            this._segmentStartUsec = null; // GLib.get_real_time() value the current segment started at
            this._destroyed = false;

            // Grace-period tracking for the currently open lock, if any was
            // caused by a lock (not a manual pause). this._pausedSeconds as
            // of the moment the lock started, and the day it started on —
            // so that on unlock we can tell how long *this* lock lasted and
            // undo its break if it was shorter than the configured grace
            // period. Manual pauses never set this, per _onLockStateChanged.
            this._lockBreakPausedStart = null;
            this._lockBreakDate = null;
            this._lockStartUsec = null; // wall-clock time the current pending lock began

            // Start of the current uninterrupted work session, for the CSV
            // session log — null whenever there's no open session (locked,
            // or manually paused). Grace-period locks don't close a
            // session, only a confirmed break (manual pause, or a lock that
            // outlasts the grace period) does.
            this._sessionStartUsec = null;
            this._csvDirFile = null;
            this._csvWriteQueue = null;

            this._tickId = null;
            this._screenShieldSignalId = null;

            const box = new St.BoxLayout({ style_class: 'panel-status-menu-box' });

            // Progress-bar icon, hand-drawn with Cairo instead of a
            // symbolic icon so its fill level can track today's progress
            // towards the working-hours target. A single filled bar reads
            // as a level far more clearly at panel-icon size than the
            // hourglass this replaced, whose two tiny sand chambers were
            // nearly impossible to tell apart.
            this._barEnabled = false;
            this._icon = new St.DrawingArea({
                style_class: 'system-status-icon',
            });
            this._icon.set_size(BATTERY_ICON_WIDTH, BATTERY_ICON_HEIGHT);
            this._icon.y_align = Clutter.ActorAlign.CENTER;
            this._icon.connect('repaint', area => this._drawBatteryIcon(area));
            box.add_child(this._icon);

            this._label = new St.Label({
                text: '--h --m',
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'panel-button-text',
            });
            box.add_child(this._label);
            this.add_child(box);

            this._menuStatusItem = new PopupMenu.PopupBaseMenuItem({
                reactive: false,
                can_focus: false,
                style_class: 'session-timer-status-item',
            });
            this._menuStatusLabel = new St.Label({
                text: 'Active today: --',
                x_expand: true,
                x_align: Clutter.ActorAlign.START,
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'session-timer-menu-label',
            });
            this._menuStatusItem.add_child(this._menuStatusLabel);

            // Pause/resume toggle — freezes accumulation without needing
            // the screen to be locked, e.g. for a lunch break.
            this._pauseButton = new St.Button({
                label: '⏹',
                style_class: 'session-timer-pause-button session-timer-pause-button-stopped',
                can_focus: true,
                reactive: true,
                track_hover: true,
                x_align: Clutter.ActorAlign.END,
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._pauseButton.connect('clicked', () => this._togglePause());
            this._menuStatusItem.add_child(this._pauseButton);

            this.menu.addMenuItem(this._menuStatusItem);

            // Progress bar towards the configured working-hours target —
            // directly below "Active today"; hidden while the feature is off.
            this._progressBarItem = new PopupMenu.PopupBaseMenuItem({
                reactive: false,
                can_focus: false,
                style_class: 'session-timer-progress-item',
            });
            // FixedLayout allocates children at their own explicitly-set
            // position/size and never re-centers them — BinLayout's
            // x-align: START isn't reliably honored here across Shell
            // versions, which was leaving the fill visually centered.
            this._progressBarTrack = new St.Widget({
                style_class: 'session-timer-progress-track',
                layout_manager: new Clutter.FixedLayout(),
                x_expand: true,
            });
            this._progressBarFill = new St.Widget({
                style_class: 'session-timer-progress-fill',
                width: 0,
            });
            this._progressBarFill.set_position(0, 0);
            this._progressBarTrack.add_child(this._progressBarFill);
            this._progressBarItem.add_child(this._progressBarTrack);
            this.menu.addMenuItem(this._progressBarItem);

            // The fill's pixel width is derived from the track's actual
            // allocated width, which is only known once layout has run —
            // recompute every time that allocation is (re)assigned.
            this._progressFraction = 0;
            this._progressBarTrack.connect('notify::allocation', () => this._applyProgressBarFraction());

            this._menuPausedItem = new PopupMenu.PopupBaseMenuItem({
                reactive: false,
                can_focus: false,
                style_class: 'session-timer-status-item',
            });
            this._menuPausedLabel = new St.Label({
                text: 'Paused today: --',
                x_expand: true,
                x_align: Clutter.ActorAlign.START,
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'session-timer-menu-label',
            });
            this._menuPausedItem.add_child(this._menuPausedLabel);
            this.menu.addMenuItem(this._menuPausedItem);

            // Session log — CSV files are yearly, so a plain "open" link
            // wouldn't be enough to reach past years, hence a link to the
            // containing folder alongside the current file's shortcut.
            this._sessionLogItem = new PopupMenu.PopupBaseMenuItem({
                reactive: false,
                can_focus: false,
                style_class: 'session-timer-status-item',
            });
            const sessionLogLabel = new St.Label({
                text: 'Session log file',
                x_expand: true,
                x_align: Clutter.ActorAlign.START,
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'session-timer-menu-label',
            });
            this._sessionLogItem.add_child(sessionLogLabel);

            const openLogFileButton = new St.Button({
                // U+FE0E forces the monochrome text-style glyph instead of
                // this font's default multicolour emoji rendering, so the
                // icon actually follows the button's white text colour.
                label: '🗎︎',
                style_class: 'session-timer-pause-button',
                can_focus: true,
                reactive: true,
                track_hover: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            openLogFileButton.connect('clicked', () => {
                this.menu.close();
                this._openCurrentSessionCsv();
            });
            this._sessionLogItem.add_child(openLogFileButton);

            const openLogFolderButton = new St.Button({
                label: '🗀︎',
                style_class: 'session-timer-pause-button',
                can_focus: true,
                reactive: true,
                track_hover: true,
                y_align: Clutter.ActorAlign.CENTER,
                style: 'margin-left: 6px;',
            });
            openLogFolderButton.connect('clicked', () => {
                this.menu.close();
                this._openSessionCsvFolder();
            });
            this._sessionLogItem.add_child(openLogFolderButton);
            this.menu.addMenuItem(this._sessionLogItem);
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            const preferencesItem = new PopupMenu.PopupMenuItem('⚙️ Preferences');
            this.menu.addMenuItem(preferencesItem);
            preferencesItem.connect('activate', () => this._openPreferences());

            const aboutItem = new PopupMenu.PopupMenuItem('ℹ️ About');
            this.menu.addMenuItem(aboutItem);
            aboutItem.connect('activate', () => this._showAboutDialog());

            // Buy me a coffee — always the last item in the menu
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            const donateItem = new PopupMenu.PopupMenuItem('☕ Buy me a coffee');
            this.menu.addMenuItem(donateItem);
            donateItem.connect('activate', () => {
                const url = 'https://www.buymeacoffee.com/firebirdberlin';
                Gio.AppInfo.launch_default_for_uri(url, null);
            });

            this._setupScreenShieldWatch();
        }

        /**
         * Shows a small modal dialog with the extension's name, version,
         * GitHub page, and donation link.
         */
        _showAboutDialog() {
            if (this._aboutDialog) {
                this._aboutDialog.open();
                return;
            }

            const name = this._metadata.name || 'Gnome Shell Session Timer';
            const versionName = this._metadata['version-name'];
            const version = versionName
                ? `${versionName} (${this._metadata.version ?? 'unknown'})`
                : this._metadata.version ?? 'unknown';
            const githubUrl = 'https://github.com/firebirdberlin/gnome-shell-session-timer';
            const donateUrl = 'https://www.buymeacoffee.com/firebirdberlin';

            const dialog = new ModalDialog.ModalDialog({
                styleClass: 'session-timer-about-dialog',
                destroyOnClose: true,
            });
            this._aboutDialogDestroyId = dialog.connect('destroy', () => {
                this._aboutDialog = null;
                this._aboutDialogDestroyId = null;
            });
            this._aboutDialog = dialog;

            const content = new St.BoxLayout({
                vertical: true,
                style_class: 'session-timer-about-content',
            });

            content.add_child(new St.Icon({
                gicon: new Gio.FileIcon({ file: this._iconFile }),
                icon_size: 64,
                style_class: 'session-timer-about-icon',
                x_align: Clutter.ActorAlign.CENTER,
            }));

            content.add_child(new St.Label({
                text: name,
                style_class: 'session-timer-about-title',
                x_align: Clutter.ActorAlign.CENTER,
            }));

            content.add_child(new St.Label({
                text: `Version ${version}`,
                style_class: 'session-timer-about-version',
            }));

            const githubButton = new St.Button({
                label: '🔗 github.com/firebirdberlin/gnome-shell-session-timer',
                style_class: 'session-timer-about-link',
                x_align: Clutter.ActorAlign.START,
                can_focus: true,
                reactive: true,
                track_hover: true,
            });
            githubButton.connect('clicked', () => {
                Gio.AppInfo.launch_default_for_uri(githubUrl, null);
            });
            content.add_child(githubButton);

            const donateButton = new St.Button({
                label: '☕ Buy me a coffee',
                style_class: 'session-timer-about-link',
                x_align: Clutter.ActorAlign.START,
                can_focus: true,
                reactive: true,
                track_hover: true,
            });
            donateButton.connect('clicked', () => {
                Gio.AppInfo.launch_default_for_uri(donateUrl, null);
            });
            content.add_child(donateButton);

            const stateFileButton = new St.Button({
                label: '📄 View State File',
                style_class: 'session-timer-about-link',
                x_align: Clutter.ActorAlign.START,
                can_focus: true,
                reactive: true,
                track_hover: true,
            });
            stateFileButton.connect('clicked', () => {
                if (this._stateFile.query_exists(null)) {
                    Gio.AppInfo.launch_default_for_uri(this._stateFile.get_uri(), null);
                } else {
                    Main.notify('Gnome Shell Session Timer', 'No state file yet.');
                }
            });
            content.add_child(stateFileButton);

            dialog.contentLayout.add_child(content);

            dialog.setButtons([
                {
                    label: 'Close',
                    action: () => dialog.close(),
                    key: Clutter.KEY_Escape,
                    default: true,
                },
            ]);

            dialog.open();
        }

        /**
         * Watching org.gnome.ScreenSaver over D-Bus previously left the
         * timer stuck "locked" forever: on this system that interface is
         * served by gnome-settings-daemon's ScreensaverProxy, a separate,
         * demand-activated process bridging the shell's private lock
         * state onto the legacy D-Bus API. If that bridge process isn't
         * running when a lock/unlock happens, the ActiveChanged signal is
         * simply lost — D-Bus signals aren't queued for later delivery.
         * Since this extension runs inside the shell process itself,
         * reading Main.screenShield directly removes that unreliable
         * extra hop entirely.
         */
        _setupScreenShieldWatch() {
            this._screenShieldSignalId = Main.screenShield.connect(
                'active-changed', () => this._onLockStateChanged(Main.screenShield.active)
            );

            this._startTracking(Main.screenShield.active);
        }

        async _startTracking(isLocked) {
            if (this._destroyed)
                return;

            const nowUsec = GLib.get_real_time();
            this._today = this._dateKey(nowUsec);
            this._isLocked = isLocked;
            const state = await this._readStateForToday();
            this._accumulatedSeconds = state.accumulatedSeconds;
            this._pausedSeconds = state.pausedSeconds;
            this._breakCount = state.breakCount;

            // enable() may have raced disable() while the read was in flight.
            if (this._destroyed)
                return;

            this._segmentStartUsec = nowUsec;
            // Discard a persisted session start if we're coming back up
            // already locked — whatever happened during the gap before
            // this run started isn't something we can account for.
            this._sessionStartUsec = this._isLocked ? null : (state.sessionStartUsec ?? nowUsec);

            this._updateLabel();
            this._saveState();

            this._tickId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, TICK_INTERVAL_SECONDS, () => {
                this._onTick();
                return GLib.SOURCE_CONTINUE;
            });
        }

        _dateKey(nowUsec) {
            return GLib.DateTime.new_from_unix_local(Math.floor(nowUsec / 1e6)).format('%Y-%m-%d');
        }

        async _readStateForToday() {
            const empty = { accumulatedSeconds: 0, pausedSeconds: 0, breakCount: 0, sessionStartUsec: null };
            try {
                const [contents] = await this._stateFile.load_contents_async(null);
                const state = JSON.parse(new TextDecoder().decode(contents));
                if (state.date === this._today) {
                    return {
                        accumulatedSeconds: typeof state.accumulatedSeconds === 'number' ? state.accumulatedSeconds : 0,
                        pausedSeconds: typeof state.pausedSeconds === 'number' ? state.pausedSeconds : 0,
                        breakCount: typeof state.breakCount === 'number' ? state.breakCount : 0,
                        sessionStartUsec: typeof state.sessionStartUsec === 'number' ? state.sessionStartUsec : null,
                    };
                }
            } catch (e) {
                // No state file yet, or it's unreadable/corrupt — start from 0.
            }
            return empty;
        }

        _saveState() {
            const payload = JSON.stringify({
                date: this._today,
                accumulatedSeconds: Math.round(this._accumulatedSeconds),
                pausedSeconds: Math.round(this._pausedSeconds),
                breakCount: this._breakCount,
                sessionStartUsec: this._sessionStartUsec,
            });
            this._stateFile.replace_contents_async(
                new GLib.Bytes(payload).get_data(), null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION, null
            ).catch(e => {
                // Best-effort persistence; losing one checkpoint isn't fatal.
            });
        }

        _openCurrentSessionCsv() {
            const file = this._csvFileForYear(this._currentYear());
            if (file.query_exists(null))
                Gio.AppInfo.launch_default_for_uri(file.get_uri(), null);
            else
                Main.notify('Gnome Shell Session Timer', 'No session log yet for this year.');
        }

        _openSessionCsvFolder() {
            Gio.AppInfo.launch_default_for_uri(this._csvDir().get_uri(), null);
        }

        /**
         * The directory sessions-*.csv files live in — outside the
         * extension's own install directory, so the log survives even if
         * the extension is reinstalled elsewhere.
         */
        _csvDir() {
            if (!this._csvDirFile) {
                const dirPath = GLib.build_filenamev([GLib.get_user_data_dir(), 'gnome-shell-session-timer']);
                GLib.mkdir_with_parents(dirPath, 0o755);
                this._csvDirFile = Gio.File.new_for_path(dirPath);
            }
            return this._csvDirFile;
        }

        _currentYear() {
            return GLib.DateTime.new_now_local().format('%Y');
        }

        _csvFileForYear(year) {
            return this._csvDir().get_child(`sessions-${year}.csv`);
        }

        _formatCsvDateTime(usec) {
            return GLib.DateTime.new_from_unix_local(Math.floor(usec / 1e6)).format('%Y-%m-%d %H:%M:%S');
        }

        _formatDurationHHMM(totalSeconds) {
            const seconds = Math.max(0, Math.round(totalSeconds));
            const hours = Math.floor(seconds / 3600);
            const minutes = Math.floor((seconds % 3600) / 60);
            return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
        }

        /**
         * Appends one completed work session to that session's year's CSV
         * file (created with a header if it doesn't exist yet), queued
         * behind any write already in flight so concurrent calls can't
         * race each other's read-modify-write. Sessions cut short by a
         * grace-period lock never reach here — only confirmed breaks
         * (manual pause, or a lock that outlasted the grace period) close
         * a session and log it.
         */
        _appendSessionToCsv(startUsec, endUsec) {
            if (startUsec === null || endUsec === null || endUsec <= startUsec)
                return;

            const row = `${this._formatCsvDateTime(startUsec)};${this._formatCsvDateTime(endUsec)};` +
                `${this._formatDurationHHMM((endUsec - startUsec) / 1e6)}\n`;
            const year = GLib.DateTime.new_from_unix_local(Math.floor(endUsec / 1e6)).format('%Y');
            const file = this._csvFileForYear(year);

            this._csvWriteQueue = (this._csvWriteQueue || Promise.resolve()).then(async () => {
                let existing = '';
                try {
                    const [contents] = await file.load_contents_async(null);
                    existing = new TextDecoder().decode(contents);
                } catch (e) {
                    existing = 'start;end;total\n';
                }
                await file.replace_contents_async(
                    new GLib.Bytes(existing + row).get_data(), null, false,
                    Gio.FileCreateFlags.REPLACE_DESTINATION, null
                );
            }).catch(e => {
                // Best-effort logging; a lost row shouldn't break tracking.
            });
        }

        /**
         * Folds the currently-open segment into whichever bucket it
         * belongs to — this._accumulatedSeconds while active, or
         * this._pausedSeconds while locked or manually paused — using
         * the state as of *before* this call, then restarts the segment
         * at `nowUsec`. Called from every tick and state transition so
         * both accumulators are always an up-to-date checkpoint.
         */
        _foldOpenSegment(nowUsec) {
            if (this._segmentStartUsec === null)
                return;

            const elapsedSeconds = (nowUsec - this._segmentStartUsec) / 1e6;
            if (this._isLocked || this._isPaused)
                this._pausedSeconds += elapsedSeconds;
            else
                this._accumulatedSeconds += elapsedSeconds;
            this._segmentStartUsec = nowUsec;
        }

        _rolloverIfNeeded(nowUsec) {
            const todayKey = this._dateKey(nowUsec);
            if (todayKey === this._today)
                return;

            this._today = todayKey;
            this._accumulatedSeconds = 0;
            this._pausedSeconds = 0;
            this._breakCount = 0;
            this._segmentStartUsec = nowUsec;
        }

        _onLockStateChanged(isLockedNow) {
            if (this._destroyed || isLockedNow === this._isLocked)
                return;

            const nowUsec = GLib.get_real_time();
            this._rolloverIfNeeded(nowUsec);

            const wasActive = !this._isLocked && !this._isPaused;
            this._foldOpenSegment(nowUsec);

            this._isLocked = isLockedNow;
            this._segmentStartUsec = nowUsec;

            if (wasActive && (this._isLocked || this._isPaused))
                this._breakCount++;

            // Only a lock that interrupted active (unpaused) time is a
            // grace-period candidate — a lock on top of an existing manual
            // pause doesn't start a new break, so it shouldn't get one
            // un-done either.
            if (this._isLocked && wasActive) {
                this._lockBreakPausedStart = this._pausedSeconds;
                this._lockBreakDate = this._today;
                this._lockStartUsec = nowUsec;
            } else if (!this._isLocked && this._lockBreakPausedStart !== null) {
                this._resolveLockGracePeriod(nowUsec);
            }

            // Catches the case where tracking started already locked (so no
            // lock-break was ever opened above) and this is its first unlock.
            if (!this._isLocked && !this._isPaused && this._sessionStartUsec === null)
                this._sessionStartUsec = nowUsec;

            this._updateLabel();
            this._saveState();
        }

        /**
         * Called right after a lock-caused break ends (screen unlocked).
         * If the lock lasted no longer than the configured grace period,
         * it was probably a short interruption rather than a real break —
         * e.g. stepping away to answer a quick question — so its time is
         * moved back from paused into accumulated and the break it
         * triggered is un-counted, and the work session it interrupted
         * carries on uninterrupted. Otherwise it's a confirmed real break:
         * the session that was running before the lock gets logged to the
         * CSV, and a new one starts now that the screen is unlocked again.
         */
        _resolveLockGracePeriod(nowUsec) {
            const pausedStart = this._lockBreakPausedStart;
            const lockStartUsec = this._lockStartUsec;
            const sameDay = this._lockBreakDate === this._today;
            this._lockBreakPausedStart = null;
            this._lockBreakDate = null;
            this._lockStartUsec = null;

            // A day rollover happened while locked — this._pausedSeconds was
            // reset for the new day and no longer relates to pausedStart, so
            // grace can't be evaluated. Treat it as a confirmed break below.
            const graceMinutes = this._settings.get_double('lock-grace-minutes');
            const lockDurationSeconds = sameDay ? this._pausedSeconds - pausedStart : null;
            const withinGrace = sameDay && graceMinutes > 0 && lockDurationSeconds <= graceMinutes * 60;

            if (withinGrace) {
                this._pausedSeconds -= lockDurationSeconds;
                this._accumulatedSeconds += lockDurationSeconds;
                this._breakCount = Math.max(0, this._breakCount - 1);
                return;
            }

            this._appendSessionToCsv(this._sessionStartUsec, lockStartUsec);
            this._sessionStartUsec = nowUsec;
        }

        _onTick() {
            const nowUsec = GLib.get_real_time();
            this._rolloverIfNeeded(nowUsec);
            this._foldOpenSegment(nowUsec);
            this._updateLabel();
            this._saveState();
        }

        _updateLabel() {
            const totalSeconds = Math.max(0, Math.round(this._accumulatedSeconds));
            const hours = Math.floor(totalSeconds / 3600);
            const minutes = Math.floor((totalSeconds % 3600) / 60);
            const text = `${hours}h ${minutes.toString().padStart(2, '0')}m`;
            let panelText = text;

            const maxWorkingHours = this._settings.get_double('max-working-hours');
            const barEnabled = maxWorkingHours > 0;

            if (barEnabled) {
                const rawFraction = totalSeconds / (maxWorkingHours * 3600);
                this._progressFraction = Math.min(1, Math.max(0, rawFraction));
                this._applyProgressBarFraction();

                if (this._settings.get_boolean('show-percentage'))
                    panelText += ` (${Math.round(rawFraction * 100)}%)`;
            }
            this._progressBarItem.visible = barEnabled;
            this._barEnabled = barEnabled;
            this._icon.queue_repaint();

            this._label.set_text(panelText);
            let suffix = '';
            if (this._isPaused)
                suffix = ' (paused)';
            else if (this._isLocked)
                suffix = ' (locked)';
            this._menuStatusLabel.set_text(`Active today: ${text}${suffix}`);

            const pausedTotalSeconds = Math.max(0, Math.round(this._pausedSeconds));
            const pausedHours = Math.floor(pausedTotalSeconds / 3600);
            const pausedMinutes = Math.floor((pausedTotalSeconds % 3600) / 60);
            const pausedText = `${pausedHours}h ${pausedMinutes.toString().padStart(2, '0')}m`;
            const breakWord = this._breakCount === 1 ? 'break' : 'breaks';
            this._menuPausedLabel.set_text(`Paused today: ${pausedText} (${this._breakCount} ${breakWord})`);

            this._pauseButton.set_label(this._isPaused ? '▶' : '⏹');
            this._pauseButton.set_style_class_name(
                `session-timer-pause-button${this._isPaused ? '' : ' session-timer-pause-button-stopped'}`
            );
            // Hidden while locked: stopping/resuming makes no sense on the
            // lock screen, and the panel stays visible there (session-modes
            // includes 'unlock-dialog'), so anyone at the lock screen could
            // otherwise toggle it. The user's own paused/active state is
            // untouched by locking, so it's restored as-is on unlock.
            this._pauseButton.visible = !this._isLocked;
        }

        /**
         * Toggles a user-requested pause: freezes accumulation until
         * resumed, independent of screen-lock state.
         */
        _togglePause() {
            if (this._destroyed || this._isLocked)
                return;

            const nowUsec = GLib.get_real_time();
            this._rolloverIfNeeded(nowUsec);

            const wasActive = !this._isLocked && !this._isPaused;
            this._foldOpenSegment(nowUsec);

            this._isPaused = !this._isPaused;
            this._segmentStartUsec = nowUsec;

            if (wasActive && (this._isLocked || this._isPaused)) {
                this._breakCount++;
                // Manual pauses have no grace period — always a confirmed
                // real break, so close out the session immediately.
                this._appendSessionToCsv(this._sessionStartUsec, nowUsec);
                this._sessionStartUsec = null;
            } else if (!wasActive && !this._isPaused) {
                // Resuming from a manual pause starts a fresh session.
                this._sessionStartUsec = nowUsec;
            }

            this._updateLabel();
            this._saveState();
        }

        /**
         * Draws the panel progress icon: a borderless bar filled
         * left-to-right with today's progress fraction towards the
         * working-hours target. With no target configured (or no time
         * tracked yet), nothing is drawn.
         */
        _drawBatteryIcon(area) {
            const [w, h] = area.get_surface_size();
            const cr = area.get_context();

            const margin = 1;
            const bodyX0 = margin, bodyX1 = w - margin;
            const bodyY0 = margin, bodyY1 = h - margin;

            if (this._barEnabled) {
                const fraction = Math.min(1, Math.max(0, this._progressFraction || 0));
                const fillMaxWidth = bodyX1 - bodyX0;

                // Guarantee at least one visible pixel of fill as soon as
                // any time is tracked, since the body is only a few pixels
                // wide and a strictly linear mapping would round tiny
                // fractions down to nothing.
                let fillWidth = Math.round(fraction * fillMaxWidth);
                if (fraction > 0)
                    fillWidth = Math.max(1, fillWidth);

                if (fillWidth > 0) {
                    const gradient = new Cairo.LinearGradient(bodyX0, 0, bodyX1, 0);
                    for (const [pos, r, g, b] of RAINBOW_GRADIENT_STOPS)
                        gradient.addColorStopRGB(pos, r, g, b);
                    cr.setSource(gradient);
                    cr.rectangle(bodyX0, bodyY0, fillWidth, bodyY1 - bodyY0);
                    cr.fill();
                }
            }

            cr.$dispose();
        }

        _applyProgressBarFraction() {
            // get_width() falls back to a "natural size" query when the
            // actor isn't currently mapped, which for this BinLayout track
            // just reflects the fill's own last-set width — that would
            // create a feedback loop shrinking the bar on every tick after
            // the menu closes. get_allocation_box() returns the actor's
            // last real allocated geometry instead, without that fallback.
            const trackWidth = this._progressBarTrack.get_allocation_box().get_width();
            if (trackWidth > 0)
                this._progressBarFill.set_width(Math.round(this._progressFraction * trackWidth));
        }

        destroy() {
            this._destroyed = true;

            if (this._aboutDialog) {
                if (this._aboutDialogDestroyId) {
                    this._aboutDialog.disconnect(this._aboutDialogDestroyId);
                    this._aboutDialogDestroyId = null;
                }
                this._aboutDialog.destroy();
                this._aboutDialog = null;
            }

            if (this._tickId) {
                GLib.Source.remove(this._tickId);
                this._tickId = null;
            }

            if (this._settings && this._settingsChangedId) {
                this._settings.disconnect(this._settingsChangedId);
                this._settingsChangedId = null;
            }
            this._settings = null;

            if (this._screenShieldSignalId) {
                Main.screenShield.disconnect(this._screenShieldSignalId);
                this._screenShieldSignalId = null;
            }

            if (this._today !== null) {
                const nowUsec = GLib.get_real_time();
                this._rolloverIfNeeded(nowUsec);
                this._foldOpenSegment(nowUsec);
                this._segmentStartUsec = null;

                if (!this._isLocked && !this._isPaused) {
                    this._appendSessionToCsv(this._sessionStartUsec, nowUsec);
                    this._sessionStartUsec = null;
                }

                this._saveState();
            }

            super.destroy();
        }
    }
);

export default class SessionTimerExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._indicator = new SessionTimerIndicator(
            this.path, this.metadata, this._settings, () => this.openPreferences()
        );
        Main.panel.addToStatusArea(this.uuid, this._indicator, 1, 'center');
        this._pinRightOfClock();

        // Since we stay enabled through the lock screen (session-modes
        // includes 'unlock-dialog'), Panel re-lays out the center box to
        // match each session mode's panel config on every lock/unlock,
        // which undoes the pin above. Re-pin on every such transition.
        this._sessionModeSignalId = Main.sessionMode.connect(
            'updated', () => this._pinRightOfClock()
        );
    }

    /**
     * addToStatusArea's `position` argument is only a sort key among
     * indicators present in the center box at insertion time — if another
     * indicator races to claim the same slot while extensions are
     * re-enabled after the lock screen, insertion order (and thus left/
     * right placement relative to the clock) isn't guaranteed. Pin our
     * actor directly after the clock's in the center box so the ordering
     * can't flip regardless of what else is being added at the same time.
     */
    _pinRightOfClock() {
        const centerBox = Main.panel._centerBox;
        const dateMenu = Main.panel.statusArea.dateMenu;
        if (centerBox && dateMenu && this._indicator)
            centerBox.set_child_above_sibling(this._indicator.container, dateMenu.container);
    }

    disable() {
        if (this._sessionModeSignalId) {
            Main.sessionMode.disconnect(this._sessionModeSignalId);
            this._sessionModeSignalId = null;
        }
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
        this._settings = null;
    }
}
