export const TIMEOUTS = [1, 5, 10, 30];

const DEFAULTS = {
  enabled: true,
  timeoutMinutes: 5,
  excludedHosts: [],
  excludeAudible: true,
  excludePinned: true,
};

export function readSettings() {
  return chrome.storage.local.get(DEFAULTS);
}

export function canonicalHost(hostname) {
  return hostname.toLowerCase().replace(/\.$/, "");
}

export function parseExcludedHosts(text) {
  const hosts = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  return [...new Set(hosts.map(host => {
    try {
      const url = new URL(`https://${host}`);
      // A colon is only part of a hostname inside an IPv6 literal.
      if (/[\s/\\@?#*%]/u.test(host) || (!/^\[.*\]$/.test(host) && host.includes(":"))) {
        throw new Error();
      }
      const hostname = canonicalHost(url.hostname);
      if (!hostname || hostname.split(".").some(label => !label)) {
        throw new Error();
      }
      return hostname;
    } catch {
      throw new Error(`Enter a hostname without a URL, port, or wildcard. Check “${host}”.`);
    }
  }))];
}
