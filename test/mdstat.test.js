import assert from "node:assert/strict";
import { test } from "node:test";

import {
  arrayDetails,
  arrayHeading,
  arraySeverity,
  panelSummary,
  parseQueryOutput,
  slotStates,
} from "../dist/mdstat.js";

const IDLE = `
/sys/block/md1/md/array_state:clean
/sys/block/md1/md/level:raid5
/sys/block/md1/md/raid_disks:3
/sys/block/md1/md/degraded:0
/sys/block/md1/md/sync_action:idle
/sys/block/md1/md/sync_completed:none
/sys/block/md1/md/sync_speed:none
/sys/block/md1/md/mismatch_cnt:0
/sys/block/md1/md/dev-sdb1/state:in_sync
/sys/block/md1/md/dev-sdc1/state:in_sync
/sys/block/md1/md/dev-sde1/state:in_sync
/sys/block/md1/md/dev-sdb1/slot:2
/sys/block/md1/md/dev-sdc1/slot:0
/sys/block/md1/md/dev-sde1/slot:1
/sys/block/md1/size:15518394368
`;

test("idle array", () => {
  const [array, ...rest] = parseQueryOutput(IDLE);
  assert.equal(rest.length, 0);
  assert.equal(array.name, "md1");
  assert.equal(arraySeverity(array), "ok");
  assert.equal(array.progress, null);
  assert.equal(panelSummary([array]), null);
  assert.equal(arrayHeading(array), "md1 — raid5, 3 devices, 7.2 TiB");
  assert.deepEqual(arrayDetails(array), ["clean, idle", "sdc1  sde1  sdb1"]);
  assert.deepEqual(slotStates(array), ["ok", "ok", "ok"]);
});

test("check in progress", () => {
  const output = IDLE.replace("sync_action:idle", "sync_action:check")
    .replace("sync_completed:none", "sync_completed:3879598592 / 15518394368")
    .replace("sync_speed:none", "sync_speed:102400");
  const [array] = parseQueryOutput(output);
  assert.equal(arraySeverity(array), "busy");
  assert.equal(array.progress.percent, 25);
  assert.equal(array.progress.eta, 56830);
  assert.equal(panelSummary([array]), "check 25.0%");
  assert.deepEqual(arrayDetails(array), [
    "clean",
    "check · 25.0% · 100 MiB/s · 15h 47m left",
    "sdc1  sde1  sdb1",
  ]);
});

test("degraded array rebuilding", () => {
  const output = IDLE.replace("degraded:0", "degraded:1")
    .replace("sync_action:idle", "sync_action:recover")
    .replace("sync_completed:none", "sync_completed:155183943 / 15518394368")
    .replace("dev-sde1/state:in_sync", "dev-sde1/state:spare");
  const [array] = parseQueryOutput(output);
  assert.equal(arraySeverity(array), "warning");
  assert.equal(panelSummary([array]), "degraded, recover 1.0%");
  assert.equal(arrayDetails(array)[0], "clean, degraded (1 missing)");
  assert.equal(arrayDetails(array)[2], "sdc1  sde1 (spare)  sdb1");
  assert.deepEqual(slotStates(array), ["ok", "rebuilding", "ok"]);
});

test("missing, failed and spare devices", () => {
  const output = IDLE.replace("degraded:0", "degraded:2")
    .replace("dev-sdc1/state:in_sync", "dev-sdc1/state:faulty")
    .replace("dev-sde1/slot:1", "dev-sde1/slot:none")
    .replace("dev-sde1/state:in_sync", "dev-sde1/state:spare");
  const [array] = parseQueryOutput(output);
  assert.deepEqual(slotStates(array), ["failed", "missing", "ok"]);
  assert.equal(arrayDetails(array)[1], "sdc1 (faulty)  sdb1  sde1 (spare)");
});

test("several arrays, partitions and arrays without redundancy", () => {
  const output = `${IDLE}
/sys/block/md10/md/array_state:clean
/sys/block/md10/md/level:raid0
/sys/block/md10/md/raid_disks:2
/sys/block/md10/size:1000
/sys/block/md2/md/array_state:inactive
/sys/block/md2/md/level:raid1
/sys/block/md1p1/size:500
`;
  const arrays = parseQueryOutput(output);
  assert.deepEqual(
    arrays.map((a) => a.name),
    ["md1", "md2", "md10"],
  );
  assert.equal(arrays[2].syncAction, null);
  assert.equal(arraySeverity(arrays[2]), "ok");
  assert.equal(arraySeverity(arrays[1]), "error");
  assert.equal(panelSummary(arrays), "md2: inactive");
});

test("no arrays", () => {
  assert.deepEqual(parseQueryOutput(""), []);
  assert.equal(panelSummary([]), null);
});
