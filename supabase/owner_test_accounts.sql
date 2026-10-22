-- Owner and test accounts: no daily render limits (customers keep theirs).
-- Run in Supabase > SQL Editor. Add or remove emails as needed; 'customer' puts an account back on the limits.
update public.profiles set role = 'admin'
where id in (select id from auth.users where lower(email) in ('ollicrealestate@gmail.com', 'collins.ollic@gmail.com', 'collinsonelegit@gmail.com'));
