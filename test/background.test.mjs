import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";

const TAB_ID = 1;
const RECORD_KEY = "tab:" + TAB_ID;
const DOCUMENT_ID = "main-document";
const MINUTE = 60_000;
let workerNumber = 0;

function event() {
  const listeners = new Set();
  return {
    addListener: listener => listeners.add(listener),
    fire(...args) {
      for (const listener of listeners) listener(...args);
    },
    clear: () => listeners.clear(),
  };
}

function createBrowser() {
  const tab = {
    id: TAB_ID,
    windowId: 1,
    lastAccessed: Date.now() - MINUTE,
    url: "https://example.test/",
    status: "complete",
    active: false,
    frozen: false,
  };
  const session = {};
  const debuggerCalls = [];
  let attached = false;
  let documentId = DOCUMENT_ID;
  let alarm;
  const api = {
    tabs: {
      onActivated: event(), onCreated: event(), onRemoved: event(), onReplaced: event(),
      onDetached: event(), onAttached: event(), onUpdated: event(),
      query: async () => [{ ...tab }],
      get: async () => ({ ...tab }),
    },
    webNavigation: {
      onCommitted: event(),
      getFrame: async details => {
        assert.deepEqual(details, { tabId: TAB_ID, frameId: 0 });
        return documentId && { documentId };
      },
    },
    debugger: {
      onDetach: event(),
      getTargets: async () => [{ tabId: TAB_ID, attached }],
      async attach() {
        debuggerCalls.push("attach");
        attached = true;
      },
      async sendCommand(_target, method, { state }) {
        assert.equal(method, "Page.setWebLifecycleState");
        assert.ok(attached);
        debuggerCalls.push(state);
        tab.frozen = state === "frozen";
      },
      async detach() {
        assert.ok(attached);
        debuggerCalls.push("detach");
        attached = false;
      },
    },
    alarms: {
      onAlarm: event(),
      get: async () => alarm,
      async create(name, { when, delayInMinutes }) {
        alarm = { name, scheduledTime: when ?? Date.now() + delayInMinutes * MINUTE };
      },
      async clear() { alarm = undefined; },
    },
    runtime: { onInstalled: event(), onStartup: event() },
    storage: {
      onChanged: event(),
      local: { get: async defaults => ({ ...defaults, timeoutMinutes: 1 }) },
      session: {
        get: async () => structuredClone(session),
        set: async changes => Object.assign(session, structuredClone(changes)),
        remove: async key => delete session[key],
      },
    },
  };

  return {
    api, tab, debuggerCalls,
    get record() { return session[RECORD_KEY]; },
    set record(record) { session[RECORD_KEY] = structuredClone(record); },
    get alarm() { return alarm; },
    async startWorker() {
      for (const namespace of Object.values(api)) {
        for (const member of Object.values(namespace)) member?.clear?.();
      }
      globalThis.chrome = api;
      await import(`../background.js?worker=${++workerNumber}`);
      await setImmediate();
    },
    updateTab(changes) {
      Object.assign(tab, changes);
      api.tabs.onUpdated.fire(TAB_ID, changes, { ...tab });
    },
    setDocument(id) { documentId = id; },
    commit(id, frameId = 0) {
      if (frameId === 0) documentId = id;
      api.webNavigation.onCommitted.fire({ tabId: TAB_ID, frameId, documentId: id });
    },
    fireAlarm() {
      assert.ok(alarm);
      const scheduled = alarm;
      alarm = undefined;
      api.alarms.onAlarm.fire(scheduled);
    },
  };
}

function waitingRecord(tab, since = Date.now() - MINUTE) {
  return {
    phase: "waiting",
    since,
    documentId: DOCUMENT_ID,
    windowId: tab.windowId,
    lastAccessed: tab.lastAccessed,
  };
}

test("same-document changes keep the deadline and a same-URL reload starts a new interval", async t => {
  let now = 100_000;
  t.mock.method(Date, "now", () => now);
  const browser = createBrowser();
  await browser.startWorker();
  const initial = browser.record;

  now += 10_000;
  browser.updateTab({ url: browser.tab.url + "?step=push" });
  await setImmediate();
  assert.deepEqual(browser.record, initial);
  assert.equal(browser.alarm.scheduledTime, initial.since + MINUTE);

  now += 10_000;
  const url = browser.tab.url + "#fragment";
  browser.updateTab({ url, status: "loading" });
  browser.commit("subframe-document", 2);
  browser.updateTab({ status: "complete" });
  await setImmediate();
  assert.deepEqual(browser.record, initial);
  assert.equal(browser.alarm.scheduledTime, initial.since + MINUTE);

  now += 10_000;
  browser.updateTab({ status: "loading" });
  browser.commit("reloaded-document");
  await setImmediate();
  assert.equal(browser.record, undefined);

  now += 1000;
  browser.updateTab({ status: "complete" });
  await setImmediate();
  assert.equal(browser.tab.url, url);
  assert.equal(browser.record.documentId, "reloaded-document");
  assert.equal(browser.record.since, now);
  assert.equal(browser.alarm.scheduledTime, now + MINUTE);
});

test("a tab update only looks up the affected main document in a 150-tab session", async t => {
  let now = 100_000;
  t.mock.method(Date, "now", () => now);
  const browser = createBrowser();
  const query = browser.api.tabs.query;
  const getFrame = browser.api.webNavigation.getFrame;
  const otherTabs = Array.from({ length: 149 }, (_, index) => ({ ...browser.tab, id: index + 2 }));
  const frameLookups = [];
  browser.api.tabs.query = async () => [...await query(), ...otherTabs];
  browser.api.webNavigation.getFrame = async details => {
    frameLookups.push(details.tabId);
    if (details.tabId === TAB_ID) return getFrame(details);
    return { documentId: `document-${details.tabId}` };
  };

  await browser.startWorker();
  assert.equal(frameLookups.length, 150);
  const initial = browser.record;

  frameLookups.length = 0;
  now += 1000;
  browser.updateTab({ url: browser.tab.url + "#fragment" });
  await setImmediate();
  assert.deepEqual(frameLookups, [TAB_ID]);
  assert.deepEqual(browser.record, initial);

  frameLookups.length = 0;
  now += 1000;
  browser.commit("new-document");
  await setImmediate();
  assert.deepEqual(frameLookups, [TAB_ID]);
  assert.equal(browser.record.documentId, "new-document");
  assert.equal(browser.record.since, now);

  frameLookups.length = 0;
  await browser.startWorker();
  assert.equal(frameLookups.length, 150);
});

test("an in-flight frame lookup cannot overwrite a newer navigation", async t => {
  let now = 100_000;
  t.mock.method(Date, "now", () => now);
  const browser = createBrowser();
  await browser.startWorker();

  const getFrame = browser.api.webNavigation.getFrame;
  const { promise, resolve } = Promise.withResolvers();
  browser.api.webNavigation.getFrame = () => {
    browser.api.webNavigation.getFrame = getFrame;
    return promise;
  };
  now += 1000;
  browser.updateTab({ url: browser.tab.url + "#fragment" });
  await setImmediate();
  browser.commit("new-document");
  resolve({ documentId: DOCUMENT_ID });
  await setImmediate();

  assert.equal(browser.record.documentId, "new-document");
  assert.equal(browser.record.since, now);
});

test("an unidentifiable document defers an expired session record without losing its deadline", async t => {
  let now = 100_000;
  t.mock.method(Date, "now", () => now);
  const browser = createBrowser();
  const saved = waitingRecord(browser.tab);
  browser.record = saved;
  browser.setDocument(undefined);
  await browser.startWorker();

  assert.deepEqual(browser.record, saved);
  assert.deepEqual(browser.debuggerCalls, []);
  assert.equal(browser.alarm.scheduledTime, now + 30_000);

  now = browser.alarm.scheduledTime;
  browser.setDocument(DOCUMENT_ID);
  browser.fireAlarm();
  await setImmediate();
  assert.deepEqual(browser.debuggerCalls, ["attach", "frozen"]);
  assert.equal(browser.record.since, saved.since);
});

test("a failed tab lookup retries through the alarm at most once every 30 seconds", async t => {
  let now = 100_000;
  t.mock.method(Date, "now", () => now);
  const browser = createBrowser();
  const saved = waitingRecord(browser.tab);
  browser.record = saved;
  const get = browser.api.tabs.get;
  let failures = 2;
  browser.api.tabs.get = async (...args) => {
    if (failures > 0) {
      failures--;
      throw new Error("Temporary tab lookup failure");
    }
    return get(...args);
  };

  await browser.startWorker();
  assert.deepEqual(browser.debuggerCalls, ["attach", "detach"]);
  assert.equal(browser.record.since, saved.since);
  assert.equal(browser.alarm.scheduledTime, 130_000);

  now = 110_000;
  browser.updateTab({ url: browser.tab.url + "#unrelated-to-inactivity" });
  await setImmediate();
  await browser.startWorker();
  assert.deepEqual(browser.debuggerCalls, ["attach", "detach"]);
  assert.equal(browser.alarm.scheduledTime, 130_000);

  now = 130_000;
  browser.fireAlarm();
  await setImmediate();
  assert.deepEqual(browser.debuggerCalls, ["attach", "detach", "attach", "detach"]);
  assert.equal(browser.alarm.scheduledTime, 160_000);

  now = 160_000;
  browser.fireAlarm();
  await setImmediate();
  assert.deepEqual(browser.debuggerCalls, ["attach", "detach", "attach", "detach", "attach", "frozen"]);
  assert.equal(browser.record.since, saved.since);
});

test("activation and closure cancel a pending freeze retry", async t => {
  t.mock.method(Date, "now", () => 100_000);
  for (const action of ["activate", "close"]) {
    const browser = createBrowser();
    browser.record = waitingRecord(browser.tab);
    const get = browser.api.tabs.get;
    browser.api.tabs.get = async () => {
      browser.api.tabs.get = get;
      return undefined;
    };
    await browser.startWorker();
    assert.equal(browser.alarm.scheduledTime, 130_000);

    if (action === "activate") {
      browser.tab.active = true;
      browser.api.tabs.onActivated.fire({ tabId: TAB_ID });
    } else {
      browser.api.tabs.query = async () => [];
      browser.api.tabs.onRemoved.fire(TAB_ID);
    }
    await setImmediate();
    assert.equal(browser.record, undefined);
    assert.equal(browser.alarm, undefined);
    assert.deepEqual(browser.debuggerCalls, ["attach", "detach"]);
  }
});

test("a stale list delivered after reattachment still releases the debugger", async t => {
  let now = 100_000;
  t.mock.method(Date, "now", () => now);
  const browser = createBrowser();
  browser.record = waitingRecord(browser.tab);
  await browser.startWorker();
  assert.deepEqual(browser.debuggerCalls, ["attach", "frozen"]);

  const get = browser.api.tabs.get;
  const { promise, resolve } = Promise.withResolvers();
  browser.api.tabs.query = () => promise;
  browser.api.tabs.get = async () => { throw new Error("Tab temporarily unavailable during move"); };

  browser.api.tabs.onDetached.fire(TAB_ID);
  browser.tab.windowId = 2;
  browser.api.tabs.onAttached.fire(TAB_ID);
  resolve([]);
  await setImmediate();

  assert.equal(browser.record?.phase, "attached");
  assert.deepEqual(browser.debuggerCalls, ["attach", "frozen"]);
  assert.equal(browser.alarm?.scheduledTime, now + 30_000);

  browser.api.tabs.get = get;
  now = browser.alarm.scheduledTime;
  browser.fireAlarm();
  await setImmediate();

  assert.deepEqual(browser.debuggerCalls, ["attach", "frozen", "active", "detach"]);
  assert.equal(browser.tab.frozen, false);
  assert.deepEqual(browser.record, waitingRecord(browser.tab, now));
  assert.equal(browser.alarm?.scheduledTime, now + MINUTE);
});

test("closure and replacement clear debugger ownership even when the list still contains the tab", async () => {
  for (const action of ["close", "replace"]) {
    const browser = createBrowser();
    browser.record = waitingRecord(browser.tab);
    await browser.startWorker();
    assert.deepEqual(browser.debuggerCalls, ["attach", "frozen"]);

    if (action === "close") browser.api.tabs.onRemoved.fire(TAB_ID);
    else browser.api.tabs.onReplaced.fire(TAB_ID + 1, TAB_ID);
    await setImmediate();

    assert.deepEqual(browser.debuggerCalls, ["attach", "frozen"]);
    assert.equal(browser.record, undefined);
    assert.equal(browser.alarm, undefined);
  }
});

test("restart recovery clears a missing tab's ownership once its debugger target is gone", async t => {
  let now = 100_000;
  t.mock.method(Date, "now", () => now);
  const browser = createBrowser();
  const saved = { ...waitingRecord(browser.tab), phase: "attached", needsThaw: true };
  browser.record = saved;
  browser.api.tabs.query = async () => [];
  browser.api.tabs.get = async () => { throw new Error("Tab unavailable"); };

  const getTargets = browser.api.debugger.getTargets;
  browser.api.debugger.getTargets = async () => { throw new Error("Temporary target lookup failure"); };
  await browser.startWorker();
  assert.deepEqual(browser.record, saved);
  assert.equal(browser.alarm.scheduledTime, now + 30_000);

  // Even an unattached target can belong to a tab that is temporarily unavailable.
  browser.api.debugger.getTargets = getTargets;
  now = browser.alarm.scheduledTime;
  browser.fireAlarm();
  await setImmediate();
  assert.deepEqual(browser.record, saved);
  assert.equal(browser.alarm.scheduledTime, now + 30_000);

  browser.api.debugger.getTargets = async () => [{ tabId: TAB_ID + 1, attached: true }];
  now = browser.alarm.scheduledTime;
  browser.fireAlarm();
  await setImmediate();

  assert.deepEqual(browser.debuggerCalls, []);
  assert.equal(browser.record, undefined);
  assert.equal(browser.alarm, undefined);
});

test("cleanup thaw preserves inactivity with both immediate and delayed tab updates", async t => {
  let now = 100_000;
  t.mock.method(Date, "now", () => now);
  for (const delayed of [false, true]) {
    now = 100_000;
    const browser = createBrowser();
    const saved = waitingRecord(browser.tab);
    browser.record = saved;
    const send = browser.api.debugger.sendCommand;
    browser.api.debugger.sendCommand = async (...args) => {
      await send(...args);
      if (args[2].state === "frozen") {
        browser.setDocument(undefined);
        browser.updateTab({ frozen: true });
      } else {
        browser.setDocument(DOCUMENT_ID);
        if (delayed) browser.tab.frozen = true;
        else browser.updateTab({ frozen: false });
      }
    };

    await browser.startWorker();
    assert.deepEqual(browser.debuggerCalls, ["attach", "frozen", "active", "detach"]);
    assert.equal(browser.record?.since, saved.since);
    assert.equal(browser.alarm.scheduledTime, 130_000);

    if (delayed) {
      now = 110_000;
      browser.updateTab({ url: browser.tab.url + "#before-thaw-notification" });
      await setImmediate();
      assert.equal(browser.record?.since, saved.since);
      browser.updateTab({ frozen: false });
      await setImmediate();
      assert.equal(browser.record?.since, saved.since);
      assert.equal(browser.alarm.scheduledTime, 130_000);
    }

    browser.api.debugger.sendCommand = send;
    now = 130_000;
    browser.fireAlarm();
    await setImmediate();
    assert.equal(browser.record.phase, "attached");
    assert.equal(browser.record.since, saved.since);
  }
});

test("cleanup thaw after the retry deadline uses the original inactivity interval", async t => {
  let now;
  t.mock.method(Date, "now", () => now);
  for (const reportThaw of ["event", "alarm"]) {
    now = 100_000;
    const browser = createBrowser();
    const saved = waitingRecord(browser.tab);
    browser.record = saved;
    const send = browser.api.debugger.sendCommand;
    browser.api.debugger.sendCommand = async (...args) => {
      await send(...args);
      if (args[2].state === "frozen") {
        browser.setDocument(undefined);
      } else {
        browser.setDocument(DOCUMENT_ID);
        browser.tab.frozen = true;
      }
    };
    await browser.startWorker();
    browser.api.debugger.sendCommand = send;
    assert.deepEqual(browser.debuggerCalls, ["attach", "frozen", "active", "detach"]);

    for (const retryAt of [130_000, 160_000]) {
      assert.equal(browser.alarm?.scheduledTime, retryAt);
      now = retryAt;
      browser.fireAlarm();
      await setImmediate();

      assert.equal(browser.record?.phase, "waiting");
      assert.equal(browser.record.since, saved.since);
      assert.deepEqual(browser.debuggerCalls, ["attach", "frozen", "active", "detach"]);
    }
    assert.equal(browser.alarm?.scheduledTime, 190_000);

    if (reportThaw === "event") {
      now = 170_000;
      browser.updateTab({ frozen: false });
    } else {
      browser.tab.frozen = false;
      now = browser.alarm.scheduledTime;
      browser.fireAlarm();
    }
    await setImmediate();

    assert.deepEqual(browser.debuggerCalls, ["attach", "frozen", "active", "detach", "attach", "frozen"]);
    assert.equal(browser.record.phase, "attached");
    assert.equal(browser.record.since, saved.since);
    assert.equal(browser.alarm, undefined);
  }
});

test("an unexpected thaw of a managed tab releases the debugger and restarts inactivity", async t => {
  let now = 100_000;
  t.mock.method(Date, "now", () => now);
  const browser = createBrowser();
  browser.record = waitingRecord(browser.tab);
  await browser.startWorker();
  assert.equal(browser.record.phase, "attached");

  now += 1000;
  browser.updateTab({ frozen: false });
  await setImmediate();

  assert.deepEqual(browser.debuggerCalls, ["attach", "frozen", "active", "detach"]);
  assert.deepEqual(browser.record, waitingRecord(browser.tab, now));
  assert.equal(browser.alarm.scheduledTime, now + MINUTE);
});

test("an unexpected thaw survives a failed tab query and is handled on retry", async t => {
  const lookups = [
    { name: "tab list", listed: true },
    { name: "direct lookup" },
    { name: "direct lookup after a lookup failure", lookupFailed: true },
    { name: "direct lookup after an unknown frozen state", frozenUnknown: true },
  ];
  for (const { name, listed, lookupFailed, frozenUnknown } of lookups) {
    await t.test(name, async t => {
      let now = 100_000;
      t.mock.method(Date, "now", () => now);
      t.mock.method(console, "warn", () => {});
      const browser = createBrowser();
      browser.record = waitingRecord(browser.tab);
      await browser.startWorker();
      assert.equal(browser.record.phase, "attached");

      const query = browser.api.tabs.query;
      browser.api.tabs.query = async () => { throw new Error("Temporary tab query failure"); };
      now += 1000;
      browser.updateTab({ frozen: false });
      await setImmediate();

      assert.deepEqual(browser.debuggerCalls, ["attach", "frozen"]);
      assert.equal(browser.record.phase, "attached");
      assert.equal(browser.alarm.scheduledTime, now + 30_000);

      browser.api.tabs.query = listed ? query : async () => [];
      if (lookupFailed || frozenUnknown) {
        const get = browser.api.tabs.get;
        browser.api.tabs.get = async () => {
          if (lookupFailed) throw new Error("Temporary tab lookup failure");
          return { ...await get(), frozen: undefined };
        };
        now = browser.alarm.scheduledTime;
        browser.fireAlarm();
        await setImmediate();

        assert.deepEqual(browser.debuggerCalls, ["attach", "frozen"]);
        assert.equal(browser.record.phase, "attached");
        assert.equal(browser.alarm.scheduledTime, now + 30_000);
        browser.api.tabs.get = get;
      }
      now = browser.alarm.scheduledTime;
      browser.fireAlarm();
      await setImmediate();

      assert.deepEqual(browser.debuggerCalls, ["attach", "frozen", "active", "detach"]);
      assert.deepEqual(browser.record, waitingRecord(browser.tab, now));
      assert.equal(browser.alarm.scheduledTime, now + MINUTE);
    });
  }
});

test("a document change during debugger attachment cancels the freeze before dispatch", async () => {
  const browser = createBrowser();
  browser.record = waitingRecord(browser.tab);
  const attach = browser.api.debugger.attach;
  browser.api.debugger.attach = async () => {
    await attach();
    browser.setDocument("new-document");
  };

  await browser.startWorker();

  assert.deepEqual(browser.debuggerCalls, ["attach", "detach"]);
  assert.equal(browser.record.phase, "waiting");
  assert.equal(browser.record.documentId, "new-document");
});

test("a document change across the freeze command releases the debugger and restarts inactivity", async () => {
  const browser = createBrowser();
  browser.record = waitingRecord(browser.tab);
  const send = browser.api.debugger.sendCommand;
  browser.api.debugger.sendCommand = async (...args) => {
    await send(...args);
    if (args[2].state === "frozen") browser.setDocument("new-document");
  };

  await browser.startWorker();

  assert.deepEqual(browser.debuggerCalls, ["attach", "frozen", "active", "detach"]);
  assert.equal(browser.record.phase, "waiting");
  assert.equal(browser.record.documentId, "new-document");
  assert.equal(browser.tab.frozen, false);
});

test("cleanup leaves Chrome's own freeze in place when it happens during attachment", async () => {
  const browser = createBrowser();
  browser.record = waitingRecord(browser.tab);
  const attach = browser.api.debugger.attach;
  browser.api.debugger.attach = async () => {
    await attach();
    browser.updateTab({ frozen: true });
  };

  await browser.startWorker();

  assert.deepEqual(browser.debuggerCalls, ["attach", "detach"]);
  assert.equal(browser.tab.frozen, true);
  assert.equal(browser.record, undefined);
});

test("selection after the journal write cancels dispatch and detaches directly", async () => {
  const browser = createBrowser();
  browser.record = waitingRecord(browser.tab);
  const save = browser.api.storage.session.set;
  browser.api.storage.session.set = async changes => {
    await save(changes);
    if (changes[RECORD_KEY].phase === "attached" && changes[RECORD_KEY].needsThaw) {
      browser.tab.active = true;
      browser.api.tabs.onActivated.fire({ tabId: TAB_ID });
    }
  };

  await browser.startWorker();

  assert.deepEqual(browser.debuggerCalls, ["attach", "detach"]);
  assert.equal(browser.record, undefined);
});

test("recovery detaches directly if the worker stopped during attachment", async () => {
  const browser = createBrowser();
  browser.record = waitingRecord(browser.tab);
  const attach = browser.api.debugger.attach;
  browser.api.debugger.attach = async () => {
    await attach();
    return new Promise(() => {});
  };

  await browser.startWorker();
  assert.equal(browser.record.phase, "attached");
  assert.equal(browser.record.needsThaw, false);
  browser.tab.frozen = true;

  await browser.startWorker();

  assert.deepEqual(browser.debuggerCalls, ["attach", "detach"]);
  assert.equal(browser.tab.frozen, true);
  assert.equal(browser.record, undefined);
});

test("recovery thaws conservatively if the worker stopped after journaling dispatch", async () => {
  const browser = createBrowser();
  browser.record = waitingRecord(browser.tab);
  const save = browser.api.storage.session.set;
  browser.api.storage.session.set = async changes => {
    await save(changes);
    if (changes[RECORD_KEY].phase === "attached" && changes[RECORD_KEY].needsThaw) {
      return new Promise(() => {});
    }
  };

  await browser.startWorker();
  assert.deepEqual(browser.debuggerCalls, ["attach"]);
  assert.equal(browser.record.needsThaw, true);

  await browser.startWorker();

  assert.deepEqual(browser.debuggerCalls, ["attach", "active", "detach"]);
  assert.equal(browser.record.phase, "waiting");
});

test("recovery thaws if the worker stopped with a freeze command in flight", async () => {
  const browser = createBrowser();
  browser.record = waitingRecord(browser.tab);
  const send = browser.api.debugger.sendCommand;
  browser.api.debugger.sendCommand = async (...args) => {
    if (args[2].state === "frozen") {
      assert.equal(browser.record.needsThaw, true);
      await send(...args);
      return new Promise(() => {});
    }
    await send(...args);
  };

  await browser.startWorker();
  assert.equal(browser.tab.frozen, true);
  assert.deepEqual(browser.debuggerCalls, ["attach", "frozen"]);

  await browser.startWorker();

  assert.deepEqual(browser.debuggerCalls, ["attach", "frozen", "active", "detach"]);
  assert.equal(browser.tab.frozen, false);
  assert.equal(browser.record.phase, "waiting");
});

test("a detach failure after thaw is retried without another thaw after restart", async t => {
  let now = 100_000;
  t.mock.method(Date, "now", () => now);
  t.mock.method(console, "debug", () => {});
  const browser = createBrowser();
  browser.record = waitingRecord(browser.tab);
  await browser.startWorker();
  assert.deepEqual(browser.debuggerCalls, ["attach", "frozen"]);

  const detach = browser.api.debugger.detach;
  browser.api.debugger.detach = async () => {
    assert.equal(browser.record.needsThaw, false);
    browser.debuggerCalls.push("failed detach");
    throw new Error("Transient detach failure");
  };
  browser.tab.active = true;
  browser.api.tabs.onActivated.fire({ tabId: TAB_ID });
  await setImmediate();

  assert.equal(browser.tab.frozen, false);
  assert.equal(browser.record.phase, "releasing");
  assert.equal(browser.record.needsThaw, false);
  assert.equal(browser.alarm.scheduledTime, now + 30_000);
  assert.deepEqual(browser.debuggerCalls, ["attach", "frozen", "active", "failed detach"]);

  browser.api.debugger.detach = detach;
  await browser.startWorker();
  assert.deepEqual(browser.debuggerCalls, ["attach", "frozen", "active", "failed detach"]);
  now = browser.alarm.scheduledTime;
  browser.fireAlarm();
  await setImmediate();

  assert.deepEqual(browser.debuggerCalls, ["attach", "frozen", "active", "failed detach", "detach"]);
  assert.equal(browser.record, undefined);
});

test("recovery thaws an older attachment with no dispatch flag", async () => {
  const browser = createBrowser();
  await browser.api.debugger.attach();
  browser.tab.frozen = true;
  browser.record = {
    phase: "attached",
    since: Date.now() - MINUTE,
    url: browser.tab.url,
    windowId: browser.tab.windowId,
    lastAccessed: browser.tab.lastAccessed,
  };

  await browser.startWorker();

  assert.deepEqual(browser.debuggerCalls, ["attach", "active", "detach"]);
  assert.equal(browser.tab.frozen, false);
  assert.equal(browser.record.phase, "waiting");
  assert.equal(browser.record.documentId, DOCUMENT_ID);
});
