-- ============================================================
-- PASO A PASO · Esquema de base de datos (Supabase / Postgres)
-- ============================================================
-- Revísalo completo antes de ejecutarlo en el SQL Editor de Supabase.
-- No incluye nada de pagos/suscripciones todavía.
-- ============================================================


-- ------------------------------------------------------------
-- Utilidad: columna updated_at que se actualiza sola
-- ------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;


-- ============================================================
-- 1) profiles
--    Un renglón por usuario (1:1 con auth.users).
--    role / plan / subscription_status viven aquí pero están
--    protegidos: el cliente NUNCA puede cambiarlos directamente
--    (ver el trigger protect_account_fields más abajo).
-- ============================================================
create table if not exists public.profiles (
  id                  uuid primary key references auth.users(id) on delete cascade,
  display_name        text,
  role                text not null default 'user'    check (role in ('user','admin')),
  plan                text not null default 'free'    check (plan in ('free','plus')),
  subscription_status text not null default 'inactive' check (subscription_status in ('active','inactive')),
  age                 smallint,
  height_cm           numeric(5,2),
  weight_kg           numeric(6,2),
  activity_level      text,
  goal                text,
  pace                text,
  onboarding_completed boolean not null default false,
  onboarding_completed_at timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- Migración compatible con instalaciones existentes; ejecutar en el SQL Editor.
alter table public.profiles
  add column if not exists age smallint,
  add column if not exists height_cm numeric(5,2),
  add column if not exists weight_kg numeric(6,2),
  add column if not exists activity_level text,
  add column if not exists goal text,
  add column if not exists pace text,
  add column if not exists onboarding_completed boolean not null default false,
  add column if not exists onboarding_completed_at timestamptz;

alter table public.profiles enable row level security;

drop trigger if exists set_updated_at on public.profiles;
create trigger set_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();

-- Crea automáticamente el perfil cuando alguien se registra
-- (el cliente nunca hace INSERT en profiles directamente).
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name, role, plan, subscription_status)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)),
    'user', 'free', 'inactive'
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

-- Protege role / plan / subscription_status: si la actualización
-- no viene del service_role (backend/admin), esos tres campos
-- se quedan como estaban, sin importar qué mande el cliente.
create or replace function public.protect_account_fields()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' then
    new.role := old.role;
    new.plan := old.plan;
    new.subscription_status := old.subscription_status;
  end if;
  return new;
end;
$$;

drop trigger if exists protect_account_fields on public.profiles;
create trigger protect_account_fields
before update on public.profiles
for each row execute function public.protect_account_fields();

-- Helper para políticas de administrador (evita recursión de RLS).
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles where id = auth.uid() and role = 'admin'
  );
$$;

-- Políticas: cada usuario ve y edita solo su propio perfil.
-- (No hay política de INSERT/DELETE para el cliente: el perfil
-- se crea solo vía el trigger de arriba.)
drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own"
on public.profiles for select
using (id = auth.uid());

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own"
on public.profiles for update
using (id = auth.uid())
with check (id = auth.uid());

-- Preparado para el futuro panel de administración.
drop policy if exists "profiles_select_admin" on public.profiles;
create policy "profiles_select_admin"
on public.profiles for select
using (public.is_admin());


-- ============================================================
-- 2) habit_profiles
--    Uno o varios perfiles de HÁBITOS por usuario.
--    "data" guarda tu objeto "activities" (lunes..domingo) tal
--    cual ya lo usa la app, sin rediseñar su forma.
-- ============================================================
create table if not exists public.habit_profiles (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  name       text not null,
  active     boolean not null default false,
  data       jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists habit_profiles_user_id_idx on public.habit_profiles(user_id);

-- Como máximo un perfil de hábitos activo por usuario, a nivel de base de datos.
create unique index if not exists habit_profiles_one_active_per_user
on public.habit_profiles(user_id) where active;

alter table public.habit_profiles enable row level security;

drop trigger if exists set_updated_at on public.habit_profiles;
create trigger set_updated_at
before update on public.habit_profiles
for each row execute function public.set_updated_at();

drop policy if exists "habit_profiles_all_own" on public.habit_profiles;
create policy "habit_profiles_all_own"
on public.habit_profiles for all
using (user_id = auth.uid())
with check (user_id = auth.uid());


-- ============================================================
-- 3) exercise_profiles
--    Uno o varios perfiles de EJERCICIO/GYM por usuario.
--    "data" guarda tu objeto "workouts" tal cual ya lo usa la app.
--    Totalmente independiente de habit_profiles.
-- ============================================================
create table if not exists public.exercise_profiles (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  name       text not null,
  active     boolean not null default false,
  data       jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists exercise_profiles_user_id_idx on public.exercise_profiles(user_id);

create unique index if not exists exercise_profiles_one_active_per_user
on public.exercise_profiles(user_id) where active;

alter table public.exercise_profiles enable row level security;

drop trigger if exists set_updated_at on public.exercise_profiles;
create trigger set_updated_at
before update on public.exercise_profiles
for each row execute function public.set_updated_at();

drop policy if exists "exercise_profiles_all_own" on public.exercise_profiles;
create policy "exercise_profiles_all_own"
on public.exercise_profiles for all
using (user_id = auth.uid())
with check (user_id = auth.uid());


-- ============================================================
-- 4) progress
--    Un renglón por usuario y por fecha.
--    "data" guarda tu objeto { activities: {...}, series: {...} }
--    tal cual lo usa hoy data.progress[fecha] en la app.
-- ============================================================
create table if not exists public.progress (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  date       date not null,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  unique (user_id, date)
);

create index if not exists progress_user_id_idx on public.progress(user_id);
create index if not exists progress_user_date_idx on public.progress(user_id, date);

alter table public.progress enable row level security;

drop trigger if exists set_updated_at on public.progress;
create trigger set_updated_at
before update on public.progress
for each row execute function public.set_updated_at();

drop policy if exists "progress_all_own" on public.progress;
create policy "progress_all_own"
on public.progress for all
using (user_id = auth.uid())
with check (user_id = auth.uid());


-- ============================================================
-- Fin. No se tocó nada de pagos/suscripciones todavía.
-- Cuando llegue ese momento: se agregan columnas (p. ej.
-- stripe_customer_id) y una función con service_role que
-- actualice plan/subscription_status desde un webhook — sin
-- tener que rediseñar ninguna de estas tablas.
-- ============================================================
