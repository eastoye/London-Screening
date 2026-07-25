/*
# Lock down screenings table to public read-only

1. Security changes
- Remove the existing public INSERT, UPDATE, DELETE policies on `screenings`.
- Keep only the public SELECT policy so the anon-key frontend can read upcoming
  screenings.
- After this change, the `anon` role can SELECT rows but cannot INSERT, UPDATE,
  or DELETE. Writes are still possible via the service-role key (used by the
  import-prince-charles edge function), which bypasses RLS.
2. No table / column changes.
*/

DROP POLICY IF EXISTS "anon_insert_screenings" ON screenings;
DROP POLICY IF EXISTS "anon_update_screenings" ON screenings;
DROP POLICY IF EXISTS "anon_delete_screenings" ON screenings;

-- SELECT policy already exists ("anon_select_screenings"); leave it in place.
