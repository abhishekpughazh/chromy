# Resend + Supabase Auth Setup

Supabase's built-in auth email sender is rate-limited (about 2 emails/hour). Resend routes signup confirmations and password resets through a production email provider.

## Manual SMTP setup (recommended)

1. Create an API key at [resend.com/api-keys](https://resend.com/api-keys).
2. Verify a domain at [resend.com/domains](https://resend.com/domains).
3. In Supabase: **Authentication → Emails → SMTP Settings** — enable custom SMTP:

| Field | Value |
|-------|--------|
| Host | `smtp.resend.com` |
| Port | `465` |
| Username | `resend` |
| Password | Your Resend API key |
| Sender email | `noreply@yourdomain.com` |
| Sender name | `Chromy` |

4. Set **Site URL** and **Redirect URLs** under **Authentication → URL Configuration**.
5. Raise email rate limits under **Authentication → Rate Limits**.

The Resend API key belongs in Supabase SMTP settings (or Edge Function secrets), not in the frontend `.env`.

## Edge Function option

See `supabase/functions/send-email/` for a custom auth email hook. Deploy with the Supabase CLI and configure **Authentication → Hooks → Send Email**.

## References

- [Resend + Supabase](https://resend.com/docs/knowledge-base/getting-started-with-resend-and-supabase)
- [Supabase SMTP](https://supabase.com/docs/guides/auth/auth-smtp)
