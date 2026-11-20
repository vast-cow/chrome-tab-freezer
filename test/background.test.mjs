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
