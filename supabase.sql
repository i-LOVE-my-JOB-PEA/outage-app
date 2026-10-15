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
  history jsonb not null default '[]',
  cause text not null default '',
  materials text not null default '',
  started_at timestamptz,
  resolved_at timestamptz,
  duplicate_of bigint,
  ip_hash text not null default '',
  consent boolean not null default false,
  planned_at timestamptz,
  priority text not null default 'normal',
  plan_note text not null default ''
);
create index outages_status_created_idx on outages (status, created_at desc);
create index outages_ip_created_idx on outages (ip_hash, created_at desc);

-- เปิด RLS และไม่สร้าง policy = เข้าถึงได้เฉพาะผ่าน service key ของเซิร์ฟเวอร์เท่านั้น
alter table outages enable row level security;
