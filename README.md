# Lottery Ball System

A live lottery-ball drawing system for raffles and events. A large lottery machine (your supplied GIF, played under state control) mixes the balls, a ball rises through the tube, and the winner is announced on every connected screen.

It is a separate application from Wheel of Fortune: its own Supabase project, `lottery_*` tables and functions, `VITE_LOTTERY_*` environment variables, and its own GitHub Pages deployment.

## Quick start

1. Follow **[SUPABASE_SETUP.md](SUPABASE_SETUP.md)** to create the new `lottery-ball-system` Supabase project and run `supabase/schema.sql`.
2. `cp .env.example .env.local` and fill in the new project's URL and publishable key.
3. ```sh
   npm ci
   npm run dev
   ```
4. Open `http://localhost:5173/?view=operator`, sign in, create an event, then open the **audience link**.

Deploy with **[GITHUB_DEPLOYMENT.md](GITHUB_DEPLOYMENT.md)**. Check and troubleshoot the database with **[DATABASE_VERIFICATION.md](DATABASE_VERIFICATION.md)**.

Without any `.env.local`, the app runs in **local mode** (one browser, data in IndexedDB), which is handy for trying the machine.

## Routes (work under any GitHub Pages sub-path)

| Screen | URL |
|---|---|
| Audience / drawing screen | `/?event=<EVENT_ID>` |
| Operator sign-in & event list | `/?view=operator` |
| Operator console for an event | `/?view=operator&event=<EVENT_ID>` |

## How a draw works

1. The audience screen's **Draw a Winner** button is disabled and `begin_lottery_draw` runs in the database.
2. The database picks the winner (secure weighted random, or the armed one-time pick) and stores it in a **private** table. The browser receives only a ticket (`drawId`, start time, duration), never the winner.
3. The machine mixes the balls for the configured duration (3 to 30 s, Settings). Frames 1 to 4 of the GIF loop, so it never freezes.
4. The ball rises through the tube (GIF frames 5 to 8) and is pulled into focus.
5. `finish_lottery_draw` records the winner. The database refuses to finish before the configured duration has elapsed, and retrying is safe (no duplicate winner).
6. The name, congratulation and confetti appear, and Realtime updates every other device.

Other devices watching the event play the same mixing and reveal sequence and show the winner when the result arrives. If the drawing tab is refreshed mid-draw it resumes the same draw; if the network drops after the reveal it offers **Retry** and nothing is lost.

## The animation

`public/assets/lottery-machine.gif` is your original GIF (439 x 390, 9 frames, 450 ms each). A plain GIF can only loop its whole clip, so `scripts/extract-frames.py` also derives `lottery-machine-frames.webp`, a sprite strip of exactly the same 9 frames, which `LotteryMachine.tsx` plays as: idle = frame 0, mixing = frames 1 to 4 (looping, never repeating a frame back to back), reveal = frames 5 to 8 once at the original pace. If the sprite cannot load, the component falls back to the plain animated GIF. The aspect ratio is preserved at every screen size.

## Security model (improved over the Wheel of Fortune schema)

* **Pending winner is private.** In the old schema `pending_winner` was readable by everyone. Here it lives in `lottery_draws`, which no API role can read.
* **Predetermined winner is private.** It is stored in `lottery_event_secrets` (owner-readable only) through the owner-only `set_lottery_override` function, so it is never in the publicly readable, realtime-broadcast event data. A trigger also strips those keys from `data` if anything tries to write them.
* **One draw at a time**, enforced by a unique partial index; abandoned draws expire after 2 minutes; the owner can cancel a stuck draw.
* **Roster and history are frozen during a draw.** The roster cannot change while a draw is reserved.
* **Owner switches** (Settings): *Allow anyone with the audience link to start a draw* and *to add/import/remove participants* (both default **on**, as in the original). Weights and duplicate-keeping on import are operator-only.
* RLS is on for every table; functions use `SECURITY DEFINER` with `search_path = ''` and explicit `EXECUTE` grants.

Known trade-off: event rows are readable by anyone holding the project's publishable key (needed for Realtime), so event IDs are unguessable UUIDs but not secret from someone who can list the table. Do not put confidential information in names or titles.

## Features

Participants (add, remove, edit names and **weights**, clear, deduplicate, XLSX/XLS/CSV import with worksheet and name/weight column selection, preview, append/replace, export); winners (history, search, export, restore, clear, auto-remove, mode label: random / weighted / operator pick); events (create, list, delete, audience and operator links, live sync); operator console (magic-link sign-in, hidden predetermined-winner shortcut, settings, backup and restore, reset); presentation (fullscreen, music and sound effects, confetti, custom title, responsive layout).

## Tests

```sh
npm test      # winner selection, weights, GIF frame plan, service layer, validation, shortcut
npm run build # type-check + production build
```

## Files

`supabase/schema.sql` database · `src/components/LotteryMachine.tsx` machine · `src/components/WinnerAnnouncement.tsx` · `src/services/lotteryService.ts` all database access · `src/machineTimeline.ts` frame plan · `src/engine.ts` selection (local mode) · `.github/workflows/deploy-pages.yml` deployment.
