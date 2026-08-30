import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class SessionTimerPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage();
        window.add(page);

        const group = new Adw.PreferencesGroup({
            title: 'Working Hours',
            description: 'Shows progress towards a daily target.',
        });
        page.add(group);

        const hoursRow = new Adw.SpinRow({
            title: 'Maximum working hours',
            subtitle: 'Daily target, in hours. Set to 0 to hide the progress bar.',
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 24,
                step_increment: 0.25,
                page_increment: 1,
            }),
            digits: 2,
        });
        group.add(hoursRow);

        settings.bind(
            'max-working-hours',
            hoursRow,
            'value',
            Gio.SettingsBindFlags.DEFAULT
        );

        const showPercentageRow = new Adw.SwitchRow({
            title: 'Show percentage',
            subtitle: 'Adds the percentage number to the panel label.',
        });
        group.add(showPercentageRow);

        settings.bind(
            'show-percentage',
            showPercentageRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );

        const breaksGroup = new Adw.PreferencesGroup({
            title: 'Breaks',
            description: 'Controls when a locked screen counts as a break in working time.',
        });
        page.add(breaksGroup);

        const graceRow = new Adw.SpinRow({
            title: 'Lock grace period (minutes)',
            subtitle: 'Unlocking within this many minutes of locking counts as working time, ' +
                'not a break. Set to 0 to count every lock as a break immediately. Manual ' +
                'pauses are always counted as breaks.',
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 60,
                step_increment: 1,
                page_increment: 5,
            }),
            digits: 0,
        });
        breaksGroup.add(graceRow);

        settings.bind(
            'lock-grace-minutes',
            graceRow,
            'value',
            Gio.SettingsBindFlags.DEFAULT
        );
    }
}
