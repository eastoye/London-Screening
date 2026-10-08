# Cinema-Listings

[![Open in Bolt](https://bolt.new/static/open-in-bolt.svg)](https://bolt.new/~/sb1-pdp6gh31)

## Authentication

London Screenings uses Supabase email/password authentication. The full flow
includes:

- **Sign up** with email and password (email confirmation optional).
- **Log in** with email and password.
- **Log out** (local scope, preserves the separate Trakt token).
- **Password recovery**: a "Forgot your password?" link on the log in form
  sends a reset email. The reset link redirects back to the app, which opens
  a "Set a new password" dialog. After updating, the user is logged in with
  a confirmation notice.

Password recovery has been implemented and tested.
