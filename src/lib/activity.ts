/**
 * Page-view trail. AppShell calls recordActivity on every route change; rows
 * land in user_activity (users insert their own trail only; only the Pulse
 * admin can read it — Settings → Users → User activity). Failures are
 * swallowed: analytics must never break navigation.
 */

import { supabase } from './supabase'

const PAGE_NAMES: Array<[RegExp, string]> = [
  [/^\/$/, 'Dashboard'],
  [/^\/funds\/integrity/, 'Fund integrity'],
  [/^\/funds\/[0-9a-f-]{36}/, 'Fund detail'],
  [/^\/funds/, 'Funds register'],
  [/^\/reports/, 'Reports'],
  [/^\/financials\/profit-loss/, 'Profit & Loss'],
  [/^\/financials\/balance-sheet/, 'Balance Sheet'],
  [/^\/financials\/transactions/, 'Transactions'],
  [/^\/expenses\/approvals/, 'Expense approvals'],
  [/^\/expenses\/[0-9a-f-]{36}/, 'Expense claim'],
  [/^\/expenses/, 'Expenses'],
  [/^\/people\/[0-9a-f-]{36}/, 'Person record'],
  [/^\/people/, 'People'],
  [/^\/imports/, 'Imports'],
  [/^\/vat/, 'VAT'],
  [/^\/projects/, 'Projects'],
  [/^\/settings/, 'Settings'],
]

export function pageNameFor(path: string): string {
  for (const [pattern, name] of PAGE_NAMES) {
    if (pattern.test(path)) return name
  }
  return 'Other'
}

let lastKey = ''

export function recordActivity(profileId: string, path: string): void {
  const key = `${profileId}|${path}`
  if (key === lastKey) return // refreshes and re-renders are not new visits
  lastKey = key
  void supabase
    .from('user_activity')
    .insert({ profile_id: profileId, path, page: pageNameFor(path) })
    .then(({ error }) => {
      if (error) console.debug('[activity] not recorded:', error.message)
    })
}
