import { parseExcludedHosts, readSettings, TIMEOUTS } from "./settings.js";

const form = document.querySelector("#settings");
const status = document.querySelector("#status");
const button = form.querySelector("button");
const { enabled, timeoutMinutes, excludeAudible, excludePinned, excludedHosts } = form.elements;

for (const minutes of TIMEOUTS) {
  timeoutMinutes.add(new Option(minutes === 1 ? "1 minute" : `${minutes} minutes`, minutes));
}

try {
  const settings = await readSettings();
  enabled.checked = settings.enabled;
  timeoutMinutes.value = settings.timeoutMinutes;
  excludeAudible.checked = settings.excludeAudible;
  excludePinned.checked = settings.excludePinned;
  excludedHosts.value = settings.excludedHosts.join("\n");
  button.disabled = false;
} catch {
  status.textContent = "Could not load settings.";
}

form.addEventListener("input", () => {
  status.textContent = "";
  excludedHosts.setCustomValidity("");
});

form.addEventListener("submit", async event => {
  event.preventDefault();
  let hosts;
  try {
    hosts = parseExcludedHosts(excludedHosts.value);
  } catch (error) {
    excludedHosts.setCustomValidity(error.message);
    excludedHosts.reportValidity();
    return;
  }

  button.disabled = true;
  try {
    await chrome.storage.local.set({
      enabled: enabled.checked,
      timeoutMinutes: Number(timeoutMinutes.value),
      excludeAudible: excludeAudible.checked,
      excludePinned: excludePinned.checked,
      excludedHosts: hosts,
    });
    excludedHosts.value = hosts.join("\n");
    status.textContent = "Settings saved.";
  } catch {
    status.textContent = "Could not save settings.";
  } finally {
    button.disabled = false;
  }
});
