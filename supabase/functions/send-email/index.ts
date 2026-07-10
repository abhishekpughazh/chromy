import { Webhook } from 'npm:standardwebhooks@^1'
import { Resend } from 'npm:resend@^6'

const resend = new Resend(Deno.env.get('RESEND_API_KEY') as string)
const hookSecret = (Deno.env.get('SEND_EMAIL_HOOK_SECRET') as string).replace(
  'v1,whsec_',
  ''
)
const fromEmail =
  Deno.env.get('RESEND_FROM_EMAIL') ?? 'Chromy <onboarding@resend.dev>'

type EmailActionType =
  | 'signup'
  | 'invite'
  | 'magiclink'
  | 'recovery'
  | 'email_change'
  | 'email'
  | 'reauthentication'

interface HookPayload {
  user: {
    email: string
    new_email?: string
    user_metadata?: {
      username?: string
    }
  }
  email_data: {
    token: string
    token_hash: string
    redirect_to: string
    email_action_type: EmailActionType
    site_url: string
    token_new: string
    token_hash_new: string
  }
}

function buildVerifyUrl(
  supabaseUrl: string,
  tokenHash: string,
  type: string,
  redirectTo: string
) {
  const url = new URL(`${supabaseUrl}/auth/v1/verify`)
  url.searchParams.set('token', tokenHash)
  url.searchParams.set('type', type)
  if (redirectTo) {
    url.searchParams.set('redirect_to', redirectTo)
  }
  return url.toString()
}

function getEmailContent(
  action: EmailActionType,
  username: string | undefined,
  verifyUrl: string,
  otp: string
) {
  const greeting = username ? `Hi ${username},` : 'Hi,'

  switch (action) {
    case 'signup':
      return {
        subject: 'Confirm your Chromy account',
        html: `
          <h2>${greeting}</h2>
          <p>Thanks for signing up for Chromy. Confirm your email to start practicing karyotyping.</p>
          <p><a href="${verifyUrl}">Confirm your email</a></p>
          <p>Or enter this code in the app: <strong>${otp}</strong></p>
          <p>If you did not create an account, you can ignore this email.</p>
        `,
      }
    case 'recovery':
      return {
        subject: 'Reset your Chromy password',
        html: `
          <h2>${greeting}</h2>
          <p>We received a request to reset your Chromy password.</p>
          <p><a href="${verifyUrl}">Reset your password</a></p>
          <p>Or enter this code in the app: <strong>${otp}</strong></p>
          <p>If you did not request a password reset, you can ignore this email.</p>
        `,
      }
    case 'magiclink':
    case 'email':
      return {
        subject: 'Your Chromy login link',
        html: `
          <h2>${greeting}</h2>
          <p>Use the link below to sign in to Chromy.</p>
          <p><a href="${verifyUrl}">Sign in to Chromy</a></p>
          <p>Or enter this code in the app: <strong>${otp}</strong></p>
          <p>If you did not request this link, you can ignore this email.</p>
        `,
      }
    case 'invite':
      return {
        subject: 'You have been invited to Chromy',
        html: `
          <h2>${greeting}</h2>
          <p>You have been invited to join Chromy.</p>
          <p><a href="${verifyUrl}">Accept your invitation</a></p>
          <p>Or enter this code in the app: <strong>${otp}</strong></p>
        `,
      }
    case 'email_change':
      return {
        subject: 'Confirm your new Chromy email',
        html: `
          <h2>${greeting}</h2>
          <p>Confirm your new email address for Chromy.</p>
          <p><a href="${verifyUrl}">Confirm email change</a></p>
          <p>Or enter this code in the app: <strong>${otp}</strong></p>
        `,
      }
    case 'reauthentication':
      return {
        subject: 'Confirm your Chromy identity',
        html: `
          <h2>${greeting}</h2>
          <p>Confirm this action in Chromy.</p>
          <p><a href="${verifyUrl}">Continue</a></p>
          <p>Or enter this code in the app: <strong>${otp}</strong></p>
        `,
      }
    default:
      return {
        subject: 'Chromy notification',
        html: `
          <h2>${greeting}</h2>
          <p><a href="${verifyUrl}">Continue</a></p>
          <p>Or enter this code in the app: <strong>${otp}</strong></p>
        `,
      }
  }
}

async function sendAuthEmail(
  to: string,
  action: EmailActionType,
  username: string | undefined,
  supabaseUrl: string,
  tokenHash: string,
  redirectTo: string,
  otp: string
) {
  const verifyUrl = buildVerifyUrl(supabaseUrl, tokenHash, action, redirectTo)
  const { subject, html } = getEmailContent(
    action,
    username,
    verifyUrl,
    otp
  )

  const { error } = await resend.emails.send({
    from: fromEmail,
    to: [to],
    subject,
    html,
  })

  if (error) {
    throw error
  }
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const payload = await req.text()
  const headers = Object.fromEntries(req.headers)
  const wh = new Webhook(hookSecret)

  try {
    const { user, email_data } = wh.verify(payload, headers) as HookPayload
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? email_data.site_url
    const username = user.user_metadata?.username
    const action = email_data.email_action_type

    if (action === 'email_change' && user.new_email && email_data.token_hash_new) {
      await sendAuthEmail(
        user.email,
        action,
        username,
        supabaseUrl,
        email_data.token_hash_new,
        email_data.redirect_to,
        email_data.token
      )
      await sendAuthEmail(
        user.new_email,
        action,
        username,
        supabaseUrl,
        email_data.token_hash,
        email_data.redirect_to,
        email_data.token_new
      )
    } else {
      await sendAuthEmail(
        user.email,
        action,
        username,
        supabaseUrl,
        email_data.token_hash,
        email_data.redirect_to,
        email_data.token
      )
    }
  } catch (error) {
    console.error('send-email hook failed:', error)
    const message = error instanceof Error ? error.message : 'Unauthorized'
    const httpCode =
      typeof error === 'object' && error !== null && 'code' in error
        ? (error as { code?: string }).code
        : undefined

    return new Response(
      JSON.stringify({
        error: {
          http_code: httpCode,
          message,
        },
      }),
      {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }
    )
  }

  return new Response(JSON.stringify({}), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
})
