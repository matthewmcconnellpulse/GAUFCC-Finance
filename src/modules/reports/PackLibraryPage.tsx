/**
 * Pack library — saved board packs (board_packs), RLS-scoped so trustees see
 * only what they may. Signed-url downloads, version badges, 'Mark final'
 * (pulse_admin / ceo) and client-side .eml distribution for Pulse and the CEO.
 */
import { useState } from 'react'
import { usePermissions } from '@/auth/AuthProvider'
import {
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  LoadingRows,
  PageHeader,
  StatusChip,
} from '@/components/ui'
import { formatDate, formatDateTime } from '@/lib/format'
import { useSupabaseQuery } from '@/lib/useSupabaseQuery'
import type { BoardPack } from '@/types/db'
import { VersionBadge } from './components'
import { buildEml, distributionBody, downloadFile, safeFilename, type EmlAttachment } from './eml'
import {
  fetchFundManagerEmails,
  fetchPacks,
  markPackFinal,
  periodLabel,
  signedPackUrl,
  SCOPE_LABELS,
} from './lib'

export default function PackLibraryPage() {
  const { isPulse, isCeo, isAdmin } = usePermissions()
  const canDistribute = isPulse || isCeo
  const canFinalise = isAdmin || isCeo
  const packs = useSupabaseQuery(fetchPacks, [])
  const [busyId, setBusyId] = useState<string | null>(null)
  const [rowError, setRowError] = useState<string | null>(null)

  const download = async (pack: BoardPack) => {
    if (!pack.storage_path) return
    setBusyId(pack.id)
    setRowError(null)
    try {
      const url = await signedPackUrl(pack.storage_path)
      window.open(url, '_blank', 'noopener')
    } catch (e) {
      setRowError(e instanceof Error ? e.message : 'Download link could not be created')
    } finally {
      setBusyId(null)
    }
  }

  const finalise = async (pack: BoardPack) => {
    setBusyId(pack.id)
    setRowError(null)
    try {
      await markPackFinal(pack.id)
      packs.refetch()
    } catch (e) {
      setRowError(e instanceof Error ? e.message : 'The pack could not be marked final')
    } finally {
      setBusyId(null)
    }
  }

  /**
   * Distribution .eml — recipients are the scoped funds' managers (blank for
   * whole-charity packs, to be filled in the mail client), with the pack HTML
   * attached. Printing to PDF first and attaching that manually is also fine.
   */
  const downloadEml = async (pack: BoardPack) => {
    setBusyId(pack.id)
    setRowError(null)
    try {
      let to: string[] = []
      if (pack.scope !== 'whole_charity' && pack.scope_fund_ids && pack.scope_fund_ids.length > 0) {
        to = await fetchFundManagerEmails(pack.scope_fund_ids)
      }
      const label = periodLabel({ preset: 'custom', start: pack.period_start, end: pack.period_end })
      let attachment: EmlAttachment | undefined
      if (pack.storage_path) {
        try {
          const url = await signedPackUrl(pack.storage_path)
          const res = await fetch(url)
          if (!res.ok) throw new Error(`download failed (${res.status})`)
          const html = await res.text()
          attachment = {
            filename: safeFilename(pack.title, '.html'),
            mime: 'text/html',
            content: html,
          }
        } catch {
          attachment = undefined // still produce a usable draft without the file
        }
      }
      const eml = buildEml({
        to,
        subject: `${pack.title} — ${label}`,
        body:
          distributionBody({ title: pack.title, periodLabel: label }) +
          (attachment ? '' : '\n\n(The pack file could not be attached automatically — download it from the pack library and attach it before sending.)'),
        attachment,
      })
      downloadFile(safeFilename(pack.title, '.eml'), eml, 'message/rfc822')
    } catch (e) {
      setRowError(e instanceof Error ? e.message : 'The .eml could not be generated')
    } finally {
      setBusyId(null)
    }
  }

  if (packs.loading) {
    return (
      <div>
        <PageHeader title="Pack library" subtitle="Saved board packs, versioned and access-controlled" />
        <Card>
          <LoadingRows cols={5} rows={6} />
        </Card>
      </div>
    )
  }
  if (packs.error) {
    return (
      <div>
        <PageHeader title="Pack library" subtitle="Saved board packs, versioned and access-controlled" />
        <ErrorNotice message={`Packs could not be loaded — ${packs.error}`} />
      </div>
    )
  }

  const rows = packs.data ?? []

  return (
    <div>
      <PageHeader
        title="Pack library"
        subtitle="Saved board packs, versioned and access-controlled"
      />
      {rowError ? (
        <div className="mb-4">
          <ErrorNotice message={rowError} />
        </div>
      ) : null}
      {rows.length === 0 ? (
        <Card>
          <EmptyState
            title="No packs saved yet"
            hint={
              canDistribute
                ? 'Assemble one on the board pack tab — it lands here as a draft, ready to review, finalise and distribute.'
                : 'Packs prepared for you by Pulse will appear here.'
            }
          />
        </Card>
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px]">
              <thead>
                <tr>
                  <th className="th-register">Pack</th>
                  <th className="th-register">Period</th>
                  <th className="th-register">Scope</th>
                  <th className="th-register">Status</th>
                  <th className="th-register">Created</th>
                  <th className="th-register text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((pack) => (
                  <tr key={pack.id} className="hover:bg-paper-2/60">
                    <td className="td-register">
                      <div className="flex items-center gap-2">
                        <span className="text-[12.5px] text-ink font-medium">{pack.title}</span>
                        <VersionBadge version={pack.version} />
                      </div>
                    </td>
                    <td className="td-register text-[12px] text-stone-700 whitespace-nowrap">
                      <span className="font-mono text-[11px]">
                        {formatDate(pack.period_start)} – {formatDate(pack.period_end)}
                      </span>
                    </td>
                    <td className="td-register text-[12px] text-stone-700">{SCOPE_LABELS[pack.scope]}</td>
                    <td className="td-register">
                      {pack.status === 'final' ? (
                        <StatusChip tone="good">Final</StatusChip>
                      ) : (
                        <StatusChip tone="neutral">Draft</StatusChip>
                      )}
                    </td>
                    <td className="td-register text-[11px] text-stone-500 font-mono whitespace-nowrap">
                      {formatDateTime(pack.created_at)}
                    </td>
                    <td className="td-register">
                      <div className="flex items-center justify-end gap-1.5 flex-wrap">
                        {pack.storage_path ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busyId === pack.id}
                            onClick={() => void download(pack)}
                          >
                            Download
                          </Button>
                        ) : null}
                        {canDistribute ? (
                          <Button
                            size="sm"
                            variant="quiet"
                            disabled={busyId === pack.id}
                            onClick={() => void downloadEml(pack)}
                            title="Downloads an .eml draft with the pack attached — opens in your mail client for editing before sending"
                          >
                            Distribution .eml
                          </Button>
                        ) : null}
                        {canFinalise && pack.status === 'draft' ? (
                          <Button
                            size="sm"
                            variant="money"
                            disabled={busyId === pack.id}
                            onClick={() => void finalise(pack)}
                          >
                            Mark final
                          </Button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {canDistribute ? (
            <p className="text-[11px] text-stone-500 px-4 py-3 border-t border-stone-150">
              The distribution .eml opens as an editable draft in your desktop mail client with the pack's HTML
              attached. If trustees prefer PDF, open the pack, print to PDF and attach that instead — both are fine.
            </p>
          ) : null}
        </Card>
      )}
    </div>
  )
}
