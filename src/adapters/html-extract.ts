/**
 * CSS-selector extraction without a DOM.
 *
 * A Worker has no `document`. It does have `HTMLRewriter`, a streaming parser
 * whose only interface is a CSS selector, and that turns out to be exactly what
 * this project needs: the selector comes from a `selector_packs` row and the code
 * never names a site (ADR-014, R23).
 *
 * The technique. `HTMLRewriter` walks the document in order and calls handlers as
 * it meets each start tag and text run. A row selector therefore fires *before*
 * the handlers for anything nested inside it, so a mutable "current row" pointer
 * is enough to attach field values to the right record. Three consequences are
 * worth knowing, because each one is a way this can be subtly wrong:
 *
 *   - A field selector that also matches something outside any row (a table
 *     header, a footer) is ignored while no row is open. Once the last row has
 *     opened, though, a trailing match would land on it. Directory list pages put
 *     their real columns before their footers, so this has not bitten; if it ever
 *     does, the fix is a container selector, not a smarter handler.
 *   - Attribute reads must go through `element`; text reads through `text`. A
 *     pack that maps a field to an attribute and gets text instead would collect
 *     the link label, which looks like data and is not.
 *   - An invalid selector makes `on()` throw. That is caught per field, so one bad
 *     selector in a pack loses one column instead of the whole run — and the run
 *     reports which fields it failed to extract rather than silently returning
 *     records with holes in them.
 */

import type { SelectorPack } from './shared';

export interface ExtractionResult {
  rows: Record<string, unknown>[];
  /** Fields whose selector could not be applied at all. Surfaced, never hidden. */
  failed_fields: string[];
}

function absolutise(value: string, baseUrl: string | null): string {
  if (!baseUrl) return value;
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return value;
  }
}

export async function extractRows(
  html: string,
  pack: SelectorPack,
  baseUrl: string | null,
): Promise<ExtractionResult> {
  const rows: Record<string, unknown>[] = [];
  const failed_fields: string[] = [];

  if (!pack.row) {
    return { rows, failed_fields: ['row'] };
  }

  let current: Record<string, unknown> | null = null;

  let rewriter = new HTMLRewriter();

  try {
    rewriter = rewriter.on(pack.row, {
      element() {
        current = {};
        rows.push(current);
      },
    });
  } catch {
    return { rows, failed_fields: ['row'] };
  }

  for (const [field, selector] of Object.entries(pack.fields ?? {})) {
    const attribute = pack.attributes?.[field];

    try {
      rewriter = rewriter.on(selector, {
        element(el) {
          if (!current) return;
          if (attribute) {
            const value = el.getAttribute(attribute);
            if (value !== null) current[field] = absolutise(value, baseUrl);
            return;
          }
          // A field with no attribute mapping collects text, which the `text`
          // handler below appends to. Nothing to do here.
        },
        text(chunk) {
          if (!current || attribute) return;
          const previous = typeof current[field] === 'string' ? (current[field] as string) : '';
          current[field] = previous + chunk.text;
        },
      });
    } catch {
      failed_fields.push(field);
    }
  }

  // A pack with no field map still has a row selector, which is a useful thing to
  // extract on its own: it answers "how many rows does this page have", which is
  // what the heal dry-run in 08 §3.3 counts.
  await rewriter.transform(new Response(html)).text();

  const cleaned = rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      out[key] = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : value;
    }
    return out;
  });

  return { rows: cleaned, failed_fields };
}
