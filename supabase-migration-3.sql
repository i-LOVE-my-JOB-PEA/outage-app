-- รันใน Supabase > SQL Editor (ครั้งเดียว) เพิ่มฟังก์ชันวางแผนงานซ่อม
alter table outages add column if not exists planned_at timestamptz;
alter table outages add column if not exists priority text not null default 'normal';
alter table outages add column if not exists plan_note text not null default '';

create index if not exists outages_planned_idx on outages (planned_at) where status <> 'resolved';
