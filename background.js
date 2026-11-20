import { canonicalHost, readSettings } from "./settings.js";

const ALARM = "tab-freezer";
const RECORD_PREFIX = "tab:";
const MINUTE = 60_000;
const RETRY_DELAY = 30_000;
const records = new Map();
const verifiedDocuments = new Map();
const resets = new Set();
const debuggerDetaches = new Set();
const debuggerThaws = new Set();
const moving = new Set();
const removedTabs = new Set();
let settingsChanged = false;
let requested = false;
let running = false;
let initialized = false;

chrome.tabs.onActivated.addListener(({ tabId }) => resetTab(tabId));
chrome.tabs.onCreated.addListener(({ id }) => resetTab(id));
chrome.tabs.onRemoved.addListener(tabId => {
  markRemoved(tabId);
  requestReconcile();
});
chrome.tabs.onReplaced.addListener((added, removed) => {
  markRemoved(removed);
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
  if (frameId !== 0) return;
  if (records.get(tabId)?.documentId !== documentId) {
    resetTab(tabId);
  } else {
    verifiedDocuments.delete(tabId);
    requestReconcile();
  }
});
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.discarded !== undefined || change.splitViewId !== undefined) {
    resetTab(tabId);
  } else if (change.url !== undefined || change.status || change.audible !== undefined ||
      change.pinned !== undefined || change.frozen !== undefined) {
    if (change.url !== undefined || change.status) verifiedDocuments.delete(tabId);
    // A cleanup thaw can arrive during release or after the waiting record is restored.
    if (change.frozen === false && records.get(tabId)?.phase === "attached") {
      debuggerThaws.add(tabId);
    }
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

function markRemoved(tabId) {
  moving.delete(tabId);
  removedTabs.add(tabId);
  verifiedDocuments.delete(tabId);
  resets.add(tabId);
}

function resetTab(tabId) {
  verifiedDocuments.delete(tabId);
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
      const thawed = new Set(debuggerThaws);
      resets.clear();
      debuggerDetaches.clear();
      debuggerThaws.clear();

      let settings, tabs;
      try {
        [settings, tabs] = await Promise.all([readSettings(), chrome.tabs.query({})]);
      } catch (error) {
        // Replay the batch along with events received during the failed read.
        for (const id of reset) resets.add(id);
        for (const id of detached) debuggerDetaches.add(id);
        for (const id of thawed) debuggerThaws.add(id);
        throw error;
      }
      const tabsById = new Map(tabs.map(tab => [tab.id, tab]));
      for (const id of thawed) {
        if (records.get(id)?.phase === "attached" && tabsById.get(id)?.frozen === false) reset.add(id);
      }
      const ids = new Set([...records.keys(), ...tabsById.keys(), ...removedTabs]);
      const deferred = new Set();
      let debuggerTabs;
      const getDebuggerTabs = () => debuggerTabs ??= chrome.debugger.getTargets().then(targets => ({
        available: new Set(targets.map(target => target.tabId)),
        attached: new Set(targets.filter(target => target.attached).map(target => target.tabId)),
      }));
      // Wait for every tab even if a browser API fails, so passes never overlap.
      const results = await Promise.allSettled([...ids].map(id =>
        reconcileTab(id, tabsById.get(id), settings, reset.has(id), detached.has(id), deferred, getDebuggerTabs)));
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

async function reconcileTab(id, tab, settings, reset, detached, deferred, getDebuggerTabs) {
  if (removedTabs.has(id)) {
    await saveRecord(id, null);
    removedTabs.delete(id);
    return;
  }
  if (moving.has(id)) return;
  let record = records.get(id);
  if (!tab && ownsDebugger(record) && !detached) {
    // A list captured during a window move can arrive after reattachment.
    tab = await getTab(id);
    if (moving.has(id) || removedTabs.has(id)) return;
    if (!tab) {
      const targets = await getDebuggerTabs().catch(() => undefined);
      // A tab event can supersede the missing snapshots while targets are read.
      if (moving.has(id) || removedTabs.has(id) || resets.has(id)) return;
      if (!targets || targets.available.has(id)) {
        if (reset) resets.add(id);
        deferred.add(id);
        return;
      }
    }
  }
  if (!tab) {
    verifiedDocuments.delete(id);
    await saveRecord(id, null);
    return;
  }

  let eligible = isEligible(tab, settings);
  let documentId = eligible ? await getVerifiedDocumentId(id) : undefined;
  if (ownsDebugger(record)) {
    const sameInactivity = !reset && matchesTab(record, tab, documentId ?? record.documentId);
    if (detached && sameInactivity) {
      // Respect a DevTools takeover or the user's cancellation. Chrome will
      // thaw the page itself if it is still frozen when selected.
      await saveRecord(id, eligible ? afterRelease(record, "skipped") : null);
      return;
    }
    if (!detached) {
      const keepInterval = sameInactivity && eligible;
      if (record.phase === "attached" && keepInterval) {
        // Chrome reports a freeze asynchronously after accepting the CDP command.
        if (!documentId) deferred.add(id);
        return;
      }
      const nextPhase = keepInterval ? record.nextPhase ?? null : null;
      if (record.retryAt > Date.now()) {
        if (record.nextPhase && !nextPhase) {
          await saveRecord(id, { ...record, nextPhase });
        }
        return;
      }
      if (!await releaseDebugger(id, record, nextPhase)) return;
      verifiedDocuments.delete(id);
      tab = await getTab(id);
      if (!tab) {
        deferred.add(id);
        return;
      }
      eligible = isEligible(tab, settings);
      documentId = eligible ? await getVerifiedDocumentId(id) : undefined;
    }
    record = detached ? undefined : records.get(id);
  }

  if (!eligible) {
    await saveRecord(id, null);
    return;
  }
  if (record && (reset || !matchesTab(record, tab, documentId ?? record.documentId))) {
    record = undefined;
  }
  if (tab.frozen) {
    // Chrome can report the old state even after the cleanup retry is due.
    if (record?.phase === "waiting" && record.snapshotRetryAt !== undefined) {
      deferred.add(id);
    } else {
      await saveRecord(id, null);
    }
    return;
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
  if (record.phase === "waiting" && freezeAt(record, settings) <= Date.now()) {
    await freezeTab(id, record, settings, getDebuggerTabs);
  }
}

function freezeAt(record, settings) {
  return Math.max(record.since + settings.timeoutMinutes * MINUTE, record.snapshotRetryAt ?? 0);
}

async function scheduleAlarm(settings, deferred) {
  const now = Date.now();
  let when = Infinity;
  for (const id of deferred) {
    const retryAt = records.get(id)?.snapshotRetryAt;
    when = Math.min(when, retryAt > now ? retryAt : now + RETRY_DELAY);
  }
  for (const [id, record] of records) {
    if (moving.has(id) || deferred.has(id)) continue;
    if (record.phase === "waiting") {
      when = Math.min(when, freezeAt(record, settings));
    }
    if (record.phase === "releasing") when = Math.min(when, record.retryAt ?? now);
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

async function getVerifiedDocumentId(id) {
  let lookup = verifiedDocuments.get(id);
  if (!lookup) {
    lookup = getDocumentId(id);
    verifiedDocuments.set(id, lookup);
  }
  const documentId = await lookup;
  // Navigation can invalidate a lookup while Chrome is returning it.
  if (verifiedDocuments.get(id) !== lookup) return undefined;
  if (!documentId) verifiedDocuments.delete(id);
  return documentId;
}

async function freezeTab(id, record, settings, getDebuggerTabs) {
  const superseded = () => settingsChanged || resets.has(id) || debuggerDetaches.has(id);
  let snapshotUnavailable = false;
  const stillEligible = async (beforeFreeze = false) => {
    const documentId = await getDocumentId(id);
    const tab = await getTab(id);
    if (superseded()) return false;
    if (tab && (!isEligible(tab, settings) || (beforeFreeze && tab.frozen) ||
        !matchesTab(record, tab, documentId ?? record.documentId))) return false;
    snapshotUnavailable = !tab || !documentId || !isLoaded(tab);
    return !snapshotUnavailable;
  };
  const { snapshotRetryAt, ...interval } = record;
  if (superseded()) return;
  if ((await getDebuggerTabs()).attached.has(id)) {
    await saveRecord(id, { ...interval, phase: "skipped" });
    return;
  }
  if (superseded()) return;

  // Journal the attachment before making Chrome calls that could outlive the worker.
  const attachment = { ...interval, phase: "attached", needsThaw: false };
  await saveRecord(id, attachment);
  if (superseded()) {
    await saveRecord(id, record);
    return;
  }
  try {
    await chrome.debugger.attach({ tabId: id }, "1.3");
  } catch (error) {
    console.debug("Tab Freezer skipped debugger attachment", id, error);
    await saveRecord(id, { ...interval, phase: "skipped" });
    return;
  }

  let needsThaw = false;
  let failed = false;
  try {
    // The Tabs API and CDP cannot check selection atomically. Recheck on
    // both sides of the command, and undo the freeze if activity overtook it.
    if (await stillEligible(true)) {
      // Recovery treats a freeze as possible from this write onward.
      await saveRecord(id, { ...attachment, needsThaw: true });
      if (await stillEligible(true) && !superseded()) {
        needsThaw = true;
        await setLifecycle(id, "frozen");
        if (await stillEligible() && !superseded()) return;
      }
    }
  } catch (error) {
    failed = true;
    console.debug("Tab Freezer could not freeze a tab", id, error);
  }
  const nextPhase = failed || debuggerDetaches.has(id) ? "skipped" : "waiting";
  const cleanup = { ...attachment, needsThaw };
  if (snapshotUnavailable) cleanup.snapshotRetryAt = Date.now() + RETRY_DELAY;
  verifiedDocuments.delete(id);
  await releaseDebugger(id, cleanup, nextPhase);
  if (!snapshotUnavailable) requestReconcile();
}

function setLifecycle(id, state) {
  return chrome.debugger.sendCommand({ tabId: id }, "Page.setWebLifecycleState", { state });
}

function afterRelease(record, phase) {
  const { needsThaw, retryAt, nextPhase, ...interval } = record;
  return phase ? { ...interval, phase } : null;
}

async function releaseDebugger(id, record, nextPhase) {
  // An older attachment without a journal flag may have frozen the page.
  let releasing = { ...record, phase: "releasing", needsThaw: record.needsThaw !== false, nextPhase };
  // Keep cleanup pending in this worker even if a journal write fails.
  records.set(id, releasing);
  await saveRecord(id, releasing);
  if (!debuggerDetaches.has(id)) {
    try {
      if (releasing.needsThaw) {
        await setLifecycle(id, "active");
        releasing = { ...releasing, needsThaw: false };
        records.set(id, releasing);
        await saveRecord(id, releasing);
      }
      await chrome.debugger.detach({ tabId: id });
    } catch (error) {
      const alreadyDetached = debuggerDetaches.has(id) ||
        /Debugger is not attached|Detached while handling command/.test(String(error));
      if (!alreadyDetached) {
        console.debug("Tab Freezer will retry debugger cleanup", id, error);
        await saveRecord(id, { ...releasing, retryAt: Date.now() + RETRY_DELAY });
        return false;
      }
    }
  }
  await saveRecord(id, afterRelease(releasing, nextPhase));
  return true;
}
