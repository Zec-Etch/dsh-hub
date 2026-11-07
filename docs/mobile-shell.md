# Mobile shell notes

`hub/public/shell/boot.js` and `mobile.css` are injected into the HTML of every proxied DSH page (the hub sets `window.__DSH_HUB__ = { id }` first). DSH itself is never modified, so everything here is defensive about DOM and class names it does not control.

## Rules of the road

- **Selectors**: match the semantic part of CSS-module classes (`[class*="_sidebarCol"]`) and DSH's `data-*` attributes; never the hashed prefix.
- **Compact layout** is `(max-width: 767px), (max-device-height: 500px) and (pointer: coarse)`. It keys off the *device* height, not the window height: a soft keyboard shrinks the window and would otherwise turn a tablet's tiled sidebar into a drawer on top of the composer.
- **Storage**: all backends share one origin, so `localStorage`/`sessionStorage` keys are prefixed `hub:<id>:` per backend (`isolateStorage`).
- **Events**: do not stop events that DSH's menus rely on. DSH menus choose on `mousedown`, and a file dialog must open inside the same user gesture; swallowing the event broke the iOS file picker once.
- **Diagnostics**: long-press the menu button. The panel prints viewport, safe-area, layout rectangles, positioned elements in the status-bar band, and the last editor events. Reports with that panel are far easier to act on than descriptions.

## iOS findings

- **Home-screen window height.** An installed iOS web app can report `innerHeight = screen.height − status-bar height` (for example 797 on an 844pt screen) while the page still starts at the top. The strip below cannot be used: drawing into it works, but the system covers it with a white bar. The layout therefore stops at the window and pads only the part of the home-indicator inset that strip does not already cover, capped at a small clearance, because the indicator is a thin bar and the composer has its own padding.
- **Composer buttons raise the keyboard.** DSH keeps the draft focused on `mousedown` of toolbar buttons. Setting `inputmode="none"` on the editor before DSH focuses it keeps the keyboard down, and a tap on the editor restores it. No event is stopped.
- **Command chips cannot be deleted.** DSH deletes a command chip in two steps (first Backspace selects it, the second deletes) and clears the selection on the next `keydown` unless that keydown also deleted. A soft keyboard deletes through `beforeinput` only, so the keydown always cleared the selection first and the chip was only ever re-selected; holding Backspace worked because auto-repeat sends no `keydown`. The shell hides the `keydown` of Backspace/Delete from DSH while a chip is selected on touch devices, and replays a Backspace as `beforeinput` if none followed. Regression checks: `hub/test-browser/shell-input.mjs`.
- **Desktop-only chrome.** DSH floats the collapsed sidebar's controls in a "leading seat" (`[data-shell-leading]`) where a desktop has window buttons. On a phone that is the status bar, so it is hidden; the shell's menu button replaces it.
- **Sizing.** Fonts in inputs are at least 16px (iOS zooms otherwise); the viewport meta uses `viewport-fit=cover` and the shell tracks `visualViewport` into `--hub-vh`.

## Testing without a device

Layout fixtures can be built from DSH's own stylesheets plus the shell and driven by Playwright (Chromium via CDP, and WebKit). They emulate safe areas (`Emulation.setSafeAreaInsetsOverride`) and viewport changes, but they are emulation: soft-keyboard behaviour, home-screen window sizes and file pickers must be confirmed on a real iPhone. DSH's stylesheets are not redistributed here, so such fixtures are not part of this repository.
