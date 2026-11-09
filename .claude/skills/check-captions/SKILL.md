---
name: check-captions
description: Run the captions app locally and check a change works on the real pages (phone page, admin, transcript), before showing it to the user or committing. Also covers checking the live site after a deploy.
---

# Checking a change

1. Run `npm test` and `npm run smoke` from the `captions-app` folder. Both must pass.
2. For anything the smoke check doesn't cover, check it on the real page:
   - Copy the app into a scratch folder (the files in the `Dockerfile` COPY lines) and run
     `node ws-server.js` there with `PORT` set to a spare port and `NODE_PATH` pointing at this
     folder's `node_modules`. Running it here would write into the real `captions.log`.
   - `scripts/smoke.js` shows how to drive the pages in headless Chrome. Copy its helpers
     for a one-off script in the scratch folder rather than growing `smoke.js` for every change.
   - Set statuses with `POST /api/audience-status` and a body of `{ "status", "message" }`
     (statuses: offline, starting_soon, live, paused, ended, custom).
   - On the phone page, add a caption with `addCaption({ type: 'caption', text, timestamp })`.
   - To test with Soniox without a key, point `SONIOX_WS_URL` at a small fake WebSocket server.
   - Check at phone size (390x844) and take a screenshot to show the user.
3. Only add a check to `smoke.js` when it guards something that broke before or would be
   easy to break again. Keep it quick.

# Testing against real Soniox

- The user's current key is the commented `SONIOX_MASTER_API_KEY=` line in `.env` (not the
  `(old)` one, which is out of credits). Read it from there, and never print it.
- On the user's PC, Kaspersky inspects HTTPS, so Node refuses Soniox's certificate
  (`SELF_SIGNED_CERT_IN_CHAIN`). Run Node with `--use-system-ca`. Never turn certificate
  checking off.
- A real 10-minute talk is at `M:\JGM\test-adio\sample-audio.m4a`. Its index is at the end, so
  Soniox can't stream it as is: decode it to 16 kHz mono s16le first (headless Chrome's
  `decodeAudioData` works; there's no ffmpeg), then send 3200-byte chunks every 100 ms.
- Usage is about $0.12 per hour of audio. Say how much a test will use before running it.

# After a deploy

- The workflow waits for https://translate.joshuageneration.org to answer.
- To look at it, open the live phone page in Chrome (Claude in Chrome), confirm it loads with
  no console errors, and take a screenshot.
- On the live site, only look: never press anything on `/client`, since it controls what
  everyone's phones show.
