const FRAME_PATTERN =
  /(?:re:)?P(?:(\d+))?\s*,\s*([0-9a-f]{4})\s*,\s*(\d+(?:\.\d+)?)\s*cm(?:\s*,\s*(-?\d+(?:\.\d+)?)\s*dB)?/gi;
const FRAME_START_PATTERN = /(?:re:)?P(?:\d+)?\s*,/gi;

export function parseUwbFrames(text) {
  const source = String(text ?? "");
  const frames = [];
  let match;

  FRAME_PATTERN.lastIndex = 0;
  while ((match = FRAME_PATTERN.exec(source)) !== null) {
    const linkIndex = match[1] === undefined ? null : Number(match[1]);
    frames.push({
      raw: match[0].trim(),
      linkIndex,
      device: linkIndex === null ? null : linkIndex + 1,
      address: match[2].toUpperCase(),
      distanceCm: Number(match[3]),
      snrDb: match[4] === undefined ? null : Number(match[4]),
    });
  }

  return frames;
}

function nextLineBreak(buffer) {
  const carriage = buffer.indexOf("\r");
  const lineFeed = buffer.indexOf("\n");
  if (carriage === -1) {
    return lineFeed;
  }
  if (lineFeed === -1) {
    return carriage;
  }
  return Math.min(carriage, lineFeed);
}

function removeLineBreak(buffer, index) {
  let next = index;
  while (buffer[next] === "\r" || buffer[next] === "\n") {
    next += 1;
  }
  return buffer.slice(next);
}

function splitCandidate(candidate) {
  const trimmed = candidate.trim();
  if (!trimmed) {
    return [];
  }

  const frames = parseUwbFrames(trimmed);
  if (frames.length > 0) {
    return frames.map((frame) => ({ kind: "frame", ...frame }));
  }
  return [{ kind: "text", raw: trimmed }];
}

export class UwbStreamParser {
  constructor() {
    this.buffer = "";
  }

  push(chunk) {
    this.buffer += String(chunk ?? "").replaceAll("\0", "");
    const messages = [];

    while (this.buffer.length > 0) {
      const lineBreak = nextLineBreak(this.buffer);
      if (lineBreak >= 0) {
        messages.push(...splitCandidate(this.buffer.slice(0, lineBreak)));
        this.buffer = removeLineBreak(this.buffer, lineBreak);
        continue;
      }

      FRAME_START_PATTERN.lastIndex = 0;
      const starts = [...this.buffer.matchAll(FRAME_START_PATTERN)];
      if (starts.length >= 2) {
        const splitAt = starts[1].index;
        messages.push(...splitCandidate(this.buffer.slice(0, splitAt)));
        this.buffer = this.buffer.slice(splitAt);
        continue;
      }

      const completeWithSnr =
        /(?:re:)?P(?:\d+)?\s*,\s*[0-9a-f]{4}\s*,\s*\d+(?:\.\d+)?\s*cm\s*,\s*-?\d+(?:\.\d+)?\s*dB\s*$/i;
      if (completeWithSnr.test(this.buffer)) {
        messages.push(...splitCandidate(this.buffer));
        this.buffer = "";
        continue;
      }

      if (this.buffer.length > 8192) {
        messages.push({ kind: "text", raw: this.buffer.slice(0, 4096) });
        this.buffer = this.buffer.slice(4096);
      }
      break;
    }

    return messages;
  }

  flush() {
    const messages = splitCandidate(this.buffer);
    this.buffer = "";
    return messages;
  }
}
