import zlib from "node:zlib";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/**
 * Clean raw PDF literal string
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
 * Decode PDF hexadecimal string <48656c6c6f>
 */
function decodeHexPdf(hex: string): string {
  let str = "";
  const cleanHex = hex.replace(/\s+/g, "");
  for (let i = 0; i < cleanHex.length; i += 2) {
    const code = parseInt(cleanHex.substr(i, 2), 16);
    if (!isNaN(code) && code >= 32 && code <= 126) {
      str += String.fromCharCode(code);
    } else if (code === 10 || code === 13 || code === 9) {
      str += " ";
    }
  }
  return str.trim();
}

/**
 * Fallback stream decompression parser
 */
function extractTextFromPdfBufferFallback(buffer: Buffer): string {
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
      try {
        decompressed = zlib.inflateSync(streamBytes);
      } catch {
        try {
          decompressed = zlib.inflateRawSync(streamBytes);
        } catch {
          if (streamBytes[0] === 0x78) {
            try {
              decompressed = zlib.inflateRawSync(streamBytes.subarray(2));
            } catch {}
          }
        }
      }

      const contentStr = (decompressed || streamBytes).toString("latin1");

      // Extract (text) Tj
      const tjMatches = contentStr.match(/\(((?:[^()\\]|\\.)*)\)\s*Tj/g) || [];
      for (const m of tjMatches) {
        const inner = m.match(/^\(((?:[^()\\]|\\.)*)\)\s*Tj$/);
        if (inner && inner[1]) {
          const clean = cleanPdfString(inner[1]);
          if (clean.length > 0) textPieces.push(clean);
        }
      }

      // Extract <hex> Tj
      const hexTjMatches = contentStr.match(/<([0-9a-fA-F\s]{4,})>\s*Tj/g) || [];
      for (const m of hexTjMatches) {
        const inner = m.match(/^<([0-9a-fA-F\s]{4,})>\s*Tj$/);
        if (inner && inner[1]) {
          const clean = decodeHexPdf(inner[1]);
          if (clean.length > 0) textPieces.push(clean);
        }
      }

      // Extract [(text)] TJ
      const tjArrMatches = contentStr.match(/\[([\s\S]*?)\]\s*TJ/g) || [];
      for (const m of tjArrMatches) {
        const rawArray = m.slice(1, -3);
        const inners = rawArray.match(/\(((?:[^()\\]|\\.)*)\)/g) || [];
        if (inners.length > 0) {
          const combined = inners.map(s => cleanPdfString(s.slice(1, -1))).join("");
          if (combined.trim().length > 0) textPieces.push(combined.trim());
        }
        const hexInners = rawArray.match(/<([0-9a-fA-F\s]{4,})>/g) || [];
        if (hexInners.length > 0) {
          const combinedHex = hexInners.map(s => decodeHexPdf(s.slice(1, -1))).join("");
          if (combinedHex.trim().length > 0) textPieces.push(combinedHex.trim());
        }
      }

      // Extract text in between BT ... ET
      const btMatches = contentStr.match(/BT[\s\S]*?ET/g) || [];
      for (const bt of btMatches) {
        const strMatches = bt.match(/\(((?:[^()\\]|\\.)*)\)/g) || [];
        for (const s of strMatches) {
          const clean = cleanPdfString(s.slice(1, -1));
          if (clean.length > 1 && !clean.startsWith("/") && /[a-zA-Z0-9]/.test(clean)) {
            textPieces.push(clean);
          }
        }
      }
    }

    const rawLatin = buffer.toString("latin1");
    const parenMatches = rawLatin.match(/\(([^\r\n()]{3,200})\)/g) || [];
    for (const p of parenMatches) {
      const clean = cleanPdfString(p.slice(1, -1));
      if (clean.length > 2 && /[a-zA-Z0-9]/.test(clean) && !clean.startsWith("/") && !clean.startsWith("Font")) {
        textPieces.push(clean);
      }
    }

    if (textPieces.length < 5) {
      const words = rawLatin.match(/[a-zA-Z0-9@:/.#+_-]{3,}/g) || [];
      const cleanWords = words.filter(w => !/^(obj|endobj|stream|endstream|xref|trailer|startxref|Filter|FlateDecode|Length)$/i.test(w));
      if (cleanWords.length > 10) {
        textPieces.push(...cleanWords);
      }
    }
  } catch (err) {
    console.warn("Server PDF fallback extraction error:", err);
  }

  if (textPieces.length > 0) {
    return textPieces.join(" ").replace(/\s+/g, " ").trim();
  }
  return "";
}

/**
 * Extracts plain text from a PDF Buffer using pdf-parse with fallback
 */
export async function extractTextFromPdfBuffer(buffer: Buffer): Promise<string> {
  try {
    const pdfParse = require("pdf-parse");
    const data = await pdfParse(buffer);
    if (data && typeof data.text === "string" && data.text.trim().length > 20) {
      return data.text.trim();
    }
  } catch (err) {
    console.warn("pdf-parse library notice:", err);
  }

  return extractTextFromPdfBufferFallback(buffer);
}
