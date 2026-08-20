import Cairo from 'gi://cairo';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');

const TICK_INTERVAL_SECONDS = 20;
const ICON_WIDTH = 18;
const ICON_HEIGHT = 10;

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
            this._tickId = null;
            this._screenShieldSignalId = null;
            this._destroyed = false;

            // variables for time tracking
            this._accumulatedSeconds = 0; // today's seconds while in actove state
            this._pausedSeconds = 0; // seconds in paused state; regardless of manual or automatic locks
            this._breakCount = 0; // number of breaks todays
            this._today = null; // 'YYYY-MM-DD', string of today's date for date rollover detection
            this._isLocked = false; // true if screen lock is active
            this._isPaused = false; // user-requested pause, independent of lock state
            this._segmentStartUsec = null; // GLib.get_real_time() value the current segment started at
            this._lockStartUsec = null; // wall-clock time when the current pending lock began

            // variables for csv logging
            this._sessionStartUsec = null;
            this._csvDirFile = null;

            // layout related variables
            const box = new St.BoxLayout({ style_class: 'panel-status-menu-box' });

            this._createIcon(box);

            this._label = new St.Label({
                text: '--h --m',
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'panel-button-text',
            });
            box.add_child(this._label);
            this.add_child(box);

            this._createMenu();

            // Watch changes of the screen lock state.
            this._screenShieldSignalId = Main.screenShield.connect(
                'active-changed', () => this._onLockStateChanged(Main.screenShield.active)
            );

            this._startTracking(Main.screenShield.active);
        }

        // a rainbow progress bar used as an icon.
        _createIcon(box) {
            this._barEnabled = false;
            this._icon = new St.DrawingArea({
                style_class: 'system-status-icon',
            });
            this._icon.set_size(ICON_WIDTH, ICON_HEIGHT);
            this._icon.y_align = Clutter.ActorAlign.CENTER;
            this._icon.connect('repaint', area => this._drawIcon(area));
            box.add_child(this._icon);
        }

        // builds popup menu
        _createMenu() {
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

            // Pause/resume toggle for user-requested breaks
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

            this._createProgressBarItem();

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

            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            const donateItem = new PopupMenu.PopupMenuItem('☕ Buy me a coffee');
            this.menu.addMenuItem(donateItem);
            donateItem.connect('activate', () => {
                const url = 'https://www.buymeacoffee.com/firebirdberlin';
                Gio.AppInfo.launch_default_for_uri(url, null);
            });
        }

        // Progress bar within the menu
        _createProgressBarItem() {
            this._progressBarItem = new PopupMenu.PopupBaseMenuItem({
                reactive: false,
                can_focus: false,
                style_class: 'session-timer-progress-item',
            });
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

            this._progress = 0;
            this._progressBarTrack.connect('notify::allocation', () => this._applyProgressBarFraction());
        }

        _notify(title, message) {
            const source = new MessageTray.Source({
                title: title,
                iconName: 'dialog-information-symbolic',
            });
            Main.messageTray.add(source);
            const notification = new MessageTray.Notification({
                source: source,
                title: title,
                body: message,
            });
            source.addNotification(notification);
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
                    this._notify('Gnome Shell Session Timer', 'No state file yet.');
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

        async _startTracking(isLocked) {
            if (this._destroyed)
                return;

            const nowUsec = GLib.get_real_time();
            this._today = this.getDateStr(nowUsec);
            this._isLocked = isLocked;
            const state = await this._readStateForToday();
            this._accumulatedSeconds = state.accumulatedSeconds;
            this._pausedSeconds = state.pausedSeconds;
            this._breakCount = state.breakCount;

            if (this._destroyed)
                return;

            if (state.sessionStartUsec !== null)
                this._appendSessionToCsv(state.sessionStartUsec, state.sessionHeartbeatUsec ?? state.sessionStartUsec);

            this._segmentStartUsec = nowUsec;
            this._sessionStartUsec = this._isLocked ? null : nowUsec;

            this._updateLabel();
            this._saveState();

            this._tickId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, TICK_INTERVAL_SECONDS, () => {
                this._onTick();
                return GLib.SOURCE_CONTINUE;
            });
        }

        getDateStr(nowUsec) {
            return GLib.DateTime.new_from_unix_local(Math.floor(nowUsec / 1e6)).format('%Y-%m-%d');
        }

        async _readStateForToday() {
            const empty = {
                accumulatedSeconds: 0, pausedSeconds: 0, breakCount: 0,
                sessionStartUsec: null, sessionHeartbeatUsec: null,
            };
            try {
                const [contents] = await this._stateFile.load_contents_async(null);
                const state = JSON.parse(new TextDecoder().decode(contents));

                // saved sessions shall survive day changes
                const sessionStartUsec = typeof state.sessionStartUsec === 'number' ? state.sessionStartUsec : null;
                const sessionHeartbeatUsec = typeof state.sessionHeartbeatUsec === 'number' ? state.sessionHeartbeatUsec : null;

                if (state.date === this._today) {
                    return {
                        accumulatedSeconds: typeof state.accumulatedSeconds === 'number' ? state.accumulatedSeconds : 0,
                        pausedSeconds: typeof state.pausedSeconds === 'number' ? state.pausedSeconds : 0,
                        breakCount: typeof state.breakCount === 'number' ? state.breakCount : 0,
                        sessionStartUsec, sessionHeartbeatUsec,
                    };
                }
                return { ...empty, sessionStartUsec, sessionHeartbeatUsec };
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
                sessionHeartbeatUsec: this._sessionStartUsec !== null ? GLib.get_real_time() : null,
            });
            const bytes = new GLib.Bytes(payload);
            this._stateFile.replace_contents_bytes_async(
                bytes, null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION, null
            ).catch(e => {
                // Best-effort persistence; losing one checkpoint isn't fatal.
            });
        }

        // ------------------------------ CSV handling --------------------------------------------

        _openCurrentSessionCsv() {
            const file = this._getCsvFileForYear(this._getCurrentYear());
            if (file.query_exists(null))
                Gio.AppInfo.launch_default_for_uri(file.get_uri(), null);
            else
                this._notify('Gnome Shell Session Timer', 'No session log yet for this year.');
        }

        _openSessionCsvFolder() {
            Gio.AppInfo.launch_default_for_uri(this._csvDir().get_uri(), null);
        }

        /**
         * The directory sessions-*.csv files live in; usually ~/.local/share/gnome-session-timer
         * The dir is created if non-existent.
         */
        _csvDir() {
            if (!this._csvDirFile) {
                const dirPath = GLib.build_filenamev([GLib.get_user_data_dir(), 'gnome-shell-session-timer']);
                GLib.mkdir_with_parents(dirPath, 0o755);
                this._csvDirFile = Gio.File.new_for_path(dirPath);
            }
            return this._csvDirFile;
        }

        _getCurrentYear() {
            return GLib.DateTime.new_now_local().format('%Y');
        }

        _getCsvFileForYear(year) {
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
         * Append a new row to the CSV log. Creates one file per year
         */
        _appendSessionToCsv(startUsec, endUsec) {
            if (startUsec === null || endUsec === null || endUsec <= startUsec)
                return;

            try {
                const row = `${this._formatCsvDateTime(startUsec)};${this._formatCsvDateTime(endUsec)};` +
                    `${this._formatDurationHHMM((endUsec - startUsec) / 1e6)}\n`;
                const year = GLib.DateTime.new_from_unix_local(Math.floor(endUsec / 1e6)).format('%Y');
                const file = this._getCsvFileForYear(year);
                const needsHeader = !file.query_exists(null);

                const outputStream = file.append_to(Gio.FileCreateFlags.NONE, null);
                const payload = needsHeader ? `start;end;total\n${row}` : row;
                outputStream.write_bytes(new GLib.Bytes(payload), null);
                outputStream.close(null);
            } catch (e) {
                logError(e, 'Failed to append session to CSV');
            }
        }

        // ------------------------------- time tracking helpers ----------------------------------
        /**
         * Flushes the time since the last checkpoint. This function is called whenever the
         * lock state changes, when the uses pauses or restarts time tracking and on cleanup
         */
        _flushTimeSegment(nowUsec) {
            if (this._segmentStartUsec === null)
                return;

            const elapsedSeconds = (nowUsec - this._segmentStartUsec) / 1e6;
            if (!this._isLocked && !this._isPaused) {
                this._accumulatedSeconds += elapsedSeconds;
            } else if (this._isPaused) {
                this._pausedSeconds += elapsedSeconds;
            }
            this._segmentStartUsec = nowUsec;
            this._rolloverIfNeeded(nowUsec);
        }

        /**
         * Resets the state if the date changes.
         **/
        _rolloverIfNeeded(nowUsec) {
            const todayKey = this.getDateStr(nowUsec);
            if (todayKey === this._today)
                return;

            this._today = todayKey;
            this._accumulatedSeconds = 0;
            this._pausedSeconds = 0;
            this._breakCount = 0;
        }

        _onLockStateChanged(isLockedNow) {
            if (this._destroyed || isLockedNow === this._isLocked)
                return;

            const nowUsec = GLib.get_real_time();
            const wasActive = !this._isLocked && !this._isPaused;
            this._flushTimeSegment(nowUsec);

            this._isLocked = isLockedNow;
            this._segmentStartUsec = nowUsec;

            if (this._isLocked && wasActive) {
                this._lockStartUsec = nowUsec;
            } else if (!this._isLocked && this._lockStartUsec !== null) {
                this._onLockEnded(nowUsec);
            }

            // Catches the case where tracking started already locked (so no
            // lock-break was ever opened above) and this is its first unlock.
            if (!this._isLocked && !this._isPaused && this._sessionStartUsec === null)
                this._sessionStartUsec = nowUsec;

            this._updateLabel();
            this._saveState();
        }

        /**
         * Handling the end of a screen lock session taking the configured grace period
         * into account.
         */
        _onLockEnded(nowUsec) {
            const lockStartUsec = this._lockStartUsec;
            const sameDay = this.getDateStr(lockStartUsec) === this._today;
            const lockDurationSeconds = sameDay ? (nowUsec - lockStartUsec) / 1e6 : null;

            const graceMinutes = this._settings.get_double('lock-grace-minutes');
            const withinGrace = sameDay && graceMinutes > 0 && lockDurationSeconds <= graceMinutes * 60;

            if (withinGrace) {
                this._accumulatedSeconds += lockDurationSeconds;
            } else {
                this._pausedSeconds += lockDurationSeconds;
                this._breakCount++;
                this._appendSessionToCsv(this._sessionStartUsec, lockStartUsec);
                this._sessionStartUsec = nowUsec;
            }

            this._lockStartUsec = null;
        }

        _onTick() {
            const nowUsec = GLib.get_real_time();
            this._flushTimeSegment(nowUsec);
            this._updateLabel();
            this._saveState();
        }

        _updateLabel() {
            const nowUsec = GLib.get_real_time();
            const totalSeconds = Math.max(0, Math.round(this._accumulatedSeconds));
            const hours = Math.floor(totalSeconds / 3600);
            const minutes = Math.floor((totalSeconds % 3600) / 60);
            const text = `${hours}h ${minutes.toString().padStart(2, '0')}m`;
            let panelText = text;

            const maxWorkingHours = this._settings.get_double('max-working-hours');
            const workingHoursConfigured = maxWorkingHours > 0;

            if (workingHoursConfigured) {
                const fraction = totalSeconds / (maxWorkingHours * 3600);
                this._progress = Math.min(1, Math.max(0, fraction));
                this._applyProgressBarFraction();

                if (this._settings.get_boolean('show-percentage'))
                    panelText += ` (${Math.round(fraction * 100)}%)`;
            }
            this._progressBarItem.visible = workingHoursConfigured;
            this._barEnabled = workingHoursConfigured;
            this._icon.queue_repaint();

            this._label.set_text(panelText);
            let suffix = '';
            if (this._isPaused)
                suffix = ' (paused)';
            else if (this._isLocked)
                suffix = ' (locked)';
            this._menuStatusLabel.set_text(`Active today: ${text}${suffix}`);


            let durationLockedUsec = 0;
            if (this._isLocked) {
                durationLockedUsec = (nowUsec - this._lockStartUsec) / 1e6;
            }
            const pausedTotalSeconds = Math.max(0, Math.round(this._pausedSeconds)) + durationLockedUsec;
            const pausedHours = Math.floor(pausedTotalSeconds / 3600);
            const pausedMinutes = Math.floor((pausedTotalSeconds % 3600) / 60);
            const pausedText = `${pausedHours}h ${pausedMinutes.toString().padStart(2, '0')}m`;
            const breakWord = this._breakCount === 1 ? 'break' : 'breaks';
            this._menuPausedLabel.set_text(`Paused today: ${pausedText} (${this._breakCount} ${breakWord})`);

            this._pauseButton.set_label(this._isPaused ? '▶' : '⏹');
            this._pauseButton.set_style_class_name(
                `session-timer-pause-button${this._isPaused ? '' : ' session-timer-pause-button-stopped'}`
            );

            // allow manual pausing only in unlocked state; anyone could modify the paused state otherwise
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
            const wasActive = !this._isLocked && !this._isPaused;
            this._flushTimeSegment(nowUsec);

            this._isPaused = !this._isPaused;
            this._segmentStartUsec = nowUsec;

            if (wasActive && this._isPaused) {
                // starting a manual break
                this._breakCount++;
                this._appendSessionToCsv(this._sessionStartUsec, nowUsec);
                this._sessionStartUsec = null;
            } else if (!wasActive && !this._isPaused) {
                // Resuming from a manual break
                this._sessionStartUsec = nowUsec;
            }

            this._updateLabel();
            this._saveState();
        }

        _drawIcon(area) {
            if (this._barEnabled) {
                const [w, h] = area.get_surface_size();
                const canvas = area.get_context();
                const margin = 1;
                const bodyX0 = margin, bodyX1 = w - margin;
                const bodyY0 = margin, bodyY1 = h - margin;
                const fraction = Math.min(1, Math.max(0, this._progress || 0));
                const fillMaxWidth = bodyX1 - bodyX0;

                let fillWidth = Math.round(fraction * fillMaxWidth);
                if (fraction > 0) {
                    fillWidth = Math.max(1, fillWidth);
                }

                if (fillWidth > 0) {
                    const gradient = new Cairo.LinearGradient(bodyX0, 0, bodyX1, 0);
                    for (const [pos, r, g, b] of RAINBOW_GRADIENT_STOPS) {
                        gradient.addColorStopRGB(pos, r, g, b);
                    }
                    canvas.setSource(gradient);
                    canvas.rectangle(bodyX0, bodyY0, fillWidth, bodyY1 - bodyY0);
                    canvas.fill();
                }
            }
        }

        _applyProgressBarFraction() {
            const trackWidth = this._progressBarTrack.get_allocation_box().get_width();
            if (trackWidth > 0)
                this._progressBarFill.set_width(Math.round(this._progress * trackWidth));
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
                this._flushTimeSegment(nowUsec);
                this._segmentStartUsec = null;
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

        // pin the extension every time the session mode changes
        this._sessionModeSignalId = Main.sessionMode.connect(
            'updated', () => this._pinRightOfClock()
        );
    }

    /**
     * Pins the extension to the right of the clock, so that the user always finds in in the
     * same location
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
