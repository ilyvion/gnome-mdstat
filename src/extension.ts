import Clutter from "gi://Clutter";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import St from "gi://St";

import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as PanelMenu from "resource:///org/gnome/shell/ui/panelMenu.js";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";

import {
  QUERY_COMMAND,
  arrayDetails,
  arrayHeading,
  arraySeverity,
  panelSummary,
  parseQueryOutput,
  slotStates,
  worstSeverity,
  type MdArray,
} from "./mdstat.js";

Gio._promisify(Gio.Subprocess.prototype, "communicate_utf8_async");

const ICON_NORMAL = "drive-multidisk-symbolic";
const ICON_WARNING = "dialog-warning-symbolic";
const ICON_ERROR = "dialog-error-symbolic";
const ICON_UNREACHABLE = "network-error-symbolic";

const STATE_CLASSES = ["mdstat-warning", "mdstat-error", "mdstat-dim"];

export default class MdstatExtension extends Extension {
  private _settings: Gio.Settings | null = null;
  private _settingsChangedId = 0;
  private _indicator: PanelMenu.Button | null = null;
  private _box: St.BoxLayout | null = null;
  private _icon: St.Icon | null = null;
  private _pips: St.BoxLayout | null = null;
  private _label: St.Label | null = null;
  private _arraysSection: PopupMenu.PopupMenuSection | null = null;
  private _statusItem: PopupMenu.PopupMenuItem | null = null;
  private _cancellable: Gio.Cancellable | null = null;
  private _pollSourceId = 0;

  override enable(): void {
    this._settings = this.getSettings();
    this._buildIndicator();
    this._settingsChangedId = this._settings.connect("changed", () =>
      this._refresh(),
    );
    this._refresh();
  }

  override disable(): void {
    this._clearPollTimer();
    this._cancellable?.cancel();
    this._cancellable = null;

    if (this._settings && this._settingsChangedId)
      this._settings.disconnect(this._settingsChangedId);
    this._settingsChangedId = 0;
    this._settings = null;

    this._indicator?.destroy();
    this._indicator = null;
    this._box = null;
    this._icon = null;
    this._pips = null;
    this._label = null;
    this._arraysSection = null;
    this._statusItem = null;
  }

  private _buildIndicator(): void {
    this._indicator = new PanelMenu.Button(0.0, this.metadata.name, false);

    this._box = new St.BoxLayout({
      style_class: "panel-status-indicators-box",
    });
    this._icon = new St.Icon({
      icon_name: ICON_NORMAL,
      style_class: "system-status-icon mdstat-dim",
    });
    this._label = new St.Label({
      style_class: "mdstat-label",
      y_align: Clutter.ActorAlign.CENTER,
      visible: false,
    });
    this._pips = new St.BoxLayout({
      style_class: "mdstat-pips",
      y_align: Clutter.ActorAlign.CENTER,
      visible: false,
    });
    this._box.add_child(this._icon);
    this._box.add_child(this._pips);
    this._box.add_child(this._label);
    this._indicator.add_child(this._box);

    const menu = this._indicator.menu as PopupMenu.PopupMenu;

    this._arraysSection = new PopupMenu.PopupMenuSection();
    menu.addMenuItem(this._arraysSection);
    menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

    this._statusItem = new PopupMenu.PopupMenuItem(
      "Waiting for first update…",
      {
        reactive: false,
        can_focus: false,
      },
    );
    this._statusItem.label.add_style_class_name("mdstat-detail");
    menu.addMenuItem(this._statusItem);

    menu.addAction("Refresh", () => this._refresh());
    menu.addAction("Settings", () => this.openPreferences());

    Main.panel.addToStatusArea(this.uuid, this._indicator);
  }

  private _clearPollTimer(): void {
    if (this._pollSourceId) GLib.source_remove(this._pollSourceId);
    this._pollSourceId = 0;
  }

  private _schedulePoll(seconds: number): void {
    this._clearPollTimer();
    this._pollSourceId = GLib.timeout_add_seconds(
      GLib.PRIORITY_DEFAULT,
      seconds,
      () => {
        this._pollSourceId = 0;
        this._refresh();
        return GLib.SOURCE_REMOVE;
      },
    );
  }

  /** Queries the arrays now, superseding any query in flight, and schedules the next poll. */
  private _refresh(): void {
    this._refreshAsync().catch((e) => console.error(e));
  }

  private async _refreshAsync(): Promise<void> {
    const settings = this._settings;
    if (!settings) return;

    this._clearPollTimer();
    this._cancellable?.cancel();
    const cancellable = new Gio.Cancellable();
    this._cancellable = cancellable;

    let arrays: MdArray[] | null = null;
    let error: string | null = null;
    try {
      arrays = parseQueryOutput(await this._runQuery(settings, cancellable));
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }

    // Superseded by a newer query, or the extension was disabled.
    if (this._cancellable !== cancellable) return;
    this._cancellable = null;

    if (arrays) {
      this._showArrays(arrays);
      const busy = arrays.some(
        (a) => arraySeverity(a) === "busy" || a.progress !== null,
      );
      this._schedulePoll(
        settings.get_int(busy ? "active-poll-interval" : "poll-interval"),
      );
    } else {
      this._showError(error ?? "Unknown error");
      this._schedulePoll(settings.get_int("poll-interval"));
    }
  }

  private async _runQuery(
    settings: Gio.Settings,
    cancellable: Gio.Cancellable,
  ): Promise<string> {
    const remoteCommand = settings.get_string("remote-command").trim();
    const timeout = settings.get_int("command-timeout");
    // exec makes the remote command replace the shell, so killing the
    // subprocess kills the command itself.
    const script = remoteCommand
      ? `exec ${remoteCommand} ${GLib.shell_quote(QUERY_COMMAND)}`
      : QUERY_COMMAND;

    const launcher = new Gio.SubprocessLauncher({
      flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
    });
    // Keeps ssh from opening a graphical password prompt on every poll.
    launcher.setenv("SSH_ASKPASS_REQUIRE", "never", true);
    const proc = launcher.spawnv(["sh", "-c", script]);

    let timedOut = false;
    let timeoutId = GLib.timeout_add_seconds(
      GLib.PRIORITY_DEFAULT,
      timeout,
      () => {
        timeoutId = 0;
        timedOut = true;
        proc.force_exit();
        return GLib.SOURCE_REMOVE;
      },
    );
    const cancelId = cancellable.connect(() => proc.force_exit());

    try {
      const [stdout, stderr] = await proc.communicate_utf8_async(
        null,
        cancellable,
      );
      if (timedOut) throw new Error(`No response after ${timeout} seconds`);
      if (!proc.get_successful()) {
        const status = proc.get_if_exited()
          ? `status ${proc.get_exit_status()}`
          : "a signal";
        throw new Error(stderr?.trim() || `Command exited with ${status}`);
      }
      return stdout ?? "";
    } finally {
      if (timeoutId) GLib.source_remove(timeoutId);
      cancellable.disconnect(cancelId);
    }
  }

  private _setPanelState(
    iconName: string,
    stateClass: string | null,
    text: string | null,
  ): void {
    if (!this._box || !this._icon || !this._label) return;

    this._icon.icon_name = iconName;
    for (const name of STATE_CLASSES) {
      this._box.remove_style_class_name(name);
      this._icon.remove_style_class_name(name);
    }
    if (stateClass) this._box.add_style_class_name(stateClass);

    this._label.text = text ?? "";
    this._label.visible = text !== null;
  }

  /**
   * Draws one pip per array position, grouped by array. The icon is shown
   * only when there is no pip to draw.
   */
  private _setPips(arrays: MdArray[]): void {
    if (!this._pips || !this._icon) return;

    this._pips.destroy_all_children();
    let count = 0;
    for (const array of arrays) {
      const group = new St.BoxLayout({ style_class: "mdstat-pip-group" });
      for (const state of slotStates(array)) {
        group.add_child(
          new St.Widget({
            style_class: `mdstat-pip mdstat-pip-${state}`,
            y_align: Clutter.ActorAlign.CENTER,
          }),
        );
        count++;
      }
      this._pips.add_child(group);
    }

    this._pips.visible = count > 0;
    this._icon.visible = count === 0;
  }

  private _showArrays(arrays: MdArray[]): void {
    const summary = panelSummary(arrays);
    this._setPips(arrays);

    if (arrays.length === 0) {
      this._setPanelState(ICON_NORMAL, "mdstat-dim", null);
    } else {
      switch (worstSeverity(arrays)) {
        case "error":
          this._setPanelState(ICON_ERROR, "mdstat-error", summary);
          break;
        case "warning":
          this._setPanelState(ICON_WARNING, "mdstat-warning", summary);
          break;
        default:
          this._setPanelState(ICON_NORMAL, null, summary);
      }
    }

    this._arraysSection?.removeAll();
    if (arrays.length === 0) this._addInfoItem("No md arrays found", []);
    for (const array of arrays)
      this._addInfoItem(arrayHeading(array), arrayDetails(array));

    const now = GLib.DateTime.new_now_local().format("%X");
    this._statusItem?.label.set_text(`Updated ${now}`);
  }

  private _showError(message: string): void {
    this._setPanelState(ICON_UNREACHABLE, null, null);
    this._setPips([]);
    this._arraysSection?.removeAll();
    this._addInfoItem("Status unavailable", message.split("\n"));

    const now = GLib.DateTime.new_now_local().format("%X");
    this._statusItem?.label.set_text(`Failed ${now}`);
  }

  private _addInfoItem(heading: string, details: string[]): void {
    // Non-reactive items are drawn dimmed, so interaction is disabled piecemeal instead.
    const item = new PopupMenu.PopupBaseMenuItem({
      activate: false,
      hover: false,
      can_focus: false,
    });
    const box = new St.BoxLayout({
      orientation: Clutter.Orientation.VERTICAL,
      x_expand: true,
    });
    box.add_child(
      new St.Label({ text: heading, style_class: "mdstat-heading" }),
    );
    for (const line of details)
      box.add_child(new St.Label({ text: line, style_class: "mdstat-detail" }));
    item.add_child(box);
    this._arraysSection?.addMenuItem(item);
  }
}
