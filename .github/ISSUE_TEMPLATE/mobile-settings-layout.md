---
name: Mobile settings layout
about: Track the narrow-viewport Remote Access settings regression
title: "fix: make Remote Access settings usable on mobile viewports"
labels: bug, ui
---

## Problem

At a 390 x 844 viewport, the DSH settings navigation and the plugin's two-column layout leave too little content width. Device names and Relay URLs wrap one character per line, and the page overflows horizontally.

## Acceptance criteria

- Remote Access uses a single-column layout when its actual container is narrow.
- Device details, pairing controls, and access timeline remain readable at 320 px content width.
- Long device names and URLs wrap at sensible boundaries without horizontal page overflow.
- Desktop settings layout remains unchanged.
- Add screenshot coverage for 390 x 844 and the desktop settings viewport.

## Known location

`client.js`, especially the `.dshm-grid` mobile breakpoint.
