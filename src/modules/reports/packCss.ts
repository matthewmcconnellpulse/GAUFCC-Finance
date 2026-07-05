/**
 * Board-pack stylesheet — one source of truth. The same CSS string is
 * (a) injected as a <style> tag next to the in-app pack preview, and
 * (b) inlined into the standalone HTML document saved to the pack library,
 * so what prints in the app is exactly what a downloaded pack renders.
 *
 * Pages are true A4 (210 × 297mm) with @page rules; every .pk-page breaks.
 * 'The Ledger' concept (docs/design/1a.html) is the default interior: white
 * paper, Fraunces headings, hairline rules, mint as a thread.
 */

export const PACK_CSS = `
@page { size: A4; margin: 0; }

.pk-root {
  font-family: 'Geist', system-ui, sans-serif;
  color: #0d0a26;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
.pk-page {
  width: 210mm;
  height: 296mm;
  box-sizing: border-box;
  padding: 18mm 16mm;
  background: #fff;
  display: flex;
  flex-direction: column;
  position: relative;
  overflow: hidden;
  margin: 0 auto;
  page-break-after: always;
  break-after: page;
}
.pk-page:last-child { page-break-after: auto; break-after: auto; }

/* Screen preview chrome (ignored in the standalone file's print) */
.pk-preview .pk-page { box-shadow: 0 8px 24px -8px rgba(13,10,38,.2); margin-bottom: 24px; }
@media print {
  .pk-preview .pk-page { box-shadow: none; margin-bottom: 0; }
}

/* ── Typography ── */
.pk-kicker { font: 500 10px 'Geist', sans-serif; letter-spacing: .16em; text-transform: uppercase; color: #807c70; }
.pk-kicker--mint { color: #04b894; }
.pk-h1 { font: 400 28px 'Fraunces', Georgia, serif; color: #0d0a26; letter-spacing: -.01em; }
.pk-lede { font: 400 13px/1.65 'Geist', sans-serif; color: #4a4740; }
.pk-body { font: 400 13.5px/1.75 'Geist', sans-serif; color: #2b2925; white-space: pre-wrap; }
.pk-mono { font-family: 'JetBrains Mono', ui-monospace, monospace; }
.pk-muted { color: #807c70; }

/* ── Page furniture ── */
.pk-head {
  display: flex; justify-content: space-between; align-items: baseline;
  border-bottom: 1px solid #211951; padding-bottom: 12px;
}
.pk-pagenum { font: 500 10px 'JetBrains Mono', monospace; color: #807c70; }
.pk-footer {
  margin-top: auto; display: flex; justify-content: space-between;
  padding-top: 12px; border-top: 1px solid #d6d3c9;
  font: 400 9.5px 'Geist', sans-serif; color: #807c70;
}
.pk-thread { width: 64px; height: 3px; border-radius: 2px; background: linear-gradient(90deg, #08f2c7, #1de4ff, #ff80e3); }

/* ── Covers ── */
.pk-cover-title { font: 300 46px/1.1 'Fraunces', Georgia, serif; letter-spacing: -.015em; color: #0d0a26; }
.pk-cover-sub { font: italic 400 21px/1.35 'Fraunces', Georgia, serif; color: #4a4740; }
.pk-cover-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 24px; padding-top: 20px; border-top: 1px solid #d6d3c9; }
.pk-cover-cell .pk-kicker { letter-spacing: .14em; font-size: 9.5px; }
.pk-cover-cell div + div { font: 400 12.5px/1.5 'Geist', sans-serif; color: #0d0a26; margin-top: 5px; }

.pk-page--indigo { background: #15103a; color: #fbfaf7; }
.pk-page--indigo .pk-cover-title { color: #fbfaf7; font-size: 58px; }
.pk-page--indigo .pk-cover-grid { border-top-color: rgba(255,255,255,.14); }
.pk-page--indigo .pk-cover-cell div + div { color: rgba(251,250,247,.85); }
.pk-page--indigo .pk-kicker { color: rgba(251,250,247,.55); }
.pk-page--indigo .pk-kicker--mint { color: #08f2c7; }
.pk-ghost-numeral {
  position: absolute; right: -8mm; bottom: 46mm;
  font: 300 150px/1 'Fraunces', Georgia, serif; letter-spacing: -.03em;
  color: transparent; -webkit-text-stroke: 1px rgba(251,250,247,.16);
  pointer-events: none;
}

.pk-page--paper { background: #f6f4ee; }
.pk-frame { position: absolute; inset: 9mm; border: 1px solid #211951; }
.pk-frame-inner { position: absolute; inset: 11mm; border: 1px solid rgba(33,25,81,.35); }
.pk-minute-caps { font: 500 11px 'Geist', sans-serif; letter-spacing: .3em; text-transform: uppercase; color: #4a4740; }
.pk-minute-rule { width: 180px; height: 1px; background: #211951; margin: 26px auto; }

/* ── KPI band (executive summary) ── */
.pk-kpis { display: grid; grid-template-columns: repeat(4, 1fr); margin-top: 22px; border-bottom: 1px solid #d6d3c9; padding-bottom: 20px; }
.pk-kpi { padding: 0 16px; border-right: 1px solid #ebe9e3; }
.pk-kpi:first-child { padding-left: 0; }
.pk-kpi:last-child { border-right: 0; padding-right: 0; }
.pk-kpi-label { font: 500 9.5px 'Geist', sans-serif; letter-spacing: .13em; text-transform: uppercase; color: #807c70; }
.pk-kpi-value { font: 400 30px 'Fraunces', Georgia, serif; color: #0d0a26; margin-top: 8px; }
.pk-kpi-sub { font: 500 10.5px 'JetBrains Mono', monospace; color: #4a4740; margin-top: 4px; }
.pk-kpi-sub--up { color: #04b894; }
.pk-kpi-sub--down { color: #b86e02; }

.pk-highlights { border-left: 2px solid #08f2c7; padding-left: 18px; }
.pk-highlight { font: 400 12.5px/1.6 'Geist', sans-serif; color: #2b2925; padding: 11px 0; border-bottom: 1px solid #ebe9e3; }
.pk-highlight:last-child { border-bottom: 0; }

.pk-ai-attrib {
  display: inline-flex; align-items: center; gap: 7px; margin-top: 16px;
  padding: 6px 12px; border: 1px solid #d6d3c9; border-radius: 999px;
  font: 400 10px 'Geist', sans-serif; color: #4a4740;
}
.pk-ai-attrib--draft { border-color: #f5a524; color: #8a5200; background: rgba(245,165,36,.08); }

/* ── Financial tables ── */
.pk-table { width: 100%; border-collapse: collapse; }
.pk-table th {
  text-align: left; padding: 12px 4px 6px;
  font: 500 9px 'Geist', sans-serif; letter-spacing: .12em; text-transform: uppercase; color: #807c70;
  border-bottom: 1px solid #211951;
}
.pk-table th.pk-num { text-align: right; }
.pk-table td { padding: 5px 4px; border-bottom: 1px solid #f3f1ea; font: 400 11.5px 'Geist', sans-serif; color: #2b2925; vertical-align: baseline; }
.pk-num { text-align: right; font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 10.5px; font-variant-numeric: tabular-nums; }
.pk-table td.pk-strong { font-weight: 500; color: #0d0a26; }
tr.pk-group-head td {
  font: 500 10px 'Geist', sans-serif; letter-spacing: .13em; text-transform: uppercase;
  padding-top: 14px; padding-bottom: 4px; border-bottom: 0;
}
tr.pk-subtotal td { border-top: 1px solid #211951; border-bottom: 0; font-weight: 500; color: #211951; padding-top: 7px; padding-bottom: 7px; }
tr.pk-grand td {
  border-top: 2px solid #0d0a26; border-bottom: 3px double #0d0a26;
  font-weight: 600; color: #0d0a26; padding-top: 9px; padding-bottom: 9px; font-size: 12px;
}
.pk-footnote { font: 400 10px/1.6 'Geist', sans-serif; color: #807c70; margin-top: 12px; }

/* ── Fund pages ── */
.pk-chip { display: inline-block; font: 500 10px 'Geist', sans-serif; padding: 3px 10px; border-radius: 999px; vertical-align: 4px; margin-left: 10px; }
.pk-purpose { font: italic 400 14px/1.6 'Fraunces', Georgia, serif; color: #4a4740; margin-top: 14px; }
.pk-tiles { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-top: 22px; }
.pk-tile { border-top: 2px solid #0d0a26; padding-top: 9px; }
.pk-tile-label { font: 500 9.5px 'Geist', sans-serif; letter-spacing: .13em; text-transform: uppercase; color: #807c70; }
.pk-tile-value { font: 500 16px 'JetBrains Mono', monospace; color: #0d0a26; margin-top: 6px; }

.pk-note {
  font: 400 11px/1.6 'Geist', sans-serif; color: #4a4740; margin-top: 14px;
  padding: 12px 14px; background: #fbfaf7; border: 1px solid #ebe9e3; border-radius: 8px;
}
.pk-panel { padding: 16px 18px; background: #fbfaf7; border: 1px solid #ebe9e3; border-radius: 10px; }

/* ── Contents ── */
.pk-toc-row { display: flex; align-items: baseline; gap: 10px; padding: 10px 0; border-bottom: 1px solid #f3f1ea; }
.pk-toc-title { font: 400 14px 'Geist', sans-serif; color: #2b2925; }
.pk-toc-sub { font: 400 11px 'Geist', sans-serif; color: #807c70; }
.pk-toc-leader { flex: 1; border-bottom: 1px dotted #b3afa3; transform: translateY(-3px); }
.pk-toc-page { font: 500 11px 'JetBrains Mono', monospace; color: #0d0a26; }

/* ── Integrity ── */
.pk-check-row { display: grid; grid-template-columns: 24px 1fr 110px; gap: 0 14px; padding: 12px 0; border-bottom: 1px solid #f3f1ea; align-items: center; }
.pk-check-status { text-align: right; font: 500 10px 'Geist', sans-serif; letter-spacing: .08em; text-transform: uppercase; }
`

/**
 * Wrap serialised pack markup into a complete standalone HTML document.
 * Approach (documented per the build brief): the pack preview renders the
 * PackDocument React tree into a real (possibly hidden) container; we take
 * that container's innerHTML — SVG charts and all styling classes serialise
 * with it — wrap it here with the same PACK_CSS plus the Google Fonts link
 * the app itself uses, and send the string to the generate-pack function.
 */
export function buildPackHtml(inner: string, title: string): string {
  return [
    '<!doctype html>',
    '<html lang="en-GB">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow">',
    `<title>${escapeHtml(title)}</title>`,
    '<link rel="preconnect" href="https://fonts.googleapis.com">',
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
    '<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,300..700;1,9..144,300..700&family=Geist:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">',
    `<style>body{margin:0;background:#3a3733}@media print{body{background:#fff}}${PACK_CSS}</style>`,
    '</head>',
    '<body>',
    inner,
    '</body>',
    '</html>',
  ].join('\n')
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
