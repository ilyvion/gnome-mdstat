// Parsing and formatting of md array state. This module has no GNOME
// dependencies so it can be loaded by the shell, the preferences process, and
// plain Node (for tests).

const ARRAY_ATTRIBUTES = [
  "md/array_state",
  "md/level",
  "md/raid_disks",
  "md/degraded",
  "md/sync_action",
  "md/sync_completed",
  "md/sync_speed",
  "md/mismatch_cnt",
  "md/dev-*/state",
  "md/dev-*/slot",
  "size",
];

/**
 * POSIX shell command that prints every attribute as a `path:value` line.
 * It always exits 0; a host without arrays prints nothing.
 */
export const QUERY_COMMAND = `grep -s . ${ARRAY_ATTRIBUTES.map((a) => `/sys/block/md*/${a}`).join(" ")}; true`;

export interface Member {
  /** Kernel device name, e.g. `sdb1`. */
  name: string;
  /** Comma separated flags from sysfs, e.g. `in_sync`, `faulty`, `spare`. */
  state: string;
  /** Position in the array; null for devices that hold no position, e.g. idle spares. */
  slot: number | null;
}

/** Condition of one position in an array. */
export type SlotState = "ok" | "rebuilding" | "failed" | "missing";

export interface Progress {
  /** 0–100. */
  percent: number;
  /** KiB/s. */
  speed: number | null;
  /** Seconds until completion at the current speed. */
  eta: number | null;
}

export interface MdArray {
  /** Kernel device name, e.g. `md0`. */
  name: string;
  level: string;
  arrayState: string;
  raidDisks: number;
  /** Number of missing member devices. */
  degraded: number;
  /** `idle`, `resync`, `recover`, `check`, `repair`, `reshape` or `frozen`; null when the level has no redundancy. */
  syncAction: string | null;
  /** Set while a sync action is running. */
  progress: Progress | null;
  mismatchCount: number;
  sizeBytes: number;
  members: Member[];
}

export type Severity = "ok" | "busy" | "warning" | "error";

const SECTOR_SIZE = 512;
const FAILED_STATES = new Set(["inactive", "broken"]);
const IDLE_ACTIONS = new Set(["idle", "frozen"]);

function toInt(value: string | undefined): number {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) ? n : 0;
}

function parseProgress(
  completed: string | undefined,
  speed: string | undefined,
): Progress | null {
  const match = completed?.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (!match) return null;

  const done = Number(match[1]);
  const total = Number(match[2]);
  if (total <= 0) return null;

  const kibPerSecond = Number.parseInt(speed ?? "", 10);
  const hasSpeed = Number.isFinite(kibPerSecond) && kibPerSecond > 0;
  const remainingKib = ((total - done) * SECTOR_SIZE) / 1024;

  return {
    percent: Math.min(100, (done / total) * 100),
    speed: hasSpeed ? kibPerSecond : null,
    eta: hasSpeed ? Math.round(remainingKib / kibPerSecond) : null,
  };
}

/** Parses the output of {@link QUERY_COMMAND}. */
export function parseQueryOutput(output: string): MdArray[] {
  const attributes = new Map<string, Map<string, string>>();

  for (const line of output.split("\n")) {
    const match = line.match(/^\/sys\/block\/(md[^/]+)\/([^:]+):(.*)$/);
    if (!match) continue;

    const [, name, attribute, value] = match;
    let entry = attributes.get(name);
    if (!entry) {
      entry = new Map();
      attributes.set(name, entry);
    }
    entry.set(attribute, value.trim());
  }

  const arrays: MdArray[] = [];
  for (const [name, attrs] of attributes) {
    // Partitions of an array show up as md0p1 etc. and have no md/ directory.
    if (!attrs.has("md/array_state")) continue;

    const members: Member[] = [];
    for (const [attribute, value] of attrs) {
      const member = attribute.match(/^md\/dev-(.+)\/state$/);
      if (!member) continue;

      const slot = Number.parseInt(
        attrs.get(`md/dev-${member[1]}/slot`) ?? "",
        10,
      );
      members.push({
        name: member[1],
        state: value,
        slot: Number.isFinite(slot) ? slot : null,
      });
    }
    members.sort(
      (a, b) =>
        (a.slot ?? Infinity) - (b.slot ?? Infinity) ||
        a.name.localeCompare(b.name),
    );

    const syncAction = attrs.get("md/sync_action") ?? null;
    arrays.push({
      name,
      level: attrs.get("md/level") ?? "unknown",
      arrayState: attrs.get("md/array_state") ?? "unknown",
      raidDisks: toInt(attrs.get("md/raid_disks")),
      degraded: toInt(attrs.get("md/degraded")),
      syncAction,
      progress: isBusy(syncAction)
        ? parseProgress(
            attrs.get("md/sync_completed"),
            attrs.get("md/sync_speed"),
          )
        : null,
      mismatchCount: toInt(attrs.get("md/mismatch_cnt")),
      sizeBytes: toInt(attrs.get("size")) * SECTOR_SIZE,
      members,
    });
  }

  return arrays.sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true }),
  );
}

function isBusy(syncAction: string | null): boolean {
  return syncAction !== null && !IDLE_ACTIONS.has(syncAction);
}

export function arraySeverity(array: MdArray): Severity {
  if (FAILED_STATES.has(array.arrayState)) return "error";
  if (
    array.degraded > 0 ||
    array.members.some((m) => m.state.includes("faulty"))
  )
    return "warning";
  if (isBusy(array.syncAction)) return "busy";
  return "ok";
}

/**
 * The condition of every position in the array, in slot order. This is the
 * information /proc/mdstat shows as `[UU_]`.
 */
export function slotStates(array: MdArray): SlotState[] {
  const states: SlotState[] = [];
  for (let slot = 0; slot < array.raidDisks; slot++) {
    const occupants = array.members.filter((m) => m.slot === slot);
    if (occupants.some((m) => m.state.includes("in_sync"))) states.push("ok");
    else if (occupants.some((m) => !m.state.includes("faulty")))
      states.push("rebuilding");
    else if (occupants.length > 0) states.push("failed");
    else states.push("missing");
  }
  return states;
}

const SEVERITY_ORDER: Severity[] = ["ok", "busy", "warning", "error"];

export function worstSeverity(arrays: MdArray[]): Severity {
  return arrays
    .map(arraySeverity)
    .reduce(
      (worst, s) =>
        SEVERITY_ORDER.indexOf(s) > SEVERITY_ORDER.indexOf(worst) ? s : worst,
      "ok" as Severity,
    );
}

/** Short text for the top bar, or null when the array needs no attention. */
export function arraySummary(array: MdArray): string | null {
  const parts: string[] = [];

  if (FAILED_STATES.has(array.arrayState)) parts.push(array.arrayState);
  else if (array.degraded > 0) parts.push("degraded");

  if (isBusy(array.syncAction)) {
    parts.push(
      array.progress
        ? `${array.syncAction} ${formatPercent(array.progress.percent)}`
        : `${array.syncAction}`,
    );
  }

  return parts.length > 0 ? parts.join(", ") : null;
}

/**
 * Text for the top bar covering all arrays, or null when none needs attention.
 * Array names are included when the host has more than one array.
 */
export function panelSummary(arrays: MdArray[]): string | null {
  const summaries = arrays
    .map((array) => ({ array, text: arraySummary(array) }))
    .filter((s): s is { array: MdArray; text: string } => s.text !== null);

  if (summaries.length === 0) return null;
  if (arrays.length === 1) return summaries[0].text;
  return summaries.map((s) => `${s.array.name}: ${s.text}`).join(" · ");
}

export function formatPercent(percent: number): string {
  return `${percent.toFixed(1)}%`;
}

export function formatSize(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 100 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

export function formatSpeed(kibPerSecond: number): string {
  return `${formatSize(kibPerSecond * 1024)}/s`;
}

export function formatDuration(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** One-line heading for the menu, e.g. `md1 — raid5, 3 devices, 7.2 TiB`. */
export function arrayHeading(array: MdArray): string {
  const devices =
    array.raidDisks === 1 ? "1 device" : `${array.raidDisks} devices`;
  return `${array.name} — ${array.level}, ${devices}, ${formatSize(array.sizeBytes)}`;
}

/** Detail lines for the menu. */
export function arrayDetails(array: MdArray): string[] {
  const lines: string[] = [];

  const state = [array.arrayState];
  if (array.degraded > 0) state.push(`degraded (${array.degraded} missing)`);
  if (array.syncAction !== null && !isBusy(array.syncAction))
    state.push(array.syncAction);
  if (array.mismatchCount > 0) state.push(`${array.mismatchCount} mismatches`);
  lines.push(state.join(", "));

  if (isBusy(array.syncAction)) {
    const progress = [`${array.syncAction}`];
    if (array.progress) {
      progress.push(formatPercent(array.progress.percent));
      if (array.progress.speed !== null)
        progress.push(formatSpeed(array.progress.speed));
      if (array.progress.eta !== null)
        progress.push(`${formatDuration(array.progress.eta)} left`);
    }
    lines.push(progress.join(" · "));
  }

  if (array.members.length > 0) {
    lines.push(
      array.members
        .map((m) => (m.state === "in_sync" ? m.name : `${m.name} (${m.state})`))
        .join("  "),
    );
  }

  return lines;
}
