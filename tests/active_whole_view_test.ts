import { assertEquals } from "@std/assert";
import {
  type ActiveWholeView,
  createWholeViewTransitionCoordinator,
  remountActiveWholeView,
} from "../src/ui/results-viewer/src/active-whole-view.ts";

Deno.test("host-context remount keeps the resolved drill-down instead of returning to its list", async () => {
  const seen: string[] = [];
  const active: ActiveWholeView<string, string> = { name: "detail", data: "run-detail" };
  await remountActiveWholeView(active, {
    list: (value) => {
      seen.push(`list:${value}`);
      return Promise.resolve();
    },
    detail: (value) => {
      seen.push(`detail:${value}`);
      return Promise.resolve();
    },
  });
  assertEquals(seen, ["detail:run-detail"]);
});

Deno.test("host-context remount does not revive a list while its detail is pending", () => {
  const seen: string[] = [];
  const active: ActiveWholeView<string, string> = { name: "pending-detail" };
  const remount = remountActiveWholeView(active, {
    list: (value) => {
      seen.push(`list:${value}`);
      return Promise.resolve();
    },
    detail: (value) => {
      seen.push(`detail:${value}`);
      return Promise.resolve();
    },
  });
  assertEquals(remount, undefined);
  assertEquals(seen, []);
});

Deno.test("new session generations defeat stale remounts and later remount the new display", async () => {
  const transitions = createWholeViewTransitionCoordinator();
  const seen: string[] = [];
  let activeDisplay = "old-detail";
  let releaseRunning!: () => void;
  const runningGate = new Promise<void>((resolve) => releaseRunning = resolve);

  const running = transitions.remount(async () => {
    seen.push("running:start");
    await runningGate;
    activeDisplay = "old-remount";
    seen.push("running:end");
  });
  await Promise.resolve();
  const stale = transitions.remount(() => {
    seen.push("stale-remount");
  });
  const replacement = transitions.replace(() => {
    activeDisplay = "rejected";
    seen.push("session:rejected");
  });
  const fresh = transitions.remount(() => {
    seen.push(`remount:${activeDisplay}`);
  });

  releaseRunning();
  await Promise.all([running, stale, replacement, fresh]);
  assertEquals(activeDisplay, "rejected");
  assertEquals(seen, [
    "running:start",
    "running:end",
    "session:rejected",
    "remount:rejected",
  ]);
});
