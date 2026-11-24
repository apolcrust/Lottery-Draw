# Database verification and troubleshooting

Run these in **SQL Editor** of the **lottery-ball-system** project.

## 1. Objects exist
```sql
select table_name from information_schema.tables
where table_schema = 'public' and table_name like 'lottery_%' order by 1;
-- expect: lottery_draws, lottery_event_secrets, lottery_events

select routine_name from information_schema.routines
where routine_schema = 'public' and routine_name like '%lottery%' order by 1;
-- expect: begin_lottery_draw, cancel_lottery_draw, finish_lottery_draw, import_lottery_participants,
--         lottery_events_after_insert, lottery_events_after_update, lottery_events_before_write,
--         manage_lottery_participants, set_lottery_override
```

## 2. Row Level Security is on
```sql
select relname, relrowsecurity from pg_class
where relname in ('lottery_events','lottery_draws','lottery_event_secrets');
-- all three: true

select tablename, policyname, cmd from pg_policies where schemaname = 'public' order by 1, 2;
-- lottery_events: select / insert / update / delete policies; lottery_event_secrets: select; lottery_draws: none
```

## 3. Realtime
```sql
select tablename from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public';
-- must list lottery_events
```

## 4. The pending winner and predetermined pick are not exposed
```sql
select has_table_privilege('anon', 'public.lottery_draws', 'select')          as anon_reads_draws,   -- false
       has_table_privilege('authenticated', 'public.lottery_draws', 'select') as auth_reads_draws,   -- false
       has_table_privilege('anon', 'public.lottery_event_secrets', 'select')  as anon_reads_secrets; -- false
```

## 5. Functions are callable by the right roles
```sql
select p.proname, has_function_privilege('anon', p.oid, 'execute') as anon, has_function_privilege('authenticated', p.oid, 'execute') as authenticated
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname in ('begin_lottery_draw','finish_lottery_draw','import_lottery_participants','manage_lottery_participants','set_lottery_override','cancel_lottery_draw');
-- first four: anon = true; set_lottery_override and cancel_lottery_draw: anon = false
```

## 6. Inspect a draw while testing
```sql
select e.id, e.is_drawing, e.draw_started_at, d.status, d.mode, d.earliest_finish_at
from public.lottery_events e left join public.lottery_draws d on d.event_id = e.id
order by e.updated_at desc limit 5;
```
(`lottery_draws.selected_participant` is the hidden winner; only you, in the SQL editor, can see it.)

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| SQL error `relation "auth.users" does not exist` | You are not in a Supabase project's SQL Editor. |
| App says "Supabase is configured incorrectly" | URL must be the full `https://<id>.supabase.co`; both variables must be set; rebuild or restart `npm run dev` after editing `.env.local`. |
| `Could not find the function public.begin_lottery_draw` | `schema.sql` did not run (or ran on another project). Run it, then wait a few seconds for the API schema cache (the script sends `notify pgrst, 'reload schema'`). |
| `permission denied for table lottery_events` when creating an event | You are signed out, or the grants block failed. Re-run `schema.sql`. |
| Magic link opens the wrong site / "redirect not allowed" | Add the exact site to Authentication, URL Configuration, Redirect URLs (with `/**`). |
| No email arrives | Default sender is rate-limited; check spam; configure SMTP. |
| Live updates do not arrive, "Live updates could not connect" | Check query 3; check the project is not paused (free projects pause after inactivity). |
| `function pg_catalog.unnest(text[], numeric[]) does not exist` when importing | You are running an older `schema.sql`. Re-run the latest one (the import is now a single fast query and handles thousands of names). |
| `A draw is already in progress` | Another device is drawing. Stuck for over 2 minutes? It expires automatically, or use **Cancel draw in progress** in the operator console. |
| `The draw is not ready to be revealed yet` | The app waits and retries itself; the server enforces the configured duration. |
| `Only the event operator can ...` | The operator switched off audience drawing / roster editing in Settings. Sign in as the owner on the audience page or switch the option back on. |
| Old Wheel of Fortune data appears | You are pointing at the old project. Check `.env.local` and the GitHub secrets. |

To reset an event completely: delete it in the operator "Your lottery events" list (this also removes its private draw and secret rows).
