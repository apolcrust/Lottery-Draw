# Technical assessment of the original Wheel of Fortune project

**Source used:** `Wheel of Fortune/wheel of fortune/` (the newer Supabase-enabled implementation). The root-level project is the older client-only version and was not used.

1. **Architecture.** Vite + React 18 + TypeScript SPA. One large `App.tsx` (audience screen and operator console selected by `?view=operator`), `Wheel.tsx` canvas wheel, `engine.ts` (selection plus wheel maths), `storage.ts` (IndexedDB + validation), `supabaseClient.ts`.
2. **Features.** Participants (add/remove/dedupe/clear, XLSX/XLS/CSV import with preview, export), random/weighted/predetermined winner, winner history (search/export/restore/clear), auto-removal, confetti, tones and spin music, fullscreen, backup/restore, offline service worker, local mode and shared mode.
3. **Supabase.** Anonymous audience + magic-link operator; one table `wheel_events` with a JSONB `data` document; RLS; Realtime on that table.
4. **Tables / RPC.** `wheel_events`; `begin_wheel_spin`, `finish_wheel_spin`, `import_wheel_participants`, `manage_wheel_participants` (all executable by `anon`).
5. **Deployment.** GitHub Actions: `npm ci`, secret validation, tests, `vite build --base`, Pages upload/deploy; base path is computed for project vs user sites.
6. **Replaced.** `Wheel.tsx`, wheel maths/timing in `engine.ts`, wheel styling, Supabase names and env vars, wheel copy.
7. **Kept (reworked where noted).** Participant/duplicate logic, import/export, operator shortcut hook, IndexedDB local mode, validation, theme, magic-link auth, Pages workflow, offline cache.
8. **Findings that changed the design.**
   * `pending_winner` and `pending_mode` were selectable by everyone, so the winner was visible before the reveal.
   * The one-time pick (`overrideParticipantId`) sat in the public `data` column and in Realtime payloads.
   * The client received the winner from `begin_*` and could finish immediately (no minimum duration).
   * `finish_*` was not idempotent on retry; no way to cancel a stuck spin; audience import could set unlimited duplicates.
   Fixes: private `lottery_draws` and `lottery_event_secrets`, `begin` returns only a ticket, time-gated idempotent `finish`, owner-only `set_lottery_override` / `cancel_lottery_draw`, a unique partial index for a single active draw, a data-stripping trigger, operator-only weights/duplicates.
9. **New architecture.** `lottery_events` (public state) + `lottery_draws` (private transactions) + `lottery_event_secrets` (owner-only). All database access in `src/services/lotteryService.ts`. The machine is a presentational, state-driven component.
