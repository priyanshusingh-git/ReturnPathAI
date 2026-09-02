import zlib from "node:zlib";
import { createRequire } from "node:module";

const _require = createRequire(import.meta.url);

/**
 * Sanitizes raw PDF text — strips non-printable binary characters,
 * keeps unicode letters, numbers, punctuation, and whitespace.
 */
function sanitizePdfText(raw: string): string {
  return raw
    .replace(/[^\x20-\x7E\n\r\t\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF]/g, " ")
    .replace(/[ \t]{3,}/g, "  ")
    .replace(/\n{4,}/g, "\n\n")
    .trim();
}

/**
 * Clean raw PDF literal string from operator sequences
 */
function cleanPdfString(raw: string): string {
  return raw
    .replace(/\\([()\\])/g, "$1")
    .replace(/\\n/g, " ")
    .replace(/\\r/g, " ")
    .replace(/\\t/g, " ")
    .replace(/\\[0-7]{1,3}/g, " ")
    .trim();
}

/**
 * Fallback: Manual zlib stream decompression parser for PDFs
 */
function extractFromPdfFallback(buffer: Buffer): string {
  const textPieces: string[] = [];
  try {
    let startIdx = 0;
    while ((startIdx = buffer.indexOf("stream", startIdx)) !== -1) {
      let dataStart = startIdx + 6;
      if (buffer[dataStart] === 0x0d && buffer[dataStart + 1] === 0x0a) {
        dataStart += 2;
      } else if (buffer[dataStart] === 0x0a || buffer[dataStart] === 0x0d) {
        dataStart += 1;
      }
      const endIdx = buffer.indexOf("endstream", dataStart);
      if (endIdx === -1) break;
      const streamBytes = buffer.subarray(dataStart, endIdx);
      startIdx = endIdx + 9;
      if (streamBytes.length === 0) continue;

      let decompressed: Buffer | null = null;
      try { decompressed = zlib.inflateSync(streamBytes); } catch {
        try { decompressed = zlib.inflateRawSync(streamBytes); } catch {
          if (streamBytes[0] === 0x78) {
            try { decompressed = zlib.inflateRawSync(streamBytes.subarray(2)); } catch {}
          }
        }
      }

      const contentStr = (decompressed || streamBytes).toString("latin1");

      // (text) Tj
      for (const m of contentStr.match(/\(((?:[^()\\]|\\.)*)\)\s*Tj/g) || []) {
        const inner = m.match(/^\(((?:[^()\\]|\\.)*)\)\s*Tj$/);
        if (inner?.[1]) { const c = cleanPdfString(inner[1]); if (c.length > 0) textPieces.push(c); }
      }
      // [(text)] TJ
      for (const m of contentStr.match(/\[([\s\S]*?)\]\s*TJ/g) || []) {
        const inners = m.slice(1, -3).match(/\(((?:[^()\\]|\\.)*)\)/g) || [];
        const combined = inners.map(s => cleanPdfString(s.slice(1, -1))).join("");
        if (combined.trim()) textPieces.push(combined.trim());
      }
      // BT ... ET blocks
      for (const bt of contentStr.match(/BT[\s\S]*?ET/g) || []) {
        for (const s of bt.match(/\(((?:[^()\\]|\\.)*)\)/g) || []) {
          const c = cleanPdfString(s.slice(1, -1));
          if (c.length > 1 && !c.startsWith("/") && /[a-zA-Z0-9]/.test(c)) textPieces.push(c);
        }
      }
    }

    // Fallback parenthesis scan
    const rawLatin = buffer.toString("latin1");
    for (const p of rawLatin.match(/\(([^\r\n()]{3,200})\)/g) || []) {
      const c = cleanPdfString(p.slice(1, -1));
      if (c.length > 2 && /[a-zA-Z0-9]/.test(c) && !c.startsWith("/") && !c.startsWith("Font")) {
        textPieces.push(c);
      }
    }

    if (textPieces.length < 5) {
      const words = rawLatin.match(/[a-zA-Z0-9@:/.#+_-]{3,}/g) || [];
      textPieces.push(...words.filter(w => !/^(obj|endobj|stream|endstream|xref|trailer|startxref|Filter|FlateDecode|Length)$/i.test(w)));
    }
  } catch (err) {
    console.warn("PDF fallback extraction error:", err);
  }

  return textPieces.length > 0
    ? textPieces.join(" ").replace(/\s+/g, " ").trim()
    : "";
}

/**
 * Extracts plain text from a PDF Buffer.
 * Primary: pdf-parse@1.1.1 (uses pdfjs under the hood, handles fonts, CIDFonts, encoding)
 * Fallback: manual zlib stream decompression
 */
export async function extractTextFromPdfBuffer(buffer: Buffer): Promise<string> {
  try {
    const pdfParse = _require("pdf-parse");
    if (typeof pdfParse === "function") {
      const data = await pdfParse(buffer, { max: 0 });
      if (data?.text && data.text.trim().length > 20) {
        return sanitizePdfText(data.text);
      }
    }
  } catch (err) {
    console.warn("pdf-parse error, using fallback:", (err as Error).message);
  }

  const fallback = extractFromPdfFallback(buffer);
  return fallback ? sanitizePdfText(fallback) : "";
}
