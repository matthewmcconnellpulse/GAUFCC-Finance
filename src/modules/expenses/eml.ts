/**
 * Client-side RFC 5322 .eml generation — no email integration, ever.
 * The generated file opens as an editable draft in the user's desktop mail
 * client (X-Unsent: 1 makes Outlook treat it as unsent), so a human always
 * reviews and presses send themselves.
 */

const CRLF = '\r\n'

/** RFC 2047 encoded-word for header values that carry non-ASCII (e.g. an em dash). */
function encodeHeaderValue(value: string): string {
  if (!/[^\t\x20-\x7e]/.test(value)) return value
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return `=?UTF-8?B?${btoa(binary)}?=`
}

export interface EmlMessage {
  to: string
  subject: string
  /** plain-text body; \n line endings are normalised to CRLF */
  body: string
  cc?: string
  from?: string
}

export function buildEml(msg: EmlMessage): string {
  const headers = [
    `Date: ${new Date().toUTCString()}`,
    ...(msg.from ? [`From: ${msg.from}`] : []),
    `To: ${msg.to}`,
    ...(msg.cc ? [`Cc: ${msg.cc}`] : []),
    `Subject: ${encodeHeaderValue(msg.subject)}`,
    'X-Unsent: 1',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
  ]
  const body = msg.body.replace(/\r?\n/g, CRLF)
  return headers.join(CRLF) + CRLF + CRLF + body + CRLF
}

/** Build the message and trigger a browser download of the .eml file. */
export function downloadEml(fileName: string, msg: EmlMessage): void {
  const blob = new Blob([buildEml(msg)], { type: 'message/rfc822' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName.endsWith('.eml') ? fileName : `${fileName}.eml`
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}
