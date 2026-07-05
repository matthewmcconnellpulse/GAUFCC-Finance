/**
 * Charities SORP (FRS 102) SOFA headings. Each Xero P&L account maps to one
 * (xero_accounts.sorp_category, editable under Settings → Fund classification
 * → SORP mapping); fund and charity reporting groups by these headings.
 */

import type { SorpCategory } from '@/types/db'

export const SORP_INCOME: SorpCategory[] = [
  'donations_legacies',
  'charitable_activities_income',
  'other_trading',
  'investments_income',
  'other_income',
]

export const SORP_EXPENDITURE: SorpCategory[] = [
  'raising_funds',
  'charitable_activities_expenditure',
  'other_expenditure',
]

export const SORP_LABELS: Record<SorpCategory, string> = {
  donations_legacies: 'Donations and legacies',
  charitable_activities_income: 'Charitable activities',
  other_trading: 'Other trading activities',
  investments_income: 'Investments',
  other_income: 'Other income',
  raising_funds: 'Raising funds',
  charitable_activities_expenditure: 'Charitable activities',
  other_expenditure: 'Other expenditure',
}

export function sorpLabel(category: SorpCategory | null | undefined): string {
  return category ? SORP_LABELS[category] : 'Unmapped'
}
