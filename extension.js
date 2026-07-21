import GObject from 'gi://GObject';
import St from 'gi://St';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';

const TICK_INTERVAL_SECONDS = 20;

const SessionTimeIndicator = GObject.registerClass(
    class SessionTimeIndicator extends PanelMenu.Button {
        _init(extensionPath, metadata) {
            super._init(0.0, 'Gnome Shell Session Time', false);

            this._metadata = metadata || {};
            this._stateFile = Gio.File.new_for_path(extensionPath).get_child('state.json');

            // Today's total, in whole seconds, from segments that have
            // already ended (screen got locked). The currently-open
            // unlocked segment (if any) is tracked separately below and
            // only folded in here on tick/lock/destroy, so we never lose
            // more than one tick's worth of data to a crash.
            this._accumulatedSeconds = 0;
            this._today = null; // 'YYYY-MM-DD', local time
            this._isLocked = false;
            this._segmentStartUsec = null; // GLib.get_real_time() value, or null while locked
            this._destroyed = false;

            this._tickId = null;
            this._screenSaverProxy = null;
            this._screenSaverSignalId = null;

            const box = new St.BoxLayout({ style_class: 'panel-status-menu-box' });

            this._icon = new St.Icon({
                icon_name: 'preferences-system-time-symbolic',
                style_class: 'system-status-icon',
                icon_size: 16,
            });
            box.add_child(this._icon);

            this._label = new St.Label({
                text: '--h --m',
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'panel-button-text',
            });
            box.add_child(this._label);
            this.add_child(box);

            this._menuStatusItem = new PopupMenu.PopupMenuItem('Active today: --', {
                reactive: false,
            });
            this.menu.addMenuItem(this._menuStatusItem);

            // Buy me a coffee — at the bottom of the main menu
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            const donateItem = new PopupMenu.PopupMenuItem('☕ Buy me a coffee');
            this.menu.addMenuItem(donateItem);
            donateItem.connect('activate', () => {
                const url = 'https://www.buymeacoffee.com/firebirdberlin';
                Gio.AppInfo.launch_default_for_uri(url, null);
            });

            // About — always the last item in the menu
            const aboutItem = new PopupMenu.PopupMenuItem('ℹ️ About');
            this.menu.addMenuItem(aboutItem);
            aboutItem.connect('activate', () => this._showAboutDialog());

            this._setupScreenSaverWatch();
        }

        /**
         * Shows a small modal dialog with the extension's name, version,
         * GitHub page, and donation link.
         */
        _showAboutDialog() {
            const name = this._metadata.name || 'Gnome Shell Session Time';
            const versionName = this._metadata['version-name'];
            const version = versionName
                ? `${versionName} (${this._metadata.version ?? 'unknown'})`
                : this._metadata.version ?? 'unknown';
            const githubUrl = 'https://github.com/firebirdberlin/gnome-shell-session-time';
            const donateUrl = 'https://www.buymeacoffee.com/firebirdberlin';

            const dialog = new ModalDialog.ModalDialog({
                styleClass: 'session-time-about-dialog',
                destroyOnClose: true,
            });

            const content = new St.BoxLayout({
                vertical: true,
                style_class: 'session-time-about-content',
            });

            content.add_child(new St.Label({
                text: name,
                style_class: 'session-time-about-title',
            }));

            content.add_child(new St.Label({
                text: `Version ${version}`,
                style_class: 'session-time-about-version',
            }));

            const githubButton = new St.Button({
                label: '🔗 github.com/firebirdberlin/gnome-shell-session-time',
                style_class: 'session-time-about-link',
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
                style_class: 'session-time-about-link',
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
                style_class: 'session-time-about-link',
                x_align: Clutter.ActorAlign.START,
                can_focus: true,
                reactive: true,
                track_hover: true,
            });
            stateFileButton.connect('clicked', () => {
                if (this._stateFile.query_exists(null)) {
                    Gio.AppInfo.launch_default_for_uri(this._stateFile.get_uri(), null);
                } else {
                    Main.notify('Gnome Shell Session Time', 'No state file yet.');
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
         * GNOME Shell implements org.gnome.ScreenSaver itself and reflects
         * lock state both as the "Active" property (picked up here via
         * g-properties-changed) and via GetActive(). We ask GetActive()
         * once up front to get the correct starting state even if the
         * extension is (re)enabled while the screen is already locked.
         */
        _setupScreenSaverWatch() {
            this._screenSaverProxy = new Gio.DBusProxy({
                g_connection: Gio.DBus.session,
                g_name: 'org.gnome.ScreenSaver',
                g_object_path: '/org/gnome/ScreenSaver',
                g_interface_name: 'org.gnome.ScreenSaver',
            });

            this._screenSaverSignalId = this._screenSaverProxy.connect(
                'g-properties-changed',
                (proxy, changedProperties) => {
                    const active = changedProperties.lookup_value('Active', null);
                    if (active)
                        this._onLockStateChanged(active.get_boolean());
                }
            );

            this._screenSaverProxy.call(
                'GetActive', null, Gio.DBusCallFlags.NONE, -1, null,
                (proxy, res) => {
                    let isLocked = false;
                    try {
                        isLocked = proxy.call_finish(res).deep_unpack()[0];
                    } catch (e) {
                        // Assume unlocked if the service can't tell us.
                    }
                    this._startTracking(isLocked);
                }
            );
        }

        _startTracking(isLocked) {
            if (this._destroyed)
                return;

            const nowUsec = GLib.get_real_time();
            this._today = this._dateKey(nowUsec);
            this._accumulatedSeconds = this._readAccumulatedSecondsForToday();
            this._isLocked = isLocked;
            this._segmentStartUsec = isLocked ? null : nowUsec;

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

        _readAccumulatedSecondsForToday() {
            try {
                const [ok, contents] = this._stateFile.load_contents(null);
                if (!ok)
                    return 0;
                const state = JSON.parse(new TextDecoder().decode(contents));
                if (state.date === this._today && typeof state.accumulatedSeconds === 'number')
                    return state.accumulatedSeconds;
            } catch (e) {
                // No state file yet, or it's unreadable/corrupt — start from 0.
            }
            return 0;
        }

        _saveState() {
            try {
                const payload = JSON.stringify({
                    date: this._today,
                    accumulatedSeconds: Math.round(this._accumulatedSeconds),
                });
                this._stateFile.replace_contents(
                    new GLib.Bytes(payload).get_data(), null, false,
                    Gio.FileCreateFlags.REPLACE_DESTINATION, null
                );
            } catch (e) {
                // Best-effort persistence; losing one checkpoint isn't fatal.
            }
        }

        /**
         * Folds the currently-open unlocked segment into
         * this._accumulatedSeconds and restarts it at `nowUsec`. No-op
         * while locked. Called from every tick and state transition so
         * this._accumulatedSeconds is always an up-to-date checkpoint.
         */
        _foldOpenSegment(nowUsec) {
            if (!this._isLocked && this._segmentStartUsec !== null) {
                this._accumulatedSeconds += (nowUsec - this._segmentStartUsec) / 1e6;
                this._segmentStartUsec = nowUsec;
            }
        }

        _rolloverIfNeeded(nowUsec) {
            const todayKey = this._dateKey(nowUsec);
            if (todayKey === this._today)
                return;

            this._today = todayKey;
            this._accumulatedSeconds = 0;
            this._segmentStartUsec = this._isLocked ? null : nowUsec;
        }

        _onLockStateChanged(isLockedNow) {
            if (this._destroyed || isLockedNow === this._isLocked)
                return;

            const nowUsec = GLib.get_real_time();
            this._rolloverIfNeeded(nowUsec);
            this._foldOpenSegment(nowUsec);

            this._isLocked = isLockedNow;
            this._segmentStartUsec = isLockedNow ? null : nowUsec;

            this._updateLabel();
            this._saveState();
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

            this._label.set_text(text);
            this._menuStatusItem.label.set_text(
                `Active today: ${text}${this._isLocked ? ' (locked)' : ''}`
            );
        }

        destroy() {
            this._destroyed = true;

            if (this._tickId) {
                GLib.Source.remove(this._tickId);
                this._tickId = null;
            }

            if (this._screenSaverProxy && this._screenSaverSignalId) {
                this._screenSaverProxy.disconnect(this._screenSaverSignalId);
                this._screenSaverSignalId = null;
            }
            this._screenSaverProxy = null;

            if (this._today !== null) {
                const nowUsec = GLib.get_real_time();
                this._rolloverIfNeeded(nowUsec);
                this._foldOpenSegment(nowUsec);
                this._segmentStartUsec = null;
                this._saveState();
            }

            super.destroy();
        }
    }
);

export default class SessionTimeExtension extends Extension {
    enable() {
        this._indicator = new SessionTimeIndicator(this.path, this.metadata);
        Main.panel.addToStatusArea(this.uuid, this._indicator, 1, 'center');
    }

    disable() {
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }
}
