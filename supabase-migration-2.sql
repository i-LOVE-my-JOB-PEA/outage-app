-- รันใน Supabase > SQL Editor (ครั้งเดียว) สำหรับฐานข้อมูลที่สร้างจาก supabase.sql รุ่นแรกไปแล้ว
alter table outages add column if not exists cause text not null default '';
alter table outages add column if not exists materials text not null default '';
alter table outages add column if not exists started_at timestamptz;
alter table outages add column if not exists resolved_at timestamptz;
alter table outages add column if not exists duplicate_of bigint;
alter table outages add column if not exists ip_hash text not null default '';
alter table outages add column if not exists consent boolean not null default false;

-- ข้อมูลเดิมที่ปิดงานไปแล้ว: ใช้เวลาอัปเดตล่าสุดเป็นเวลาปิดงานโดยประมาณ
update outages set resolved_at = updated_at where status = 'resolved' and resolved_at is null;

create index if not exists outages_status_created_idx on outages (status, created_at desc);
create index if not exists outages_ip_created_idx on outages (ip_hash, created_at desc);
