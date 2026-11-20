# Tab Freezer

Tab Freezer is a Manifest V3 extension for Chrome 132 or later. It freezes eligible background tabs after five minutes by default and resumes their in-memory page state when selected.

## Install and use

1. Open `chrome://extensions` and enable **Developer mode**.
2. Choose **Load unpacked** and select the directory containing `manifest.json`.
3. Open **Details**, then **Extension options**. Enable or disable freezing, choose a 1, 5, 10, or 30 minute timeout, or enter excluded hostnames. Pinned tabs and tabs playing audio are excluded by default.

Chrome displays its debugger banner while the extension manages frozen tabs. See [behavior and technical limitations](docs/behavior.md) and [testing instructions](docs/testing.md).
