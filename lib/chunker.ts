/**
 * Splits a chapter into pieces small enough for one model request each.
 *
 * A full web-novel chapter runs to tens of thousands of characters, and one
 * request that size risks truncation and timeouts. Splitting on paragraph
 * boundaries keeps every scene intact, and the chunks go back together in the
 * order they were read.
 *
 * Free of `server-only` so the test harness can reach it directly.
 */

/** Target size of one request, in characters. Roughly 3,000-4,000 words. */
export const DEFAULT_CHUNK_SIZE = 14_000;

/** A hard ceiling, so one enormous paragraph cannot build a request from itself. */
export const MAX_CHUNK_SIZE = 20_000;

/** A paragraph this short is a line of dialogue, so it is too small to split on. */
const MIN_PARAGRAPH = 120;

export interface Chunk {
  /** Position in the original, starting at zero. */
  index: number;
  /** The text handed to the model. */
  text: string;
  /** How many characters this chunk is. */
  size: number;
}

function splitParagraphs(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Breaks one oversized paragraph at sentence boundaries.
 *
 * A translator's wall of unbroken dialogue would otherwise become a single
 * request larger than the ceiling. Sentences are kept whole; only the last one
 * that would overflow is carried into the next piece.
 */
function splitLongParagraph(paragraph: string, limit: number): string[] {
  if (paragraph.length <= limit) return [paragraph];

  const sentences = paragraph.match(/[^.!?…]+[.!?…]+["'”’)]*|\S[^.!?…]*$/g) ?? [paragraph];
  const pieces: string[] = [];
  let current = "";

  for (const sentence of sentences) {
    if (current && current.length + sentence.length + 1 > limit) {
      pieces.push(current.trim());
      current = "";
    }
    current += (current ? " " : "") + sentence;
  }

  if (current.trim()) pieces.push(current.trim());
  return pieces.length > 0 ? pieces : [paragraph];
}

/**
 * Groups paragraphs into chunks of at most `size` characters.
 *
 * Short paragraphs accumulate until the next one would overflow, so a run of
 * one-line dialogue stays in one request with the passage it belongs to.
 */
export function chunkText(
  text: string,
  size: number = DEFAULT_CHUNK_SIZE,
): Chunk[] {
  const limit = Math.max(MIN_PARAGRAPH, Math.min(size, MAX_CHUNK_SIZE));
  const paragraphs = splitParagraphs(text);

  if (paragraphs.length === 0) return [];

  const pieces: string[] = [];
  for (const paragraph of paragraphs) {
    // A paragraph past the ceiling becomes several, and each is placed
    // independently so the order still reads as the original.
    const parts =
      paragraph.length > limit
        ? splitLongParagraph(paragraph, limit)
        : [paragraph];
    pieces.push(...parts);
  }

  const chunks: Chunk[] = [];
  let buffer: string[] = [];
  let buffered = 0;

  for (const piece of pieces) {
    if (buffer.length > 0 && buffered + piece.length + 2 > limit) {
      chunks.push({
        index: chunks.length,
        text: buffer.join("\n\n"),
        size: buffer.join("\n\n").length,
      });
      buffer = [];
      buffered = 0;
    }
    buffer.push(piece);
    buffered += piece.length + 2;
  }

  if (buffer.length > 0) {
    const text_ = buffer.join("\n\n");
    chunks.push({ index: chunks.length, text: text_, size: text_.length });
  }

  return chunks;
}

/** True when a chapter has to be split across more than one request. */
export function needsChunking(text: string, size: number = DEFAULT_CHUNK_SIZE): boolean {
  return chunkText(text, size).length > 1;
}

/** Puts the finished chunks back together as one chapter. */
export function joinChunks(chunks: string[]): string {
  return chunks
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .join("\n\n");
}
