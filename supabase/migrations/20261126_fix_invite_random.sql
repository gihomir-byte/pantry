-- 냉큼: 초대 번호를 만들지 못하던 문제 고치기
-- 원인: gen_random_bytes(pgcrypto)가 Supabase에서는 extensions 스키마에 있어서 함수 안에서 찾지 못했어요.
-- Supabase 대시보드 > SQL Editor 에 이 파일 전체를 붙여 넣고 Run 하면 돼요. 데이터는 바뀌지 않아요.

create or replace function public.nk_random_code()
returns text language plpgsql volatile set search_path = public as $$
declare
  alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  result text := '';
  b bytea := decode(replace(gen_random_uuid()::text, '-', ''), 'hex');
  i int;
begin
  for i in 0..5 loop
    result := result || substr(alphabet, (get_byte(b, i) % 31) + 1, 1);
  end loop;
  return result;
end; $$;

revoke all on function public.nk_random_code() from public;
