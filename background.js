import { canonicalHost, readSettings } from "./settings.js";

const ALARM = "tab-freezer";
const RECORD_PREFIX = "tab:";
const MINUTE = 60_000;
const RETRY_DELAY = 30_000;
const records = new Map();
const resets = new Set();
const debuggerDetaches = new Set();
const moving = new Set();
let settingsChanged = false;
let requested = false;
let running = false;
let initialized = false;

chrome.tabs.onActivated.addListener(({ tabId }) => resetTab(tabId));
chrome.tabs.onCreated.addListener(({ id }) => resetTab(id));
chrome.tabs.onRemoved.addListener(tabId => {
  moving.delete(tabId);
  resetTab(tabId);
});
chrome.tabs.onReplaced.addListener((added, removed) => {
  moving.delete(removed);
  resets.add(removed);
  resetTab(added);
});
chrome.tabs.onDetached.addListener(tabId => {
  moving.add(tabId);
  resetTab(tabId);
});
chrome.tabs.onAttached.addListener(tabId => {
  moving.delete(tabId);
  resetTab(tabId);
});
chrome.webNavigation.onCommitted.addListener(({ tabId, frameId, documentId }) => {
  if (frameId === 0 && records.get(tabId)?.documentId !== documentId) resetTab(tabId);
});
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.discarded !== undefined || change.splitViewId !== undefined ||
      change.frozen === false) {
    resetTab(tabId);
  } else if (change.url !== undefined || change.status || change.audible !== undefined ||
      change.pinned !== undefined || change.frozen !== undefined) {
    requestReconcile();
  }
});
chrome.debugger.onDetach.addListener(({ tabId }) => {
  debuggerDetaches.add(tabId);
  requestReconcile();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local") {
    settingsChanged = true;
    requestReconcile();
  }
});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ALARM) requestReconcile();
});
chrome.runtime.onStartup.addListener(requestReconcile);
chrome.runtime.onInstalled.addListener(requestReconcile);
requestReconcile();

function resetTab(tabId) {
  resets.add(tabId);
  requestReconcile();
}

function requestReconcile() {
  requested = true;
  if (!running) void reconcile();
}

async function reconcile() {
  running = true;
  try {
    if (!initialized) {
      const saved = await chrome.storage.session.get(null);
      for (const [key, record] of Object.entries(saved)) {
        if (key.startsWith(RECORD_PREFIX)) {
          // Resolve any in-flight freeze or release left by a worker restart.
          const recovered = ownsDebugger(record) ? { ...record, phase: "releasing" } : record;
          records.set(Number(key.slice(RECORD_PREFIX.length)), recovered);
        }
      }
      initialized = true;
    }

    while (requested) {
      requested = false;
      settingsChanged = false;
      const reset = new Set(resets);
      const detached = new Set(debuggerDetaches);
      resets.clear();
      debuggerDetaches.clear();

      const [settings, tabs] = await Promise.all([readSettings(), chrome.tabs.query({})]);
      const tabsById = new Map(tabs.map(tab => [tab.id, tab]));
      const ids = new Set([...records.keys(), ...tabsById.keys()]);
      const deferred = new Set();
      let attachedTabs;
      const getAttachedTabs = () => attachedTabs ??= chrome.debugger.getTargets().then(targets =>
        new Set(targets.filter(target => target.attached).map(target => target.tabId)));
      // Wait for every tab even if a browser API fails, so passes never overlap.
      const results = await Promise.allSettled([...ids].map(id =>
        reconcileTab(id, tabsById.get(id), settings, reset.has(id), detached.has(id), deferred, getAttachedTabs)));
      for (const result of results) {
        if (result.status === "rejected") throw result.reason;
      }
      await scheduleAlarm(settings, deferred);
    }
  } catch (error) {
    console.warn("Tab Freezer reconciliation failed", error);
    try {
      await chrome.alarms.create(ALARM, { delayInMinutes: RETRY_DELAY / MINUTE });
    } catch (alarmError) {
      console.warn("Tab Freezer could not schedule a retry", alarmError);
    }
  } finally {
    running = false;
    if (requested) requestReconcile();
  }
}

async function saveRecord(id, record) {
  const key = RECORD_PREFIX + id;
  if (record) {
    await chrome.storage.session.set({ [key]: record });
    records.set(id, record);
  } else if (records.has(id)) {
    await chrome.storage.session.remove(key);
    records.delete(id);
  }
}

function isEligible(tab, settings) {
  if (!tab || !(tab.id >= 0) || !settings.enabled || tab.active || moving.has(tab.id) ||
      (tab.splitViewId >= 0) || tab.discarded || (settings.excludePinned && tab.pinned) ||
      (settings.excludeAudible && tab.audible)) {
    return false;
  }

  const url = URL.parse(tab.url ?? "");
  if (!url || !["http:", "https:"].includes(url.protocol)) return false;
  const host = canonicalHost(url.hostname);
  if (host === "chromewebstore.google.com" ||
      (host === "chrome.google.com" && /^\/webstore(?:\/|$)/.test(url.pathname))) {
    return false;
  }
  return !settings.excludedHosts.some(scope => host === scope || host.endsWith("." + scope));
}

function isLoaded(tab) {
  return tab.status === "complete" && !tab.pendingUrl;
}

function matchesTab(record, tab, documentId) {
  return record.documentId === documentId && record.windowId === tab.windowId &&
    record.lastAccessed === tab.lastAccessed;
}

function ownsDebugger(record) {
  return record?.phase === "attached" || record?.phase === "releasing";
}

async function reconcileTab(id, tab, settings, reset, detached, deferred, getAttachedTabs) {
  if (moving.has(id)) return;
  let record = records.get(id);
  if (!tab) {
    await saveRecord(id, null);
    return;
  }

  let eligible = isEligible(tab, settings);
  let documentId = eligible ? await getDocumentId(id) : undefined;
  if (ownsDebugger(record)) {
    const sameInactivity = !reset && matchesTab(record, tab, documentId ?? record.documentId);
    if (detached && sameInactivity) {
      // Respect a DevTools takeover or the user's cancellation. Chrome will
      // thaw the page itself if it is still frozen when selected.
      await saveRecord(id, eligible ? { ...record, phase: "skipped" } : null);
      return;
    }
    if (!detached) {
      if (sameInactivity && eligible) {
        // Chrome reports a freeze asynchronously after accepting the CDP command.
        if (record.phase === "attached") {
          if (!documentId) deferred.add(id);
          return;
        }
        if (record.retryAt > Date.now()) return;
      }
      if (!await releaseDebugger(id, record)) return;
      tab = await getTab(id);
      eligible = isEligible(tab, settings);
      documentId = eligible ? await getDocumentId(id) : undefined;
    }
    record = undefined;
  }

  if (!eligible || tab.frozen) {
    await saveRecord(id, null);
    return;
  }
  if (record && (reset || !matchesTab(record, tab, documentId ?? record.documentId))) {
    record = undefined;
  }
  // A subframe can make the tab report loading without changing its main document.
  if (!documentId || !isLoaded(tab)) {
    if (!record) await saveRecord(id, null);
    if (!documentId || record?.phase === "waiting") deferred.add(id);
    return;
  }
  if (!record) {
    await saveRecord(id, {
      phase: "waiting",
      since: Date.now(),
      documentId,
      windowId: tab.windowId,
      lastAccessed: tab.lastAccessed,
    });
    return;
  }
  if (record.phase === "waiting" && deadline(record, settings) <= Date.now()) {
    await freezeTab(id, record, settings, deferred, getAttachedTabs);
  }
}

function deadline(record, settings) {
  return record.since + settings.timeoutMinutes * MINUTE;
}

async function scheduleAlarm(settings, deferred) {
  let when = deferred.size ? Date.now() + RETRY_DELAY : Infinity;
  for (const [id, record] of records) {
    if (moving.has(id)) continue;
    if (record.phase === "waiting" && !deferred.has(id)) {
      when = Math.min(when, deadline(record, settings));
    }
    if (record.phase === "releasing") when = Math.min(when, record.retryAt ?? Date.now());
  }
  const alarm = await chrome.alarms.get(ALARM);
  if (when === Infinity) {
    if (alarm) await chrome.alarms.clear(ALARM);
  } else if (alarm?.scheduledTime !== when) {
    await chrome.alarms.create(ALARM, { when });
  }
}

async function getTab(id) {
  try {
    return await chrome.tabs.get(id);
  } catch {
    return undefined;
  }
}

async function getDocumentId(id) {
  try {
    return (await chrome.webNavigation.getFrame({ tabId: id, frameId: 0 }))?.documentId;
  } catch {
    return undefined;
  }
}

async function freezeTab(id, record, settings, deferred, getAttachedTabs) {
  const superseded = () => settingsChanged || resets.has(id) || debuggerDetaches.has(id);
  const stillEligible = async (beforeFreeze = false) => {
    const documentId = await getDocumentId(id);
    const tab = await getTab(id);
    if (superseded() || !isEligible(tab, settings) || (beforeFreeze && tab.frozen)) return false;
    if (!documentId || !isLoaded(tab)) {
      deferred.add(id);
      return false;
    }
    return matchesTab(record, tab, documentId);
  };
  if (superseded()) return;
  if ((await getAttachedTabs()).has(id)) {
    await saveRecord(id, { ...record, phase: "skipped" });
    return;
  }
  if (superseded()) return;

  // Journal the attachment before making Chrome calls that could outlive the worker.
  await saveRecord(id, { ...record, phase: "attached" });
  if (superseded()) {
    await saveRecord(id, record);
    return;
  }
  try {
    await chrome.debugger.attach({ tabId: id }, "1.3");
  } catch (error) {
    console.debug("Tab Freezer skipped debugger attachment", id, error);
    await saveRecord(id, { ...record, phase: "skipped" });
    return;
  }

  let failed = false;
  try {
    // The Tabs API and CDP cannot check selection atomically. Recheck on
    // both sides of the command, and undo the freeze if activity overtook it.
    if (await stillEligible(true)) {
      await setLifecycle(id, "frozen");
      if (await stillEligible()) return;
    }
  } catch (error) {
    failed = true;
    console.debug("Tab Freezer could not freeze a tab", id, error);
  }
  await releaseDebugger(id, record, failed ? { ...record, phase: "skipped" } : record);
  if (!deferred.has(id)) requestReconcile();
}

function setLifecycle(id, state) {
  return chrome.debugger.sendCommand({ tabId: id }, "Page.setWebLifecycleState", { state });
}

async function releaseDebugger(id, record, next = null) {
  try {
    await setLifecycle(id, "active");
    await chrome.debugger.detach({ tabId: id });
  } catch (error) {
    const message = String(error);
    const alreadyDetached = debuggerDetaches.has(id) ||
      /Debugger is not attached|Detached while handling command/.test(message);
    if (!alreadyDetached) {
      console.debug("Tab Freezer will retry debugger cleanup", id, error);
      await saveRecord(id, { ...record, phase: "releasing", retryAt: Date.now() + RETRY_DELAY });
      return false;
    }
  }
  await saveRecord(id, next);
  return true;
}
