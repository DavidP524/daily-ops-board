# Working Guide

This project has one source of truth: the root folder.

Edit these files only:

- `public/index.html` for the app UI
- `server.js` for the API, storage, and notification logic
- `public/sw.js` for service worker and push handling
- `public/manifest.json` and `public/icons/` for PWA metadata
- `vercel.json` for deployment routing

Do not edit app copies inside `.claude/`, `.worktrees/`, archives, or temporary folders. If a tool creates a worktree, merge the desired changes back into the root project and then stop using that duplicate copy.

Local testing should use:

```bash
npm start
```

Then open:

```text
http://localhost:3000
```

Avoid opening `public/index.html` directly with `file://` for app testing because service workers, API calls, push notifications, and local storage behavior differ from the served app.
