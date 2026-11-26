-- 냉큼: 6자리 초대 번호 (7일) + 초대장 미리보기
-- Supabase 대시보드 > SQL Editor 에 이 파일 전체를 붙여 넣고 Run 하면 돼요.
-- 기존 테이블은 건드리지 않고, 새 테이블 1개와 함수 3개만 추가해요.
-- 실행하기 전에도 앱은 예전 초대 코드로 동작하고, 실행하면 6자리 번호로 바뀌어요.

create extension if not exists pgcrypto;

create table if not exists public.household_short_invites (
  code text primary key,
  household_id uuid not null references public.households(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '7 days')
);
create index if not exists household_short_invites_household_idx
  on public.household_short_invites(household_id, expires_at desc);

-- 함수로만 읽고 쓰도록 직접 접근은 막아요.
alter table public.household_short_invites enable row level security;

-- 헷갈리는 0·O·1·I·L을 뺀 31글자로 6자리 번호를 만들어요.
create or replace function public.nk_random_code()
returns text language plpgsql volatile set search_path = public as $$
declare
  alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  result text := '';
  -- Supabase는 pgcrypto를 extensions 스키마에 두므로 기본 내장 gen_random_uuid()로 무작위 바이트를 만들어요.
  b bytea := decode(replace(gen_random_uuid()::text, '-', ''), 'hex');
  i int;
begin
  for i in 0..5 loop
    result := result || substr(alphabet, (get_byte(b, i) % 31) + 1, 1);
  end loop;
  return result;
end; $$;

-- 초대 번호 만들기 (아직 유효한 번호가 있으면 그 번호를 다시 줘요)
create or replace function public.create_invite(p_household_id uuid default null)
returns json language plpgsql security definer set search_path = public as $$
declare
  hid uuid := p_household_id;
  inv public.household_short_invites%rowtype;
  new_code text;
  tries int := 0;
begin
  if auth.uid() is null then raise exception 'LOGIN_REQUIRED'; end if;

  if hid is null then
    select household_id into hid from public.household_members where user_id = auth.uid() limit 1;
  end if;
  if hid is null or not exists (
    select 1 from public.household_members where household_id = hid and user_id = auth.uid()
  ) then
    raise exception 'NOT_A_MEMBER';
  end if;

  select * into inv from public.household_short_invites
   where household_id = hid and expires_at > now() + interval '1 day'
   order by expires_at desc limit 1;
  if inv.code is not null then
    return json_build_object('code', inv.code, 'expires_at', inv.expires_at);
  end if;

  loop
    tries := tries + 1;
    new_code := public.nk_random_code();
    begin
      insert into public.household_short_invites(code, household_id, created_by)
      values (new_code, hid, auth.uid())
      returning * into inv;
      exit;
    exception when unique_violation then
      if tries > 10 then raise; end if;
    end;
  end loop;

  return json_build_object('code', inv.code, 'expires_at', inv.expires_at);
end; $$;

-- 초대장 미리보기: 로그인 전에도 "기호님이 초대했어요"를 보여주기 위해 이름·인원만 돌려줘요.
create or replace function public.peek_invite(p_code text)
returns json language plpgsql stable security definer set search_path = public as $$
declare
  c text := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
  inv public.household_short_invites%rowtype;
  hname text;
  inviter text;
  members int;
begin
  select * into inv from public.household_short_invites where code = c;
  if inv.code is null then
    return json_build_object('status', 'invalid');
  end if;

  select name into hname from public.households where id = inv.household_id;
  select nullif(trim(raw_user_meta_data->>'name'), '') into inviter from auth.users where id = inv.created_by;
  select count(*) into members from public.household_members where household_id = inv.household_id;

  return json_build_object(
    'status', case when inv.expires_at > now() then 'ok' else 'expired' end,
    'household_id', inv.household_id,
    'household_name', hname,
    'inviter_name', inviter,
    'member_count', members,
    'expires_at', inv.expires_at
  );
end; $$;

-- 초대 번호로 가족 냉장고 들어가기 (7일 동안 여러 가족이 같은 번호로 들어올 수 있어요)
create or replace function public.join_with_invite(p_code text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  c text := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
  inv public.household_short_invites%rowtype;
begin
  if auth.uid() is null then raise exception 'LOGIN_REQUIRED'; end if;

  select * into inv from public.household_short_invites where code = c;
  if inv.code is null then raise exception 'INVITE_INVALID'; end if;
  if inv.expires_at <= now() then raise exception 'INVITE_EXPIRED'; end if;

  if not exists (
    select 1 from public.household_members where household_id = inv.household_id and user_id = auth.uid()
  ) then
    insert into public.household_members(household_id, user_id) values (inv.household_id, auth.uid());
  end if;

  return inv.household_id;
end; $$;

revoke all on function public.nk_random_code() from public;
revoke all on function public.create_invite(uuid) from public;
revoke all on function public.peek_invite(text) from public;
revoke all on function public.join_with_invite(text) from public;
grant execute on function public.create_invite(uuid) to authenticated;
grant execute on function public.peek_invite(text) to anon, authenticated;
grant execute on function public.join_with_invite(text) to authenticated;
