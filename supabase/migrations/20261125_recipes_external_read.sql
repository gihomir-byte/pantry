-- 앱(로그인 전·후 모두)이 공개된 레시피를 읽을 수 있게 해요.
-- 쓰기 권한은 주지 않아요. 레시피 넣기는 service_role(관리자)로만 해요.
grant select on table public.recipes_external to anon, authenticated;

alter table public.recipes_external enable row level security;

drop policy if exists "공개 레시피는 누구나 읽기" on public.recipes_external;
create policy "공개 레시피는 누구나 읽기"
  on public.recipes_external
  for select
  to anon, authenticated
  using (is_published = true);
