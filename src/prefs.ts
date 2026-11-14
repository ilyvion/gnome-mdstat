import Adw from "gi://Adw";
import Gio from "gi://Gio";

import { ExtensionPreferences } from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js";

export default class MdstatPreferences extends ExtensionPreferences {
  override async fillPreferencesWindow(
    window: Adw.PreferencesWindow,
  ): Promise<void> {
    const settings = this.getSettings();
    const page = new Adw.PreferencesPage();

    const sourceGroup = new Adw.PreferencesGroup({
      title: "Source",
      description:
        "To monitor another host, enter a command that runs its argument there, " +
        "for example “ssh -i ~/.ssh/id_monitor server”. It has to work without " +
        "asking for a password. Leave empty to monitor this machine.",
    });
    const commandRow = new Adw.EntryRow({
      title: "Remote command",
      text: settings.get_string("remote-command"),
      show_apply_button: true,
    });
    commandRow.connect("apply", () =>
      settings.set_string("remote-command", commandRow.text.trim()),
    );
    sourceGroup.add(commandRow);
    sourceGroup.add(
      this._spinRow(
        settings,
        "command-timeout",
        "Timeout",
        "Seconds to wait for an answer",
        1,
        300,
      ),
    );
    page.add(sourceGroup);

    const pollGroup = new Adw.PreferencesGroup({ title: "Polling" });
    pollGroup.add(
      this._spinRow(
        settings,
        "poll-interval",
        "Interval",
        "Seconds between updates while idle",
        5,
        3600,
      ),
    );
    pollGroup.add(
      this._spinRow(
        settings,
        "active-poll-interval",
        "Interval during activity",
        "Seconds between updates while an array is syncing or checking",
        1,
        3600,
      ),
    );
    page.add(pollGroup);

    window.add(page);
  }

  private _spinRow(
    settings: Gio.Settings,
    key: string,
    title: string,
    subtitle: string,
    lower: number,
    upper: number,
  ): Adw.SpinRow {
    const row = Adw.SpinRow.new_with_range(lower, upper, 1);
    row.title = title;
    row.subtitle = subtitle;
    settings.bind(key, row, "value", Gio.SettingsBindFlags.DEFAULT);
    return row;
  }
}
