# Test freezing and resuming

Install the unpacked extension and save a **1 minute** timeout in its options. Serve the test page from the repository root.

```sh
python3 -m http.server 8000 --bind 127.0.0.1 --directory test
```

1. Open `http://127.0.0.1:8000/`. Check that the counter advances, type sample text, and note the **Page instance** ID.
2. Select a different tab in the same window. Leave the test tab unpinned and keep its DevTools closed.
3. Wait at least 70 seconds. Chrome may deliver the alarm later, so allow additional time if needed.
4. Return to the test tab. Verify that the **Lifecycle events** list shows a `freeze` and a `resume` with the same counter value and a gap between their timestamps. The matching values show that the timer stayed paused throughout the gap.
5. Confirm the counter advances again, the input still contains your sample text, the instance ID is unchanged, and **Discarded by Chrome before loading** stays `false`.

To observe the frozen state before returning, open `chrome://discards` in the other tab and check the test tab's lifecycle state. Selecting the test tab itself resumes it. To check per-window behavior, leave the test tab selected in one window and work in another. It should continue running.

## Document deadlines

With the one-minute timeout, run this in the test page's console. Close DevTools and immediately switch to another tab.

```js
setTimeout(() => history.pushState(null, "", "?step=push"), 8_000);
setTimeout(() => history.replaceState(null, "", "?step=replace"), 18_000);
setTimeout(() => { location.hash = "fragment"; }, 29_000);
```

Verify in `chrome://discards` that the test tab freezes about one minute after switching away, subject to Chrome's alarm delivery. Return to the test tab and verify the timer resumes with the same page instance and input.

To test a reload without selecting the test tab, run `setTimeout(() => location.reload(), 15_000)` from a fresh test page, close DevTools, and immediately switch away. Check that the tab remains unfrozen at the original deadline and freezes about one minute after the reload. The URL should be the same, and the **Page instance** ID should change.

Run the worker regression tests with Node.js 22 or later.

```sh
node --test test/background.test.mjs
```

## Browser verification

On November 20, 2026, the headed Linux build of Chrome for Testing Stable **158.0.8127.36** was used to verify the CDP approach before implementation. An attached background page advanced its interval until it received `frozen`. The interval stopped, the page emitted `freeze`, and selecting the tab with an `active` request restored its interval. The document ID, input, JavaScript state, DOM counter, and scroll position survived. In a separate run, detaching while the page was hidden left it frozen until Chrome thawed it on selection. [Chrome for Testing release channels](https://googlechromelabs.github.io/chrome-for-testing/)

The unpacked extension passed the same sequence with the one-minute timeout. Chrome suspended the worker during the wait and woke it at the deadline. The browser checks also covered quick tab switching, a selected tab in another window, pinned and audible tabs, a hostname exclusion, an existing debugger, a window move, navigation, closure, and disabling freezing with a hidden page still frozen.
