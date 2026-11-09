# JGM Live Captions

Live translated captions for our church. A personal project, not a product: keep changes simple
and don't over-engineer.

## What it does
- The pastor's audio goes to Soniox, which transcribes and translates it. Usually English or
  Malayalam into English; sometimes English into Kannada (another church). Languages are picked
  on the admin page and can be anything, so don't hard-code them.
- Captions go to people's phones, to Resolume (`/captions`) and optionally to YouTube.
- Joel builds separate tools that read the transcript (for example, finding scripture
  references). Keep the transcript and its API working, but those tools aren't in this repo.

## Live site
- https://translate.joshuageneration.org. Routes are the same as locally.
- `/` and `/audience`: the phone page (`audience.html`). Both must keep working.
- `/client`: the admin page. It has no password, so never press anything on the live one.
- `/transcript`: the transcript and caption review page, built inside `ws-server.js`.
- `/portal`: transcribes a recorded talk (`portal.html`). The browser uploads straight to
  Soniox's file API with the key typed into the page (shared with `/client`); the server only
  fills in the model and the church context. Two people use it, one talk at a time.

## Deploys
- Merging to `main` deploys straight away and restarts the server (GitHub Actions to Linode,
  Docker). The service status lives in memory, so a restart resets it to offline.
- The workflow runs `npm test` and `npm run smoke` first; if they fail, nothing deploys.
- Ask before committing, pushing or merging.

## Working on it
- `npm test`: unit tests. `npm run smoke`: starts the app and checks its pages load without
  errors in headless Chrome (about 20 seconds).
- Every app file must be listed in the `Dockerfile` COPY lines. The smoke check runs from that
  list, so a missing file fails there.
- `follow-scroll.js` is inlined into the phone page and `/transcript` by `ws-server.js`, not
  served on its own. Any route that serves `audience.html` must send `AUDIENCE_PAGE`.
- The older `*.md` guides in this folder are out of date (placeholder domains, port 8080).
  The live server uses port 3000.
- Check changes on the real pages before calling them done (see the `check-captions` skill).

## Windows notes
- Files have CRLF line endings; keep them when editing.
- In PowerShell 5.1, pass commit messages with `git commit -F <file>`; quotes in `-m` break.
- `gh` may not be on PATH: use `C:\Program Files\GitHub CLI\gh.exe`.
