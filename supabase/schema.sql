-- =====================================================================================================
-- Lottery Ball System: database schema
--
-- Run this ONCE in the SQL Editor of the NEW Supabase project named "lottery-ball-system".
-- It must never be run against the original Wheel of Fortune project.
-- The script is idempotent: running it again updates functions/policies and leaves your data alone.
--
-- Design summary
--   lottery_events         Public, realtime-enabled event state (participants, winners, settings, draw status).
--   lottery_draws          PRIVATE. Holds the winner chosen by begin_lottery_draw until finish_lottery_draw
--                          reveals it. No role can read it directly, so the audience cannot peek.
--   lottery_event_secrets  PRIVATE to the event owner. Holds the one-time predetermined winner, so it is never
--                          broadcast to audience screens before the reveal.
-- =====================================================================================================

-- ---------------------------------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------------------------------

create table if not exists public.lottery_events (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  -- { participants: [{id,name,weight}], winners: [{participant,drawNumber,timestamp,mode}], settings: {...} }
  data jsonb not null,
  is_drawing boolean not null default false,
  draw_started_at timestamptz,
  draw_duration_ms integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint lottery_events_data_shape check (
    coalesce(jsonb_typeof(data), '') = 'object'
    and coalesce(jsonb_typeof(data -> 'participants'), '') = 'array'
    and coalesce(jsonb_typeof(data -> 'winners'), '') = 'array'
    and coalesce(jsonb_typeof(data -> 'settings'), '') = 'object'
  ),
  constraint lottery_events_draw_state check (
    (is_drawing and draw_started_at is not null and draw_duration_ms is not null)
    or (not is_drawing and draw_started_at is null and draw_duration_ms is null)
  ),
  constraint lottery_events_draw_duration_range check (
    draw_duration_ms is null or draw_duration_ms between 3000 and 30000
  )
);

create index if not exists lottery_events_owner_idx on public.lottery_events (owner_id, updated_at desc);

comment on table public.lottery_events is
  'Shared Lottery Ball events. Readable by anyone with the event link; writable only by the owner or by validated functions.';

create table if not exists public.lottery_draws (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.lottery_events (id) on delete cascade,
  selected_participant jsonb not null,
  mode text not null,
  status text not null default 'pending',
  started_at timestamptz not null default now(),
  earliest_finish_at timestamptz not null,
  completed_at timestamptz,
  constraint lottery_draws_mode_valid check (mode in ('random', 'weighted', 'controlled')),
  constraint lottery_draws_status_valid check (status in ('pending', 'completed', 'cancelled', 'expired'))
);

-- At most one unfinished draw per event: the database itself prevents conflicting simultaneous draws.
create unique index if not exists lottery_draws_one_pending_per_event
  on public.lottery_draws (event_id) where status = 'pending';
create index if not exists lottery_draws_event_idx on public.lottery_draws (event_id, started_at desc);

comment on table public.lottery_draws is
  'PRIVATE draw transactions. Contains the pending winner; no API role has any privilege on this table.';

create table if not exists public.lottery_event_secrets (
  event_id uuid primary key references public.lottery_events (id) on delete cascade,
  override_participant_id text,
  override_armed boolean not null default false,
  updated_at timestamptz not null default now(),
  constraint lottery_override_armed_needs_participant check (not override_armed or override_participant_id is not null)
);

comment on table public.lottery_event_secrets is
  'PRIVATE operator-only settings (the one-time predetermined winner). Readable only by the event owner.';

-- ---------------------------------------------------------------------------------------------------
-- 2. Row Level Security and grants
-- ---------------------------------------------------------------------------------------------------

alter table public.lottery_events enable row level security;
alter table public.lottery_draws enable row level security;
alter table public.lottery_event_secrets enable row level security;

revoke all on public.lottery_events from anon, authenticated;
revoke all on public.lottery_draws from anon, authenticated;
revoke all on public.lottery_event_secrets from anon, authenticated;

-- Audience (anon) and operators can read shared events. Writes by the audience happen ONLY through the
-- validated SECURITY DEFINER functions below.
grant select on public.lottery_events to anon, authenticated;
grant insert (owner_id, data) on public.lottery_events to authenticated;
grant update (data) on public.lottery_events to authenticated;
grant delete on public.lottery_events to authenticated;

-- Owners may read (never write directly) their private secrets row. lottery_draws has no grants at all.
grant select on public.lottery_event_secrets to authenticated;

drop policy if exists "Anyone can view a shared lottery event" on public.lottery_events;
create policy "Anyone can view a shared lottery event"
  on public.lottery_events for select
  to anon, authenticated
  using (true);

drop policy if exists "Operators can create their own lottery events" on public.lottery_events;
create policy "Operators can create their own lottery events"
  on public.lottery_events for insert
  to authenticated
  with check (owner_id = (select auth.uid()));

drop policy if exists "Operators can update their own lottery events" on public.lottery_events;
create policy "Operators can update their own lottery events"
  on public.lottery_events for update
  to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

drop policy if exists "Operators can delete their own lottery events" on public.lottery_events;
create policy "Operators can delete their own lottery events"
  on public.lottery_events for delete
  to authenticated
  using (owner_id = (select auth.uid()));

drop policy if exists "Owners can read their event secrets" on public.lottery_event_secrets;
create policy "Owners can read their event secrets"
  on public.lottery_event_secrets for select
  to authenticated
  using (exists (
    select 1 from public.lottery_events e
    where e.id = lottery_event_secrets.event_id and e.owner_id = (select auth.uid())
  ));

-- (lottery_draws: RLS enabled and NO policy and NO grants => completely inaccessible to API roles.)

-- ---------------------------------------------------------------------------------------------------
-- 3. Triggers
-- ---------------------------------------------------------------------------------------------------

create or replace function public.lottery_events_before_write()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- The predetermined winner must never be stored in the public data column.
  new.data := new.data - 'overrideParticipantId' - 'overrideActivated';

  if pg_catalog.octet_length(new.data::text) > 5000000 then
    raise exception 'The event data is too large.';
  end if;

  if tg_op = 'UPDATE' then
    -- While a draw is running the roster, history and settings are frozen (the draw is "reserved").
    -- finish_lottery_draw changes data and clears is_drawing in the same statement, which is allowed.
    if old.is_drawing and new.is_drawing and new.data is distinct from old.data then
      raise exception 'A draw is in progress. Wait for it to finish before changing the event.';
    end if;
    new.updated_at := pg_catalog.now();
  end if;

  return new;
end;
$$;

drop trigger if exists lottery_events_before_write on public.lottery_events;
create trigger lottery_events_before_write
  before insert or update on public.lottery_events
  for each row execute function public.lottery_events_before_write();

create or replace function public.lottery_events_after_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.lottery_event_secrets (event_id) values (new.id) on conflict (event_id) do nothing;
  return null;
end;
$$;

drop trigger if exists lottery_events_after_insert on public.lottery_events;
create trigger lottery_events_after_insert
  after insert on public.lottery_events
  for each row execute function public.lottery_events_after_insert();

-- If the predetermined participant leaves the roster for any reason, disarm the one-time pick.
create or replace function public.lottery_events_after_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.data is distinct from old.data then
    update public.lottery_event_secrets as s
    set override_participant_id = null, override_armed = false, updated_at = pg_catalog.now()
    where s.event_id = new.id
      and s.override_participant_id is not null
      and not exists (
        select 1
        from pg_catalog.jsonb_array_elements(new.data -> 'participants') as p(value)
        where p.value ->> 'id' = s.override_participant_id
      );
  end if;
  return null;
end;
$$;

drop trigger if exists lottery_events_after_update on public.lottery_events;
create trigger lottery_events_after_update
  after update on public.lottery_events
  for each row execute function public.lottery_events_after_update();

revoke all on function public.lottery_events_before_write() from public;
revoke all on function public.lottery_events_after_insert() from public;
revoke all on function public.lottery_events_after_update() from public;

-- ---------------------------------------------------------------------------------------------------
-- 4. begin_lottery_draw
--    Chooses the winner (secure weighted random, or the armed predetermined winner), stores it privately,
--    locks the event and returns ONLY the transaction id and timing. The winner is not returned.
-- ---------------------------------------------------------------------------------------------------

create or replace function public.begin_lottery_draw(p_event_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event public.lottery_events%rowtype;
  v_secret public.lottery_event_secrets%rowtype;
  v_uid uuid := auth.uid();
  v_participants jsonb;
  v_selected jsonb;
  v_mode text;
  v_total numeric;
  v_distinct_weights integer;
  v_roll numeric;
  v_running numeric := 0;
  v_participant jsonb;
  v_duration_s integer := 8;
  v_draw_id uuid := pg_catalog.gen_random_uuid();
  v_now timestamptz := pg_catalog.now();
begin
  select * into v_event from public.lottery_events where id = p_event_id for update;
  if not found then
    raise exception 'Lottery event not found.';
  end if;

  if not (coalesce((v_event.data #>> '{settings,audienceCanDraw}')::boolean, true) or v_uid = v_event.owner_id) then
    raise exception 'Only the event operator can start a draw for this event.';
  end if;

  if v_event.is_drawing then
    if v_event.draw_started_at > v_now - interval '2 minutes' then
      raise exception 'A draw is already in progress.';
    end if;
    -- A draw abandoned for more than two minutes (closed browser, lost network) is expired automatically.
    update public.lottery_draws set status = 'expired' where event_id = p_event_id and status = 'pending';
  end if;

  v_participants := v_event.data -> 'participants';
  if pg_catalog.jsonb_typeof(v_participants) <> 'array' or pg_catalog.jsonb_array_length(v_participants) = 0 then
    raise exception 'Add participants before starting a draw.';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(v_participants) as p(value)
    where coalesce(pg_catalog.jsonb_typeof(p.value -> 'weight'), '') <> 'number'
      or (p.value ->> 'weight')::numeric <= 0
      or coalesce(p.value ->> 'id', '') = ''
  ) then
    raise exception 'The participant list has invalid weights or identifiers.';
  end if;

  -- 1) One-time predetermined winner (operator-only, private).
  select * into v_secret from public.lottery_event_secrets where event_id = p_event_id for update;
  if found and v_secret.override_armed and v_secret.override_participant_id is not null then
    select p.value into v_selected
    from pg_catalog.jsonb_array_elements(v_participants) as p(value)
    where p.value ->> 'id' = v_secret.override_participant_id
    limit 1;
    if v_selected is not null then
      v_mode := 'controlled';
    end if;
  end if;

  -- 2) Otherwise: secure weighted random selection (uniform when all weights are 1).
  if v_selected is null then
    select sum((p.value ->> 'weight')::numeric), count(distinct (p.value ->> 'weight')::numeric)
    into v_total, v_distinct_weights
    from pg_catalog.jsonb_array_elements(v_participants) as p(value);

    if v_total is null or v_total <= 0 then
      raise exception 'The participant list has invalid weights.';
    end if;

    -- 48 random bits from a v4 UUID (the first 12 hex digits contain no fixed version/variant bits).
    v_roll := (
      (('x' || pg_catalog.substr(pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', ''), 1, 12))::bit(48)::bigint)::numeric
      + 0.5
    ) / 281474976710656::numeric * v_total;

    for v_participant in
      select p.value
      from pg_catalog.jsonb_array_elements(v_participants) with ordinality as p(value, ordinality)
      order by p.ordinality
    loop
      v_running := v_running + (v_participant ->> 'weight')::numeric;
      if v_roll < v_running then
        v_selected := v_participant;
        exit;
      end if;
    end loop;

    if v_selected is null then
      -- Floating-point edge: fall back to the last participant rather than failing the draw.
      v_selected := v_participants -> (pg_catalog.jsonb_array_length(v_participants) - 1);
    end if;
    v_mode := case when v_distinct_weights > 1 then 'weighted' else 'random' end;
  end if;

  if pg_catalog.jsonb_typeof(v_event.data #> '{settings,duration}') = 'number' then
    v_duration_s := least(30, greatest(3, pg_catalog.round((v_event.data #>> '{settings,duration}')::numeric)::integer));
  end if;

  delete from public.lottery_draws
  where event_id = p_event_id and status <> 'pending' and started_at < v_now - interval '90 days';

  insert into public.lottery_draws (id, event_id, selected_participant, mode, status, started_at, earliest_finish_at)
  values (v_draw_id, p_event_id, v_selected, v_mode, 'pending', v_now, v_now + v_duration_s * interval '1 second');

  update public.lottery_events
  set is_drawing = true, draw_started_at = v_now, draw_duration_ms = v_duration_s * 1000
  where id = p_event_id;

  return pg_catalog.jsonb_build_object(
    'drawId', v_draw_id,
    'startedAt', v_now,
    'durationMs', v_duration_s * 1000
  );
end;
$$;

-- ---------------------------------------------------------------------------------------------------
-- 5. finish_lottery_draw
--    Reveals and records the winner chosen by begin_lottery_draw. Idempotent: retrying after a network
--    failure returns the already-recorded result and never creates a duplicate winner.
-- ---------------------------------------------------------------------------------------------------

create or replace function public.finish_lottery_draw(p_event_id uuid, p_draw_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event public.lottery_events%rowtype;
  v_draw public.lottery_draws%rowtype;
  v_data jsonb;
  v_participants jsonb;
  v_record jsonb;
  v_now timestamptz := pg_catalog.now();
begin
  select * into v_event from public.lottery_events where id = p_event_id for update;
  if not found then
    raise exception 'Lottery event not found.';
  end if;

  select * into v_draw from public.lottery_draws where id = p_draw_id and event_id = p_event_id for update;
  if not found then
    raise exception 'That draw does not belong to this event.';
  end if;

  if v_draw.status = 'completed' then
    return v_event.data;
  end if;
  if v_draw.status <> 'pending' then
    raise exception 'This draw is no longer active (it was %).', v_draw.status;
  end if;
  if not v_event.is_drawing then
    raise exception 'There is no active draw to finish.';
  end if;

  if v_now < v_draw.earliest_finish_at then
    raise exception 'The draw is not ready to be revealed yet. Retry in % ms.',
      pg_catalog.ceil(extract(epoch from (v_draw.earliest_finish_at - v_now)) * 1000)::integer;
  end if;

  v_data := v_event.data;
  v_record := pg_catalog.jsonb_build_object(
    'participant', v_draw.selected_participant,
    'drawNumber', pg_catalog.jsonb_array_length(coalesce(v_data -> 'winners', '[]'::jsonb)) + 1,
    'timestamp', v_now,
    'mode', v_draw.mode
  );

  if coalesce((v_data #>> '{settings,autoRemove}')::boolean, true) then
    select coalesce(pg_catalog.jsonb_agg(p.value order by p.ordinality), '[]'::jsonb)
    into v_participants
    from pg_catalog.jsonb_array_elements(v_data -> 'participants') with ordinality as p(value, ordinality)
    where p.value ->> 'id' <> v_draw.selected_participant ->> 'id';
    v_data := pg_catalog.jsonb_set(v_data, '{participants}', v_participants, true);
  end if;

  v_data := pg_catalog.jsonb_set(
    v_data, '{winners}',
    pg_catalog.jsonb_build_array(v_record) || coalesce(v_data -> 'winners', '[]'::jsonb),
    true
  );

  update public.lottery_events
  set data = v_data, is_drawing = false, draw_started_at = null, draw_duration_ms = null
  where id = p_event_id;

  update public.lottery_draws set status = 'completed', completed_at = v_now where id = p_draw_id;

  -- The predetermined pick is single-use: consume it when it was the one that decided this draw.
  if v_draw.mode = 'controlled' then
    update public.lottery_event_secrets
    set override_participant_id = null, override_armed = false, updated_at = v_now
    where event_id = p_event_id;
  end if;

  return v_data;
end;
$$;

-- ---------------------------------------------------------------------------------------------------
-- 6. import_lottery_participants
-- ---------------------------------------------------------------------------------------------------

create or replace function public.import_lottery_participants(
  p_event_id uuid,
  p_names text[],
  p_action text,
  p_keep_duplicates boolean,
  p_weights numeric[] default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event public.lottery_events%rowtype;
  v_data jsonb;
  v_existing jsonb;
  v_new jsonb;
  v_participants jsonb;
  v_weights numeric[];
begin
  if p_action is null or p_action not in ('append', 'replace') then
    raise exception 'Choose whether to add to or replace the participant list.';
  end if;
  if p_keep_duplicates is null then
    raise exception 'The duplicate-name setting is required.';
  end if;
  if p_names is null or pg_catalog.cardinality(p_names) = 0 or pg_catalog.cardinality(p_names) > 10000 then
    raise exception 'Import between 1 and 10000 participant names at a time.';
  end if;
  if exists (
    select 1
    from pg_catalog.unnest(p_names) as input(name)
    where input.name is null
      or pg_catalog.char_length(pg_catalog.btrim(input.name)) = 0
      or pg_catalog.char_length(pg_catalog.btrim(input.name)) > 100
  ) then
    raise exception 'Participant names must contain 1 to 100 non-space characters.';
  end if;

  if p_weights is null then
    v_weights := pg_catalog.array_fill(1::numeric, array[pg_catalog.cardinality(p_names)]);
  else
    if pg_catalog.cardinality(p_weights) <> pg_catalog.cardinality(p_names) then
      raise exception 'Provide exactly one weight for every imported name.';
    end if;
    if exists (select 1 from pg_catalog.unnest(p_weights) as w(weight) where w.weight is null or w.weight <= 0 or w.weight > 1000) then
      raise exception 'Participant weights must be greater than 0 and at most 1000.';
    end if;
    v_weights := p_weights;
  end if;

  select * into v_event from public.lottery_events where id = p_event_id for update;
  if not found then
    raise exception 'Lottery event not found.';
  end if;
  if not (coalesce((v_event.data #>> '{settings,audienceCanManageRoster}')::boolean, true) or auth.uid() = v_event.owner_id) then
    raise exception 'Only the event operator can change the participant list.';
  end if;
  -- Weights change the odds of winning, and keeping duplicates multiplies entries: operator-only.
  if (p_weights is not null or p_keep_duplicates) and auth.uid() is distinct from v_event.owner_id then
    raise exception 'Only the event operator can import participant weights or keep duplicate names.';
  end if;
  if v_event.is_drawing then
    raise exception 'Wait until the current draw has finished before importing participants.';
  end if;

  v_data := v_event.data;
  if pg_catalog.jsonb_typeof(v_data -> 'participants') <> 'array' then
    raise exception 'The shared event participant list is invalid.';
  end if;

  if p_action = 'append' then
    v_existing := v_data -> 'participants';
  else
    v_existing := '[]'::jsonb;
  end if;

  -- One set-based query (fast for thousands of names): number the input rows, drop repeats within the file
  -- and names already on the list (unless duplicates are kept), then build the new participant objects.
  with input as (
    select s.i as ordinal, pg_catalog.btrim(p_names[s.i]) as person_name, v_weights[s.i] as person_weight
    from pg_catalog.generate_series(1, pg_catalog.cardinality(p_names)) as s(i)
  ), ranked as (
    select input.ordinal, input.person_name, input.person_weight,
           pg_catalog.lower(input.person_name) as name_key,
           pg_catalog.row_number() over (partition by pg_catalog.lower(input.person_name) order by input.ordinal) as repeat_number
    from input
  ), existing as (
    select pg_catalog.lower(pg_catalog.btrim(e.value ->> 'name')) as name_key
    from pg_catalog.jsonb_array_elements(v_existing) as e(value)
  )
  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'id', pg_catalog.gen_random_uuid()::text,
        'name', r.person_name,
        'weight', r.person_weight
      ) order by r.ordinal
    ),
    '[]'::jsonb
  )
  into v_new
  from ranked as r
  where p_keep_duplicates
    or (r.repeat_number = 1 and not exists (select 1 from existing as x where x.name_key = r.name_key));

  v_participants := v_existing || v_new;
  if pg_catalog.jsonb_array_length(v_participants) > 20000 then
    raise exception 'A lottery event can hold at most 20000 participants.';
  end if;

  v_data := pg_catalog.jsonb_set(v_data, '{participants}', v_participants, true);

  -- The after-update trigger disarms the one-time pick if its participant is no longer in the roster.
  update public.lottery_events set data = v_data where id = p_event_id;

  return v_data;
end;
$$;

-- ---------------------------------------------------------------------------------------------------
-- 7. manage_lottery_participants  (add | remove | deduplicate | clear)
-- ---------------------------------------------------------------------------------------------------

create or replace function public.manage_lottery_participants(
  p_event_id uuid,
  p_action text,
  p_participant_id text,
  p_name text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event public.lottery_events%rowtype;
  v_data jsonb;
  v_participants jsonb;
  v_name text;
begin
  if p_action is null or p_action not in ('add', 'remove', 'deduplicate', 'clear') then
    raise exception 'Choose a valid participant management action.';
  end if;
  if p_action = 'add' and (
    p_name is null
    or pg_catalog.char_length(pg_catalog.btrim(p_name)) = 0
    or pg_catalog.char_length(pg_catalog.btrim(p_name)) > 100
  ) then
    raise exception 'Participant names must contain 1 to 100 non-space characters.';
  end if;
  if p_action = 'remove' and (p_participant_id is null or p_participant_id = '') then
    raise exception 'Choose a participant to remove.';
  end if;

  select * into v_event from public.lottery_events where id = p_event_id for update;
  if not found then
    raise exception 'Lottery event not found.';
  end if;
  if not (coalesce((v_event.data #>> '{settings,audienceCanManageRoster}')::boolean, true) or auth.uid() = v_event.owner_id) then
    raise exception 'Only the event operator can change the participant list.';
  end if;
  if v_event.is_drawing then
    raise exception 'Wait until the current draw has finished before managing participants.';
  end if;

  v_data := v_event.data;
  if pg_catalog.jsonb_typeof(v_data -> 'participants') <> 'array' then
    raise exception 'The shared event participant list is invalid.';
  end if;
  v_participants := v_data -> 'participants';

  if p_action = 'add' then
    v_name := pg_catalog.btrim(p_name);
    if exists (
      select 1
      from pg_catalog.jsonb_array_elements(v_participants) as participant(value)
      where pg_catalog.lower(pg_catalog.btrim(participant.value ->> 'name')) = pg_catalog.lower(v_name)
    ) then
      raise exception 'That participant name is already in the draw.';
    end if;
    if pg_catalog.jsonb_array_length(v_participants) >= 20000 then
      raise exception 'A lottery event can hold at most 20000 participants.';
    end if;
    v_participants := v_participants || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'id', pg_catalog.gen_random_uuid()::text,
        'name', v_name,
        'weight', 1
      )
    );
  elsif p_action = 'remove' then
    if not exists (
      select 1
      from pg_catalog.jsonb_array_elements(v_participants) as participant(value)
      where participant.value ->> 'id' = p_participant_id
    ) then
      raise exception 'That participant is no longer in the draw.';
    end if;
    select coalesce(pg_catalog.jsonb_agg(participant.value order by participant.ordinality), '[]'::jsonb)
    into v_participants
    from pg_catalog.jsonb_array_elements(v_participants) with ordinality as participant(value, ordinality)
    where participant.value ->> 'id' <> p_participant_id;
  elsif p_action = 'clear' then
    v_participants := '[]'::jsonb;
  else
    -- deduplicate: keep the first entry of every name (case-insensitive), in the original order
    select coalesce(
      pg_catalog.jsonb_agg(pg_catalog.jsonb_set(t.value, '{name}', pg_catalog.to_jsonb(pg_catalog.btrim(t.value ->> 'name')), true) order by t.ordinality),
      '[]'::jsonb
    )
    into v_participants
    from (
      select p.value, p.ordinality,
             pg_catalog.row_number() over (partition by pg_catalog.lower(pg_catalog.btrim(p.value ->> 'name')) order by p.ordinality) as repeat_number
      from pg_catalog.jsonb_array_elements(v_data -> 'participants') with ordinality as p(value, ordinality)
    ) as t
    where t.repeat_number = 1;
  end if;

  v_data := pg_catalog.jsonb_set(v_data, '{participants}', v_participants, true);
  update public.lottery_events set data = v_data where id = p_event_id;

  return v_data;
end;
$$;

-- ---------------------------------------------------------------------------------------------------
-- 8. Operator-only functions: predetermined winner and cancelling a stuck draw
-- ---------------------------------------------------------------------------------------------------

create or replace function public.set_lottery_override(p_event_id uuid, p_participant_id text, p_armed boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event public.lottery_events%rowtype;
  v_armed boolean := coalesce(p_armed, false);
begin
  select * into v_event from public.lottery_events where id = p_event_id for update;
  if not found then
    raise exception 'Lottery event not found.';
  end if;
  if auth.uid() is null or auth.uid() <> v_event.owner_id then
    raise exception 'Only the event owner can set the predetermined winner.';
  end if;
  if v_event.is_drawing then
    raise exception 'Wait until the current draw has finished.';
  end if;
  if p_participant_id is not null and not exists (
    select 1
    from pg_catalog.jsonb_array_elements(v_event.data -> 'participants') as p(value)
    where p.value ->> 'id' = p_participant_id
  ) then
    raise exception 'That participant is not in the draw.';
  end if;
  if v_armed and p_participant_id is null then
    raise exception 'Choose a participant before arming the one-time pick.';
  end if;

  insert into public.lottery_event_secrets (event_id, override_participant_id, override_armed, updated_at)
  values (p_event_id, p_participant_id, v_armed, pg_catalog.now())
  on conflict (event_id) do update
    set override_participant_id = excluded.override_participant_id,
        override_armed = excluded.override_armed,
        updated_at = excluded.updated_at;

  return pg_catalog.jsonb_build_object('overrideParticipantId', p_participant_id, 'overrideActivated', v_armed);
end;
$$;

create or replace function public.cancel_lottery_draw(p_event_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event public.lottery_events%rowtype;
begin
  select * into v_event from public.lottery_events where id = p_event_id for update;
  if not found then
    raise exception 'Lottery event not found.';
  end if;
  if auth.uid() is null or auth.uid() <> v_event.owner_id then
    raise exception 'Only the event owner can cancel a draw.';
  end if;

  update public.lottery_draws set status = 'cancelled' where event_id = p_event_id and status = 'pending';
  update public.lottery_events
  set is_drawing = false, draw_started_at = null, draw_duration_ms = null
  where id = p_event_id;

  return pg_catalog.jsonb_build_object('cancelled', true);
end;
$$;

-- ---------------------------------------------------------------------------------------------------
-- 9. Function permissions
-- ---------------------------------------------------------------------------------------------------

revoke all on function public.begin_lottery_draw(uuid) from public;
revoke all on function public.finish_lottery_draw(uuid, uuid) from public;
revoke all on function public.import_lottery_participants(uuid, text[], text, boolean, numeric[]) from public;
revoke all on function public.manage_lottery_participants(uuid, text, text, text) from public;
revoke all on function public.set_lottery_override(uuid, text, boolean) from public;
revoke all on function public.cancel_lottery_draw(uuid) from public;

-- Audience screens may draw and manage the roster unless the operator disables it in Settings; the
-- functions enforce that setting and all validation themselves.
grant execute on function public.begin_lottery_draw(uuid) to anon, authenticated;
grant execute on function public.finish_lottery_draw(uuid, uuid) to anon, authenticated;
grant execute on function public.import_lottery_participants(uuid, text[], text, boolean, numeric[]) to anon, authenticated;
grant execute on function public.manage_lottery_participants(uuid, text, text, text) to anon, authenticated;

-- Operator-only: signed-in users only (and each function additionally checks event ownership).
grant execute on function public.set_lottery_override(uuid, text, boolean) to authenticated;
grant execute on function public.cancel_lottery_draw(uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------------
-- 10. Realtime (own subscription on this project only)
-- ---------------------------------------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'lottery_events'
  ) then
    alter publication supabase_realtime add table public.lottery_events;
  end if;
end
$$;

notify pgrst, 'reload schema';
