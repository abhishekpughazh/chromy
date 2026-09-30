-- 1. Create a table to store user roles
create table if not exists public.user_roles (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users(id) on delete cascade not null unique,
  email text,
  username text,
  role text not null check (role in ('SUPER ADMIN', 'ADMIN', 'USER')),
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Add email and username columns if the table already existed
alter table public.user_roles add column if not exists email text;
alter table public.user_roles add column if not exists username text;

-- Enable RLS on user_roles
alter table public.user_roles enable row level security;

-- Policies for user_roles
drop policy if exists "Users can view their own role" on public.user_roles;
create policy "Users can view their own role"
  on public.user_roles for select
  using ( auth.uid() = user_id );

-- REMOVED: "Super Admins can view all roles" to prevent infinite recursion
drop policy if exists "Super Admins can view all roles" on public.user_roles;

-- Function to automatically assign 'USER' role to new signups
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.user_roles (user_id, role, email, username)
  values (
    new.id, 
    'USER', 
    new.email, 
    new.raw_user_meta_data->>'username'
  );
  return new;
end;
$$ language plpgsql security definer;

-- Trigger for new signups
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- 2. Create a table to store the user's samples and annotations
create table if not exists public.samples (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users(id) on delete cascade not null,
  original_url text not null,
  xml text,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Add uploader_email column if the table already existed
alter table public.samples add column if not exists uploader_email text;

-- Add karyotype column (ISCN karyotype designation entered at upload time) if the table already existed
alter table public.samples add column if not exists karyotype text;

-- Explicit reversible complete flag; never stored in annotation XML (XML is rebuilt on every stroke save)
alter table public.samples add column if not exists annotation_complete boolean not null default false;

-- 2b. Create buckets table for grouping metaphase spreads
create table if not exists public.buckets (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users(id) on delete cascade not null,
  bucket_number integer not null,
  name text not null,
  description text not null,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  unique (user_id, bucket_number)
);

alter table public.buckets enable row level security;

drop policy if exists "Users can view their own buckets and Super Admins can view all" on public.buckets;
drop policy if exists "Users can insert their own buckets" on public.buckets;
drop policy if exists "Users can update their own buckets" on public.buckets;
drop policy if exists "Users can delete their own buckets" on public.buckets;
drop policy if exists "Admins can view all buckets" on public.buckets;
drop policy if exists "Only Super Admins can create buckets" on public.buckets;
drop policy if exists "Only Super Admins can update buckets" on public.buckets;
drop policy if exists "Only Super Admins can delete buckets" on public.buckets;

create policy "Admins can view all buckets"
  on public.buckets for select
  using (
    exists (
      select 1 from public.user_roles
      where user_roles.user_id = auth.uid()
      and user_roles.role in ('SUPER ADMIN', 'ADMIN')
    )
  );

create policy "Only Super Admins can create buckets"
  on public.buckets for insert
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.user_roles
      where user_roles.user_id = auth.uid()
      and user_roles.role = 'SUPER ADMIN'
    )
  );

create policy "Only Super Admins can update buckets"
  on public.buckets for update
  using (
    exists (
      select 1 from public.user_roles
      where user_roles.user_id = auth.uid()
      and user_roles.role = 'SUPER ADMIN'
    )
  )
  with check (
    exists (
      select 1 from public.user_roles
      where user_roles.user_id = auth.uid()
      and user_roles.role = 'SUPER ADMIN'
    )
  );

create policy "Only Super Admins can delete buckets"
  on public.buckets for delete
  using (
    exists (
      select 1 from public.user_roles
      where user_roles.user_id = auth.uid()
      and user_roles.role = 'SUPER ADMIN'
    )
  );

-- Pair sentences shared by every metaphase spread in a bucket.
-- Kept off the buckets table so admins can edit them without renaming buckets.
create table if not exists public.bucket_pair_descriptions (
  id uuid default gen_random_uuid() primary key,
  bucket_id uuid references public.buckets(id) on delete cascade not null,
  pair_id text not null,
  description text not null,
  unique (bucket_id, pair_id)
);

alter table public.bucket_pair_descriptions enable row level security;

drop policy if exists "Authenticated users can view bucket pair descriptions" on public.bucket_pair_descriptions;
drop policy if exists "Admins can insert bucket pair descriptions" on public.bucket_pair_descriptions;
drop policy if exists "Admins can update bucket pair descriptions" on public.bucket_pair_descriptions;
drop policy if exists "Admins can delete bucket pair descriptions" on public.bucket_pair_descriptions;

create policy "Authenticated users can view bucket pair descriptions"
  on public.bucket_pair_descriptions for select
  to authenticated
  using ( true );

create policy "Admins can insert bucket pair descriptions"
  on public.bucket_pair_descriptions for insert
  to authenticated
  with check (
    exists (
      select 1 from public.user_roles
      where user_roles.user_id = auth.uid()
      and user_roles.role in ('SUPER ADMIN', 'ADMIN')
    )
  );

create policy "Admins can update bucket pair descriptions"
  on public.bucket_pair_descriptions for update
  to authenticated
  using (
    exists (
      select 1 from public.user_roles
      where user_roles.user_id = auth.uid()
      and user_roles.role in ('SUPER ADMIN', 'ADMIN')
    )
  )
  with check (
    exists (
      select 1 from public.user_roles
      where user_roles.user_id = auth.uid()
      and user_roles.role in ('SUPER ADMIN', 'ADMIN')
    )
  );

create policy "Admins can delete bucket pair descriptions"
  on public.bucket_pair_descriptions for delete
  to authenticated
  using (
    exists (
      select 1 from public.user_roles
      where user_roles.user_id = auth.uid()
      and user_roles.role in ('SUPER ADMIN', 'ADMIN')
    )
  );

-- Link samples to buckets (replaces legacy level column)
alter table public.samples add column if not exists bucket_id uuid references public.buckets(id) on delete set null;
alter table public.samples drop column if exists level;

-- Sentences edited on one metaphase spread. Absent keys inherit the bucket description.
alter table public.samples add column if not exists pair_note_overrides jsonb not null default '{}'::jsonb;

-- Annotator-assigned difficulty of this metaphase spread. Null until rated.
-- Separate from karyotype_progress.level, which stores the learner game step.
alter table public.samples add column if not exists difficulty text;
alter table public.samples drop constraint if exists samples_difficulty_check;
alter table public.samples add constraint samples_difficulty_check
  check (difficulty is null or difficulty in ('easy', 'moderate', 'hard'));

-- 3. Enable Row Level Security (RLS) on the samples table
alter table public.samples enable row level security;

-- 4. Create RLS policies for the samples table
drop policy if exists "Users can view their own samples" on public.samples;
drop policy if exists "Users can view their own samples and Super Admins can view all" on public.samples;
drop policy if exists "Users can view their own samples and Admins can view all" on public.samples;
drop policy if exists "Users can insert their own samples" on public.samples;
drop policy if exists "Users can update their own samples" on public.samples;
drop policy if exists "Users can delete their own samples" on public.samples;

-- Select: every signed-in user can open the shared metaphase library.
-- Writes stay limited to the owner and admins.
drop policy if exists "Users can view their own samples and Admins can view all" on public.samples;
drop policy if exists "Authenticated users can view samples" on public.samples;
create policy "Authenticated users can view samples"
  on public.samples for select
  to authenticated
  using ( true );

-- Insert: Only the owner can create samples
create policy "Users can insert their own samples"
  on public.samples for insert
  with check ( auth.uid() = user_id );

-- Update: Owner can update their own, ADMIN and SUPER ADMIN can update any
drop policy if exists "Admins can update all samples" on public.samples;
create policy "Users can update their own samples"
  on public.samples for update
  using ( auth.uid() = user_id )
  with check ( auth.uid() = user_id );

create policy "Admins can update all samples"
  on public.samples for update
  using (
    exists (
      select 1 from public.user_roles
      where user_roles.user_id = auth.uid()
      and user_roles.role in ('SUPER ADMIN', 'ADMIN')
    )
  )
  with check (
    exists (
      select 1 from public.user_roles
      where user_roles.user_id = auth.uid()
      and user_roles.role in ('SUPER ADMIN', 'ADMIN')
    )
  );

-- Delete: owner, or ADMIN / SUPER ADMIN curating the dataset
create policy "Users can delete their own samples"
  on public.samples for delete
  using ( auth.uid() = user_id );

drop policy if exists "Admins can delete all samples" on public.samples;
create policy "Admins can delete all samples"
  on public.samples for delete
  using (
    exists (
      select 1 from public.user_roles
      where user_roles.user_id = auth.uid()
      and user_roles.role in ('SUPER ADMIN', 'ADMIN')
    )
  );

-- 5. Create a storage bucket for the uploaded images
insert into storage.buckets (id, name, public) 
values ('images', 'images', true)
on conflict (id) do nothing; -- Prevent error if already exists

-- 6. Set up RLS policies for the Storage bucket
drop policy if exists "Anyone can view images" on storage.objects;
drop policy if exists "Users can upload images" on storage.objects;
drop policy if exists "Users can delete their own uploaded images" on storage.objects;
drop policy if exists "Admins can delete any images" on storage.objects;

create policy "Anyone can view images"
  on storage.objects for select
  using ( bucket_id = 'images' );

create policy "Users can upload images"
  on storage.objects for insert
  with check ( bucket_id = 'images' and auth.role() = 'authenticated' );

create policy "Users can delete their own uploaded images"
  on storage.objects for delete
  using ( bucket_id = 'images' and auth.uid() = owner );

create policy "Admins can delete any images"
  on storage.objects for delete
  using (
    bucket_id = 'images'
    and exists (
      select 1 from public.user_roles
      where user_roles.user_id = auth.uid()
      and user_roles.role in ('SUPER ADMIN', 'ADMIN')
    )
  );

-- 7. Persist each user's progress per sample and level.
-- Level 1 is Learn.
-- Level 2 is Match, shown as 2.1 (one chromosome of each pair is already placed).
-- Level 4 is Pair, shown as 2.2 (both chromosomes start in the tray, already oriented).
-- Level 3 is Arrange, shown as 2.3. Its stored id stays 3 so existing boards are unchanged.
-- Level 5 is Mate, shown as 3.1 (one chromosome of each pair is already numbered on the spread).
-- Level 6 is Label, shown as 3.2 (number every chromosome on the spread).
-- Rows created before Match existed were stored as level 2; a one-time
-- update below moves those Arrange boards to level 3.
create table if not exists public.karyotype_progress (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users(id) on delete cascade not null,
  sample_id uuid references public.samples(id) on delete cascade not null,
  level integer not null default 3,
  state jsonb not null default '{}'::jsonb,
  annotation_signature text not null,
  status text not null default 'in_progress'
    check (status in ('in_progress', 'complete')),
  correct_count integer not null default 0,
  total_count integer not null default 0,
  started_at timestamp with time zone default timezone('utc'::text, now()) not null,
  completed_at timestamp with time zone,
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null,
  constraint karyotype_progress_user_sample_level_key unique (user_id, sample_id, level)
);

create index if not exists karyotype_progress_user_id_idx
  on public.karyotype_progress (user_id);
create index if not exists karyotype_progress_sample_id_idx
  on public.karyotype_progress (sample_id);

-- Existing databases: add level and replace the one-row-per-sample unique key.
alter table public.karyotype_progress add column if not exists level integer not null default 3;
alter table public.karyotype_progress alter column level set default 3;
do $$
declare
  old_unique record;
begin
  for old_unique in
    select conname
    from pg_constraint
    where conrelid = 'public.karyotype_progress'::regclass
      and contype = 'u'
      and conname <> 'karyotype_progress_user_sample_level_key'
  loop
    execute format('alter table public.karyotype_progress drop constraint %I', old_unique.conname);
  end loop;

  if not exists (
    select 1 from pg_constraint
    where conname = 'karyotype_progress_user_sample_level_key'
  ) then
    alter table public.karyotype_progress
      add constraint karyotype_progress_user_sample_level_key unique (user_id, sample_id, level);
  end if;
end $$;

-- One-time: Arrange boards were saved as level 2 before Match existed.
-- The column comment records that the move already ran, so a later re-run
-- cannot move new Match progress from level 2 to level 3.
do $$
declare
  marker text;
begin
  select col_description('public.karyotype_progress'::regclass, attnum)
    into marker
  from pg_attribute
  where attrelid = 'public.karyotype_progress'::regclass
    and attname = 'level'
    and not attisdropped;

  if marker is distinct from 'legacy-arrange-moved-to-level-3' then
    update public.karyotype_progress set level = 3 where level = 2;
    comment on column public.karyotype_progress.level is 'legacy-arrange-moved-to-level-3';
  end if;
end $$;

alter table public.karyotype_progress enable row level security;

drop policy if exists "Users can view their own karyotype progress" on public.karyotype_progress;
drop policy if exists "Users can insert their own karyotype progress" on public.karyotype_progress;
drop policy if exists "Users can update their own karyotype progress" on public.karyotype_progress;
drop policy if exists "Users can delete their own karyotype progress" on public.karyotype_progress;

create policy "Users can view their own karyotype progress"
  on public.karyotype_progress for select
  using (auth.uid() = user_id);

create policy "Users can insert their own karyotype progress"
  on public.karyotype_progress for insert
  with check (auth.uid() = user_id);

create policy "Users can update their own karyotype progress"
  on public.karyotype_progress for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Users can delete their own karyotype progress"
  on public.karyotype_progress for delete
  using (auth.uid() = user_id);
