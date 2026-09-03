/**
 * Sign-in links on the charity's own domain.
 *
 * generateLink's action_link points at <project>.supabase.co/auth/v1/verify,
 * which looks like phishing to anyone who receives it. We hand out the
 * one-time token on the app's domain instead — /reset-password verifies it
 * client-side with auth.verifyOtp({ token_hash, type }) — and only fall back
 * to the raw Supabase link when there is no origin to build on.
 */
export type LinkType = 'invite' | 'recovery'

export function brandedLink(
  origin: string | null,
  properties: { action_link?: string | null; hashed_token?: string | null } | null | undefined,
  type: LinkType,
): string | null {
  const hashedToken = properties?.hashed_token ?? null
  if (origin && hashedToken) {
    const url = new URL('/reset-password', origin.replace(/\/+$/, '') + '/')
    url.searchParams.set('token_hash', hashedToken)
    url.searchParams.set('type', type)
    return url.toString()
  }
  return properties?.action_link ?? null
}
