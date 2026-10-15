-- รันใน Supabase > SQL Editor (ครั้งเดียว)
create table outages (
  id bigint generated always as identity primary key,
  code text unique not null,
  type text not null,
  description text not null default '',
  address text not null,
  lat double precision not null,
  lng double precision not null,
  reporter_name text not null default '',
  reporter_phone text not null default '',
  status text not null default 'pending',
  crew text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  history jsonb not null default '[]'
);

-- เปิด RLS และไม่สร้าง policy = เข้าถึงได้เฉพาะผ่าน service key ของเซิร์ฟเวอร์เท่านั้น
alter table outages enable row level security;
