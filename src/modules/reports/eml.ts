/**
 * Client-side .eml generation (RFC 5322 / MIME) for pack distribution.
 * No email integration — the file opens as an editable draft in the staff
 * member's desktop mail client (X-Unsent: 1 makes Outlook treat it as
 * unsent). Dependability rules:
 *   · CRLF line endings throughout
 *   · base64 content-transfer-encoding wrapped at 76 characters
 *   · non-ASCII header values RFC 2047 encoded (=?UTF-8?B?…?=)
 *   · a unique multipart boundary that cannot collide with base64 output
 */

export interface EmlAttachment {
  filename: string
  mime: string
  /** raw (unencoded) content; UTF-8 encoded then base64'd */
  content: string
}

export interface EmlMessage {
  to: string[]
  subject: string
  body: string
  attachment?: EmlAttachment
}

function utf8Base64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

/** Base64 wrapped at 76 characters per RFC 2045 §6.8, CRLF separated. */
function wrap76(b64: string): string {
  const lines: string[] = []
  for (let i = 0; i < b64.length; i += 76) lines.push(b64.slice(i, i + 76))
  return lines.join('\r\n')
}

/** RFC 2047 encoded-word for header values with non-ASCII characters. */
function headerValue(value: string): string {
  // eslint-disable-next-line no-control-regex
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${utf8Base64(value)}?=`
}

/** Quote a filename for Content-Disposition; strip characters mail clients choke on. */
export function safeFilename(name: string, ext: string): string {
  const base = name
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
  return `${base || 'board-pack'}${ext}`
}

export function buildEml(message: EmlMessage): string {
  // '=' never appears mid-base64-line at this position pattern, and the
  // random suffix keeps the boundary out of any body/attachment content.
  const boundary = `----=_pulse_pack_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
  const lines: string[] = [
    `Date: ${new Date().toUTCString()}`,
    `To: ${message.to.map(headerValue).join(', ')}`,
    `Subject: ${headerValue(message.subject)}`,
    'X-Unsent: 1',
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    'This is a multi-part message in MIME format.',
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(utf8Base64(message.body)),
    '',
  ]
  if (message.attachment) {
    const { filename, mime, content } = message.attachment
    lines.push(
      `--${boundary}`,
      `Content-Type: ${mime}; name="${filename}"`,
      `Content-Disposition: attachment; filename="${filename}"`,
      'Content-Transfer-Encoding: base64',
      '',
      wrap76(utf8Base64(content)),
      '',
    )
  }
  lines.push(`--${boundary}--`, '')
  return lines.join('\r\n')
}

/** Trigger a browser download of generated content. */
export function downloadFile(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}

/** The default distribution email body — editable in the mail client. */
export function distributionBody(opts: { title: string; periodLabel: string }): string {
  return [
    'Dear trustees,',
    '',
    `Please find attached ${opts.title} for ${opts.periodLabel}.`,
    '',
    'The pack is attached as an HTML file — open it in your browser and use File, then Print to produce a paper or PDF copy if you prefer. Figures are drawn from the live ledger and were checked before issue.',
    '',
    'If anything needs a closer look before the meeting, do let us know.',
    '',
    'Kind regards,',
    'Pulse Accountants & Tax Advisors',
  ].join('\n')
}
