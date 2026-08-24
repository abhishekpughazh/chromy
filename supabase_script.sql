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

-- Link samples to buckets (replaces legacy level column)
alter table public.samples add column if not exists bucket_id uuid references public.buckets(id) on delete set null;
alter table public.samples drop column if exists level;

-- 3. Enable Row Level Security (RLS) on the samples table
alter table public.samples enable row level security;

-- 4. Create RLS policies for the samples table
drop policy if exists "Users can view their own samples" on public.samples;
drop policy if exists "Users can view their own samples and Super Admins can view all" on public.samples;
drop policy if exists "Users can view their own samples and Admins can view all" on public.samples;
drop policy if exists "Users can insert their own samples" on public.samples;
drop policy if exists "Users can update their own samples" on public.samples;
drop policy if exists "Users can delete their own samples" on public.samples;

-- Select: Owner can view, ADMIN and SUPER ADMIN can view all
create policy "Users can view their own samples and Admins can view all"
  on public.samples for select
  using ( 
    auth.uid() = user_id 
    or 
    exists (
      select 1 from public.user_roles 
      where user_roles.user_id = auth.uid() 
      and user_roles.role in ('SUPER ADMIN', 'ADMIN')
    )
  );

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
