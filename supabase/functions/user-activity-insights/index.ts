/**
 * user-activity-insights — AI summary of what each signed-in user actually
 * looks at (JWT-verified; pulse_admin ONLY, same audience as the activity
 * trail itself).
 *
 * Reads the last 30 days of user_activity, aggregates it per user (views by
 * page, funds opened by name, active days, recency) and asks Claude for a
 * 2–3 sentence plain-English read on each user's interests. Returns
 * { insights: [{ profile_id, name, role, summary }], generated_at }.
 */

import { handleOptions, json, errorResponse } from './_shared/http.ts'
import { getCaller, callerHasRole, serviceClient } from './_shared/auth.ts'
import { callClaude, extractJson } from './_shared/ai.ts'

const SYSTEM = `You analyse page-view activity for GAUFCC Finance, a charity finance platform run by Pulse Accountants. For each user you receive aggregated activity: page view counts, which funds they opened, how often and how recently they signed in.

Write, for each user, a 2–3 sentence plain-English summary of what they appear to be interested in and how they use the platform. UK English, calm and factual, no hype, no exclamation marks. Mention specific funds or areas when the data supports it; note patterns (e.g. checks after month end, mostly reads reports, heavy expense use). If a user has barely any activity, say so plainly rather than inventing interest.

Respond with ONLY a JSON array, one object per user: [{"profile_id": "...", "summary": "..."}]. No markdown, no prose around it.`

interface ActivityRow {
  profile_id: string
  path: string
  page: string
  occurred_at: string
}

Deno.serve(async (req) => {
  const preflight = handleOptions(req)
  if (preflight) return preflight
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405)

  const caller = await getCaller(req)
  if (!callerHasRole(caller, ['pulse_admin'])) {
    return errorResponse('Not authorised', 403)
  }

  const svc = serviceClient()
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()

  const { data: activityData, error: activityError } = await svc
    .from('user_activity')
    .select('profile_id, path, page, occurred_at')
    .gte('occurred_at', since)
    .order('occurred_at', { ascending: false })
    .limit(20000)
  if (activityError) {
    return errorResponse(`Could not read the activity trail: ${activityError.message}`, 500)
  }
  const activity = (activityData ?? []) as ActivityRow[]
  if (activity.length === 0) {
    return json({ insights: [], generated_at: new Date().toISOString() })
  }

  const { data: profilesData } = await svc
    .from('profiles')
    .select('id, full_name, role')
    .limit(1000)
  const profiles = new Map(
    ((profilesData ?? []) as { id: string; full_name: string; role: string }[]).map((p) => [
      p.id,
      p,
    ]),
  )

  const { data: fundsData } = await svc.from('funds').select('id, name').limit(1000)
  const fundNames = new Map(
    ((fundsData ?? []) as { id: string; name: string }[]).map((f) => [f.id, f.name]),
  )

  // ── Aggregate per user ──────────────────────────────────────────────────────

  interface UserAgg {
    profile_id: string
    name: string
    role: string
    views: number
    active_days: Set<string>
    first_seen: string
    last_seen: string
    pages: Map<string, number>
    funds: Map<string, number>
  }

  const byUser = new Map<string, UserAgg>()
  const fundPath = /^\/funds\/([0-9a-f-]{36})/

  for (const row of activity) {
    let agg = byUser.get(row.profile_id)
    if (!agg) {
      const profile = profiles.get(row.profile_id)
      agg = {
        profile_id: row.profile_id,
        name: profile?.full_name ?? 'Unknown user',
        role: profile?.role ?? 'unknown',
        views: 0,
        active_days: new Set(),
        first_seen: row.occurred_at,
        last_seen: row.occurred_at,
        pages: new Map(),
        funds: new Map(),
      }
      byUser.set(row.profile_id, agg)
    }
    agg.views += 1
    agg.active_days.add(row.occurred_at.slice(0, 10))
    if (row.occurred_at < agg.first_seen) agg.first_seen = row.occurred_at
    if (row.occurred_at > agg.last_seen) agg.last_seen = row.occurred_at
    agg.pages.set(row.page, (agg.pages.get(row.page) ?? 0) + 1)
    const fundMatch = fundPath.exec(row.path)
    if (fundMatch) {
      const name = fundNames.get(fundMatch[1]) ?? 'unknown fund'
      agg.funds.set(name, (agg.funds.get(name) ?? 0) + 1)
    }
  }

  const top = (map: Map<string, number>, n: number) =>
    [...map.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([name, count]) => ({ name, count }))

  const users = [...byUser.values()].map((u) => ({
    profile_id: u.profile_id,
    name: u.name,
    role: u.role,
    views_30d: u.views,
    active_days_30d: u.active_days.size,
    last_seen: u.last_seen,
    pages: top(u.pages, 8),
    funds_opened: top(u.funds, 6),
  }))

  try {
    const text = await callClaude({
      system: SYSTEM,
      maxTokens: 2000,
      messages: [
        {
          role: 'user',
          content: `Activity for the last 30 days, one object per user (JSON):
${JSON.stringify(users, null, 2)}

Write the per-user interest summaries now.`,
        },
      ],
    })
    const parsed = extractJson<Array<{ profile_id?: string; summary?: string }>>(text)
    const summaries = new Map(
      parsed
        .filter((p) => typeof p.profile_id === 'string' && typeof p.summary === 'string')
        .map((p) => [p.profile_id as string, p.summary as string]),
    )
    const insights = users.map((u) => ({
      profile_id: u.profile_id,
      name: u.name,
      role: u.role,
      summary: summaries.get(u.profile_id) ?? 'Not enough activity to say anything useful yet.',
    }))
    return json({ insights, generated_at: new Date().toISOString() })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Insight generation failed'
    console.error('[user-activity-insights]', message)
    return errorResponse(message, 502)
  }
})
