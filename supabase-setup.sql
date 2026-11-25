-- 나의 저장고: Supabase SQL Editor에서 전체 실행
-- 기본 설계: 사용자별 계정 + 가족 공간 + 초대 코드 + 공유 상태(JSON)
create extension if not exists pgcrypto;

create table if not exists public.households (
  id uuid primary key default gen_random_uuid(),
  name text not null default '우리 집 냉장고',
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.household_members (
  household_id uuid not null references public.households(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner','member')),
  joined_at timestamptz not null default now(),
  primary key (household_id, user_id)
);

create table if not exists public.household_invites (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  code_hash text not null unique,
  created_by uuid not null references auth.users(id) on delete cascade,
  expires_at timestamptz not null default (now() + interval '7 days'),
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.household_app_state (
  household_id uuid primary key references public.households(id) on delete cascade,
  inventory jsonb not null default '[]'::jsonb,
  shopping jsonb not null default '[]'::jsonb,
  meal_plan jsonb not null default '{}'::jsonb,
  household_name text not null default '우리 집 냉장고',
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now()
);

alter table public.households enable row level security;
alter table public.household_members enable row level security;
alter table public.household_invites enable row level security;
alter table public.household_app_state enable row level security;

-- RLS 정책 안에서 household_members를 직접 조회하면 정책 재귀가 발생할 수 있어
-- SECURITY DEFINER 함수로 멤버십을 확인합니다.
create or replace function public.is_household_member(target_household_id uuid)
returns boolean language sql stable security definer set search_path=public as $$
  select exists (
    select 1 from public.household_members
    where household_id=target_household_id and user_id=auth.uid()
  );
$$;
revoke all on function public.is_household_member(uuid) from public;
grant execute on function public.is_household_member(uuid) to authenticated;

drop policy if exists "members can view their households" on public.households;
create policy "members can view their households" on public.households
for select to authenticated using (public.is_household_member(id));

drop policy if exists "members can view membership" on public.household_members;
create policy "members can view membership" on public.household_members
for select to authenticated using (public.is_household_member(household_id));

drop policy if exists "members can read shared state" on public.household_app_state;
create policy "members can read shared state" on public.household_app_state
for select to authenticated using (public.is_household_member(household_id));
drop policy if exists "members can insert shared state" on public.household_app_state;
create policy "members can insert shared state" on public.household_app_state
for insert to authenticated with check (public.is_household_member(household_id));
drop policy if exists "members can update shared state" on public.household_app_state;
create policy "members can update shared state" on public.household_app_state
for update to authenticated using (public.is_household_member(household_id))
with check (public.is_household_member(household_id));

create or replace function public.create_family_storage(family_name text)
returns uuid language plpgsql security definer set search_path=public as $$
declare new_id uuid;
begin
  if auth.uid() is null then raise exception '로그인이 필요합니다.'; end if;
  insert into public.households(name, created_by) values (coalesce(nullif(trim(family_name),''),'우리 집 냉장고'), auth.uid()) returning id into new_id;
  insert into public.household_members(household_id,user_id,role) values(new_id,auth.uid(),'owner');
  insert into public.household_app_state(household_id,household_name,updated_by) values(new_id,coalesce(nullif(trim(family_name),''),'우리 집 냉장고'),auth.uid());
  return new_id;
end; $$;

create or replace function public.create_family_invite()
returns text language plpgsql security definer set search_path=public as $$
declare hid uuid; raw_code text;
begin
  select household_id into hid from public.household_members where user_id=auth.uid() order by joined_at limit 1;
  if hid is null then raise exception '먼저 가족 공간을 만들어 주세요.'; end if;
  raw_code := upper(encode(gen_random_bytes(6),'hex'));
  insert into public.household_invites(household_id,code_hash,created_by,expires_at)
  values(hid, encode(digest(raw_code,'sha256'),'hex'), auth.uid(), now()+interval '7 days');
  return raw_code;
end; $$;

create or replace function public.join_family_storage(invite_code text)
returns uuid language plpgsql security definer set search_path=public as $$
declare inv public.household_invites%rowtype;
begin
  if auth.uid() is null then raise exception '로그인이 필요합니다.'; end if;
  select * into inv from public.household_invites
  where code_hash=encode(digest(upper(trim(invite_code)),'sha256'),'hex')
    and used_at is null and expires_at>now()
  for update;
  if inv.id is null then raise exception '초대 코드가 올바르지 않거나 만료됐습니다.'; end if;
  insert into public.household_members(household_id,user_id,role)
  values(inv.household_id,auth.uid(),'member')
  on conflict(household_id,user_id) do nothing;
  update public.household_invites set used_at=now() where id=inv.id;
  return inv.household_id;
end; $$;

revoke all on function public.create_family_storage(text) from public;
revoke all on function public.create_family_invite() from public;
revoke all on function public.join_family_storage(text) from public;
grant execute on function public.create_family_storage(text) to authenticated;
grant execute on function public.create_family_invite() to authenticated;
grant execute on function public.join_family_storage(text) to authenticated;

-- Realtime에서 변경사항을 받도록 테이블을 publication에 추가
do $$ begin
  alter publication supabase_realtime add table public.household_app_state;
exception when duplicate_object then null;
when undefined_object then null;
end $$;
