import fs from "node:fs/promises";
import path from "node:path";

import {
  createReadToolDefinition,
  createWriteToolDefinition,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  defineTool,
  formatSize,
  type ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { summarizeCode, type SummaryResult } from "@oh-my-pi/pi-natives";
import {
  normalizeToLF,
  stripBom,
} from "../node_modules/@mariozechner/pi-coding-agent/dist/core/tools/edit-diff.js";
import {
  resolveReadPath,
} from "../node_modules/@mariozechner/pi-coding-agent/dist/core/tools/path-utils.js";
import { extractHarnessAttachmentText } from "../../harnesses/src/attachment-content.js";
import type { HarnessInputAttachmentPayload } from "../../harnesses/src/types.js";
import { openArchive, parseArchivePathCandidates } from "./pi-archive-reader.js";
import {
  HashlineSnapshotStore,
  normalizeDisplayPath,
} from "./pi-hashline-shared.js";

type LineRange = {
  startLine: number;
  endLine?: number;
};

const HASHLINE_HEADER_PREFIX = "¶";
const HASHLINE_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const HASHLINE_DOCUMENT_MIME_TYPES = new Map<string, string>([
  [".pdf", "application/pdf"],
  [".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  [".pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  [".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  [".xls", "application/vnd.ms-excel"],
]);
const HASHLINE_DIRECTORY_DEFAULT_LIMIT = 200;
const HASHLINE_MAX_DOCUMENT_CHARS = 120_000;
const HASHLINE_BINARY_SNIFF_BYTES = 1024;
const HASHLINE_SUMMARY_MAX_BYTES = 2 * 1024 * 1024;
const HASHLINE_SUMMARY_MAX_LINES = 20_000;
const HASHLINE_SUMMARY_MIN_TOTAL_LINES = 100;
const HASHLINE_SUMMARY_MIN_BODY_LINES = 4;
const HASHLINE_SUMMARY_MIN_COMMENT_LINES = 6;
const HASHLINE_SUMMARY_UNFOLD_UNTIL = 50;
const HASHLINE_SUMMARY_UNFOLD_LIMIT = 100;
const HASHLINE_SUMMARY_SAMPLE_RANGES = 2;
const HASHLINE_PROSE_SUMMARY_EXTENSIONS = new Set([".md", ".txt"]);
const HASHLINE_SELECTOR_RE = /^L?\d+(?:[-+]L?\d+|-)?(?:,L?\d+(?:[-+]L?\d+|-)?)*$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hashlineHeader(displayPath: string, tag: string): string {
  return `${HASHLINE_HEADER_PREFIX}${displayPath}#${tag}`;
}

const HASHLINE_LINE_PREFIX_RE = /^\s*\d+:(.*)$/;
const LOOSE_HASHLINE_HEADER_RE = /^\s*¶\S+#[^ \t\r\n]*\s*$/;

function splitLogicalLines(text: string): string[] {
  if (text.length === 0) {
    return [];
  }
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

function joinLogicalLines(lines: readonly string[], hadTrailingNewline: boolean): string {
  if (lines.length === 0) {
    return "";
  }
  const joined = lines.join("\n");
  return hadTrailingNewline ? `${joined}\n` : joined;
}

function splitPathAndSelector(rawPath: string): { path: string; selector?: string } {
  const colon = rawPath.lastIndexOf(":");
  if (colon <= 0) {
    return { path: rawPath };
  }
  const selector = rawPath.slice(colon + 1);
  if (!HASHLINE_SELECTOR_RE.test(selector)) {
    return { path: rawPath };
  }
  return {
    path: rawPath.slice(0, colon),
    selector,
  };
}

function parseLineRangeChunk(selector: string): LineRange | null {
  const match = /^L?(\d+)(?:([-+])L?(\d+)?)?$/i.exec(selector);
  if (!match) {
    return null;
  }
  const startLine = Number.parseInt(match[1] ?? "", 10);
  if (!Number.isInteger(startLine) || startLine < 1) {
    throw new Error(`Invalid line selector ${JSON.stringify(selector)}. Lines are 1-indexed.`);
  }
  const operator = match[2];
  const rhs = match[3] ? Number.parseInt(match[3], 10) : undefined;
  if (!operator) {
    return { startLine };
  }
  if (operator === "+") {
    if (rhs === undefined || rhs < 1) {
      throw new Error(`Invalid line selector ${JSON.stringify(selector)}. Count must be >= 1.`);
    }
    return { startLine, endLine: startLine + rhs - 1 };
  }
  if (rhs === undefined) {
    return { startLine };
  }
  if (rhs < startLine) {
    throw new Error(`Invalid line selector ${JSON.stringify(selector)}. End must be >= start.`);
  }
  return { startLine, endLine: rhs };
}

function parseLineRanges(selector: string): [LineRange, ...LineRange[]] | null {
  const ranges = selector
    .split(",")
    .map((chunk) => parseLineRangeChunk(chunk.trim()));
  if (ranges.some((range) => range === null)) {
    return null;
  }
  const parsed = ranges as LineRange[];
  if (parsed.length === 0) {
    return null;
  }
  parsed.sort((left, right) => left.startLine - right.startLine);
  const merged: LineRange[] = [parsed[0]!];
  for (let index = 1; index < parsed.length; index += 1) {
    const current = parsed[index]!;
    const previous = merged[merged.length - 1]!;
    if (previous.endLine === undefined) {
      continue;
    }
    if (current.startLine <= previous.endLine + 1) {
      if (current.endLine === undefined || current.endLine > previous.endLine) {
        merged[merged.length - 1] = { startLine: previous.startLine, endLine: current.endLine };
      }
      continue;
    }
    merged.push(current);
  }
  return merged as [LineRange, ...LineRange[]];
}

function selectorRangeToOffsetLimit(range: LineRange): { offset: number; limit?: number } {
  return {
    offset: range.startLine,
    limit: range.endLine === undefined ? undefined : Math.max(1, range.endLine - range.startLine + 1),
  };
}

function formatRangeLabel(range: LineRange): string {
  return range.endLine === undefined ? `${range.startLine}` : `${range.startLine}-${range.endLine}`;
}

function renderHashlineReadOutput(params: {
  displayPath: string;
  tag: string;
  allLines: readonly string[];
  offset?: number;
  limit?: number;
}): string {
  const startLine = params.offset && params.offset > 0 ? params.offset : 1;
  const startIndex = startLine - 1;
  if (params.allLines.length === 0) {
    return `${hashlineHeader(params.displayPath, params.tag)}\n[Empty file. Use BOF or EOF to insert content.]`;
  }
  if (startIndex >= params.allLines.length) {
    throw new Error(`Offset ${startLine} is beyond end of file (${params.allLines.length} lines total)`);
  }

  const requestedLimit = params.limit && params.limit > 0 ? Math.floor(params.limit) : Number.POSITIVE_INFINITY;
  const selectedLines = params.allLines.slice(startIndex, startIndex + requestedLimit);
  const rendered: string[] = [hashlineHeader(params.displayPath, params.tag)];
  let renderedBytes = Buffer.byteLength(`${rendered[0]}\n`, "utf-8");
  let renderedLineCount = 0;
  let nextLineNumber = startLine;

  for (const line of selectedLines) {
    const prefixed = `${nextLineNumber}:${line}`;
    const prefixedBytes = Buffer.byteLength(`${prefixed}\n`, "utf-8");
    const wouldExceedLines = renderedLineCount >= DEFAULT_MAX_LINES;
    const wouldExceedBytes = renderedBytes + prefixedBytes > DEFAULT_MAX_BYTES;
    if ((wouldExceedLines || wouldExceedBytes) && renderedLineCount > 0) {
      break;
    }
    if (wouldExceedBytes && renderedLineCount === 0) {
      const lineSize = formatSize(Buffer.byteLength(line, "utf-8"));
      rendered.push(
        `[Line ${nextLineNumber} is ${lineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use offset=${nextLineNumber} with a more targeted read.]`,
      );
      renderedLineCount = 1;
      nextLineNumber += 1;
      break;
    }
    rendered.push(prefixed);
    renderedBytes += prefixedBytes;
    renderedLineCount += 1;
    nextLineNumber += 1;
  }

  const renderedRangeEnd = nextLineNumber - 1;
  if (renderedLineCount === 0) {
    rendered.push("[No lines rendered.]");
  }
  if (renderedRangeEnd < params.allLines.length) {
    rendered.push(
      `[Showing lines ${startLine}-${renderedRangeEnd} of ${params.allLines.length}. Use offset=${renderedRangeEnd + 1} to continue.]`,
    );
  }
  return rendered.join("\n");
}

function renderHashlineMultiRangeReadOutput(params: {
  displayPath: string;
  tag: string;
  allLines: readonly string[];
  ranges: readonly LineRange[];
}): string {
  if (params.allLines.length === 0) {
    return `${hashlineHeader(params.displayPath, params.tag)}\n[Empty file. Use BOF or EOF to insert content.]`;
  }

  const rendered: string[] = [hashlineHeader(params.displayPath, params.tag)];
  let renderedBytes = Buffer.byteLength(`${rendered[0]}\n`, "utf-8");
  let renderedLineCount = 0;
  const notices: string[] = [];
  let emittedBlock = false;
  let exhausted = false;

  const pushRenderedLine = (line: string): boolean => {
    const withNewline = `${line}\n`;
    const bytes = Buffer.byteLength(withNewline, "utf-8");
    const wouldExceedLines = renderedLineCount >= DEFAULT_MAX_LINES;
    const wouldExceedBytes = renderedBytes + bytes > DEFAULT_MAX_BYTES;
    if ((wouldExceedLines || wouldExceedBytes) && renderedLineCount > 0) {
        exhausted = true;
        return false;
      }
      if (wouldExceedBytes && renderedLineCount === 0) {
        rendered.push(`[Selected output exceeds ${formatSize(DEFAULT_MAX_BYTES)}. Narrow the line ranges and retry.]`);
        renderedLineCount += 1;
        exhausted = true;
        return false;
      }
    rendered.push(line);
    renderedBytes += bytes;
    renderedLineCount += 1;
    return true;
  };

  for (const range of params.ranges) {
    if (exhausted) {
      break;
    }
    if (range.startLine > params.allLines.length) {
      notices.push(
        `[Range ${formatRangeLabel(range)} is beyond end of file (${params.allLines.length} lines total); skipped]`,
      );
      continue;
    }
    const effectiveEnd = Math.min(range.endLine ?? params.allLines.length, params.allLines.length);
    if (emittedBlock) {
      if (!pushRenderedLine("")) {
        break;
      }
      if (!pushRenderedLine("…")) {
        break;
      }
      if (!pushRenderedLine("")) {
        break;
      }
    }
    for (let lineNumber = range.startLine; lineNumber <= effectiveEnd; lineNumber += 1) {
      const line = params.allLines[lineNumber - 1] ?? "";
      if (!pushRenderedLine(`${lineNumber}:${line}`)) {
        break;
      }
    }
    emittedBlock = true;
  }

  for (const notice of notices) {
    if (!pushRenderedLine(notice)) {
      break;
    }
  }

  if (renderedLineCount === 0) {
    rendered.push("[No lines rendered.]");
  }
  return rendered.join("\n");
}

function renderNumberedReadOutput(params: {
  headerLines: readonly string[];
  bodyLines: readonly string[];
  offset?: number;
  limit?: number;
  emptyMessage: string;
  unitLabel: string;
}): string {
  const rendered: string[] = [...params.headerLines];
  const renderedHeader = rendered.join("\n");
  const headerPrefix = renderedHeader.length > 0 ? `${renderedHeader}\n` : "";
  const startLine = params.offset && params.offset > 0 ? Math.floor(params.offset) : 1;
  const startIndex = startLine - 1;
  if (params.bodyLines.length === 0) {
    return `${headerPrefix}${params.emptyMessage}`;
  }
  if (startIndex >= params.bodyLines.length) {
    throw new Error(`Offset ${startLine} is beyond end of ${params.unitLabel} (${params.bodyLines.length} total)`);
  }

  const requestedLimit = params.limit && params.limit > 0 ? Math.floor(params.limit) : Number.POSITIVE_INFINITY;
  const selectedLines = params.bodyLines.slice(startIndex, startIndex + requestedLimit);
  let renderedBytes = Buffer.byteLength(headerPrefix, "utf-8");
  let renderedLineCount = 0;
  let nextLineNumber = startLine;

  for (const line of selectedLines) {
    const prefixed = `${nextLineNumber}:${line}`;
    const prefixedBytes = Buffer.byteLength(`${prefixed}\n`, "utf-8");
    const wouldExceedLines = renderedLineCount >= DEFAULT_MAX_LINES;
    const wouldExceedBytes = renderedBytes + prefixedBytes > DEFAULT_MAX_BYTES;
    if ((wouldExceedLines || wouldExceedBytes) && renderedLineCount > 0) {
      break;
    }
    if (wouldExceedBytes && renderedLineCount === 0) {
      rendered.push(
        `[${params.unitLabel.slice(0, 1).toUpperCase()}${params.unitLabel.slice(1)} ${nextLineNumber} exceeds ${formatSize(DEFAULT_MAX_BYTES)} output limit. Use offset=${nextLineNumber} with a more targeted read.]`,
      );
      renderedLineCount = 1;
      nextLineNumber += 1;
      break;
    }
    rendered.push(prefixed);
    renderedBytes += prefixedBytes;
    renderedLineCount += 1;
    nextLineNumber += 1;
  }

  const renderedRangeEnd = nextLineNumber - 1;
  if (renderedLineCount === 0) {
    rendered.push("[No lines rendered.]");
  }
  if (renderedRangeEnd < params.bodyLines.length) {
    rendered.push(
      `[Showing ${params.unitLabel} ${startLine}-${renderedRangeEnd} of ${params.bodyLines.length}. Use offset=${renderedRangeEnd + 1} to continue.]`,
    );
  }
  return rendered.join("\n");
}

type SummaryRange = {
  startLine: number;
  endLine: number;
};

function formatSummaryFooter(displayPath: string, elidedRanges: readonly SummaryRange[]): string {
  if (elidedRanges.length === 0) {
    return "";
  }
  const elidedLines = elidedRanges.reduce((total, range) => total + (range.endLine - range.startLine + 1), 0);
  const selector = elidedRanges
    .slice(0, HASHLINE_SUMMARY_SAMPLE_RANGES)
    .map((range) => `${range.startLine}-${range.endLine}`)
    .join(",");
  const lineWord = elidedLines === 1 ? "line" : "lines";
  const example = `${displayPath}:${selector}`;
  const suffix = elidedRanges.length > HASHLINE_SUMMARY_SAMPLE_RANGES ? `, e.g. ${example}` : ` with ${example}`;
  return `[${elidedLines} ${lineWord} elided; re-read needed ranges${suffix}]`;
}

function renderSummaryReadOutput(params: {
  displayPath: string;
  tag: string;
  summary: SummaryResult;
}): string {
  const rendered: string[] = [hashlineHeader(params.displayPath, params.tag)];
  const elidedRanges: SummaryRange[] = [];
  let renderedBytes = Buffer.byteLength(`${rendered[0]}\n`, "utf-8");
  let renderedLineCount = 0;

  const pushRenderedLine = (line: string) => {
    const withNewline = `${line}\n`;
    const bytes = Buffer.byteLength(withNewline, "utf-8");
    const wouldExceedLines = renderedLineCount >= DEFAULT_MAX_LINES;
    const wouldExceedBytes = renderedBytes + bytes > DEFAULT_MAX_BYTES;
    if ((wouldExceedLines || wouldExceedBytes) && renderedLineCount > 0) {
      return false;
    }
    if (wouldExceedBytes && renderedLineCount === 0) {
      rendered.push(`[Summary output exceeds ${formatSize(DEFAULT_MAX_BYTES)}. Use offset/limit for a more targeted read.]`);
      renderedLineCount += 1;
      return false;
    }
    rendered.push(line);
    renderedBytes += bytes;
    renderedLineCount += 1;
    return true;
  };

  for (const segment of params.summary.segments) {
    if (segment.kind === "elided") {
      elidedRanges.push({ startLine: segment.startLine, endLine: segment.endLine });
      if (!pushRenderedLine(`[lines ${segment.startLine}-${segment.endLine} elided]`)) {
        break;
      }
      continue;
    }
    const text = segment.text ?? "";
    if (!text) {
      continue;
    }
    const lines = splitLogicalLines(text);
    for (let index = 0; index < lines.length; index += 1) {
      const lineNumber = segment.startLine + index;
      if (!pushRenderedLine(`${lineNumber}:${lines[index] ?? ""}`)) {
        break;
      }
    }
  }

  const footer = formatSummaryFooter(params.displayPath, elidedRanges);
  if (footer) {
    rendered.push(footer);
  }
  return rendered.join("\n");
}

function maybeRenderStructuralSummary(params: {
  displayPath: string;
  extension: string;
  sizeBytes: number;
  normalizedText: string;
  tag: string;
  offset?: number;
  limit?: number;
}): string | null {
  if (params.offset !== undefined || params.limit !== undefined) {
    return null;
  }
  if (params.sizeBytes > HASHLINE_SUMMARY_MAX_BYTES) {
    return null;
  }
  if (HASHLINE_PROSE_SUMMARY_EXTENSIONS.has(params.extension)) {
    return null;
  }
  const allLines = splitLogicalLines(params.normalizedText);
  if (allLines.length < HASHLINE_SUMMARY_MIN_TOTAL_LINES || allLines.length > HASHLINE_SUMMARY_MAX_LINES) {
    return null;
  }

  try {
    const summary = summarizeCode({
      code: params.normalizedText,
      path: params.displayPath,
      minBodyLines: HASHLINE_SUMMARY_MIN_BODY_LINES,
      minCommentLines: HASHLINE_SUMMARY_MIN_COMMENT_LINES,
      unfoldUntilLines: HASHLINE_SUMMARY_UNFOLD_UNTIL,
      unfoldLimitLines: HASHLINE_SUMMARY_UNFOLD_LIMIT,
    });
    if (!summary.parsed || !summary.elided) {
      return null;
    }
    return renderSummaryReadOutput({
      displayPath: params.displayPath,
      tag: params.tag,
      summary,
    });
  } catch {
    return null;
  }
}

function stripHashlinePrefixes(lines: readonly string[]): string[] {
  const cleaned: string[] = [];
  for (const line of lines) {
    if (LOOSE_HASHLINE_HEADER_RE.test(line)) {
      continue;
    }
    const prefixed = line.match(HASHLINE_LINE_PREFIX_RE);
    if (prefixed) {
      cleaned.push(prefixed[1] ?? "");
      continue;
    }
    cleaned.push(line);
  }
  return cleaned;
}

function stripWriteContentWithPotentialLooseHeader(content: string): { text: string; stripped: boolean } {
  const hadTrailingNewline = content.endsWith("\n");
  const lines = content.split("\n");
  const cleaned = stripHashlinePrefixes(lines);
  if (cleaned.length !== lines.length || cleaned.some((line, index) => line !== lines[index])) {
    return { text: joinLogicalLines(cleaned, hadTrailingNewline), stripped: true };
  }

  const headerIndex = lines.findIndex((line) => line.trim().length > 0);
  if (headerIndex === -1 || !LOOSE_HASHLINE_HEADER_RE.test(lines[headerIndex] ?? "")) {
    return { text: content, stripped: false };
  }

  const withoutHeader = lines.slice(0, headerIndex).concat(lines.slice(headerIndex + 1));
  const cleanedWithoutHeader = stripHashlinePrefixes(withoutHeader);
  if (cleanedWithoutHeader.length === withoutHeader.length &&
      cleanedWithoutHeader.every((line, index) => line === withoutHeader[index])) {
    return { text: content, stripped: false };
  }
  return { text: joinLogicalLines(cleanedWithoutHeader, hadTrailingNewline), stripped: true };
}

function isLikelyBinaryBuffer(buffer: Buffer): boolean {
  return buffer.subarray(0, Math.min(buffer.length, HASHLINE_BINARY_SNIFF_BYTES)).includes(0);
}

function syntheticReadAttachment(params: {
  absolutePath: string;
  displayPath: string;
  extension: string;
  sizeBytes: number;
}): HarnessInputAttachmentPayload {
  return {
    id: params.absolutePath,
    kind: "file",
    name: path.basename(params.absolutePath),
    mime_type: HASHLINE_DOCUMENT_MIME_TYPES.get(params.extension) ?? "application/octet-stream",
    size_bytes: params.sizeBytes,
    workspace_path: params.displayPath,
  };
}

function truncateDocumentText(text: string): { text: string; truncated: boolean } {
  if (text.length <= HASHLINE_MAX_DOCUMENT_CHARS) {
    return { text, truncated: false };
  }
  return {
    text: text.slice(0, HASHLINE_MAX_DOCUMENT_CHARS),
    truncated: true,
  };
}

async function renderDirectoryReadOutput(params: {
  absolutePath: string;
  displayPath: string;
  offset?: number;
  limit?: number;
}): Promise<string> {
  const entries = await fs.readdir(params.absolutePath, { withFileTypes: true });
  const bodyLines = entries
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" }))
    .map((entry) => {
      if (entry.isDirectory()) {
        return `${entry.name}/`;
      }
      if (entry.isSymbolicLink()) {
        return `${entry.name}@`;
      }
      return entry.name;
    });
  return renderNumberedReadOutput({
    headerLines: [
      `[Directory: ${params.displayPath}]`,
      `Entries: ${bodyLines.length}`,
      "",
    ],
    bodyLines,
    offset: params.offset,
    limit: params.limit ?? HASHLINE_DIRECTORY_DEFAULT_LIMIT,
    emptyMessage: "(empty directory)",
    unitLabel: "entries",
  });
}

function renderArchiveDirectoryReadOutput(params: {
  archiveDisplayPath: string;
  subPath: string;
  entries: readonly { name: string; isDirectory: boolean }[];
  offset?: number;
  limit?: number;
}): string {
  const bodyLines = params.entries.map((entry) => entry.isDirectory ? `${entry.name}/` : entry.name);
  const displayPath = params.subPath
    ? `${params.archiveDisplayPath}:${params.subPath.endsWith("/") ? params.subPath : `${params.subPath}/`}`
    : `${params.archiveDisplayPath}:/`;
  return renderNumberedReadOutput({
    headerLines: [
      `[Archive directory: ${displayPath}]`,
      `Entries: ${bodyLines.length}`,
      "",
    ],
    bodyLines,
    offset: params.offset,
    limit: params.limit ?? HASHLINE_DIRECTORY_DEFAULT_LIMIT,
    emptyMessage: "(empty directory)",
    unitLabel: "entries",
  });
}

async function renderDocumentReadOutput(params: {
  absolutePath: string;
  displayPath: string;
  extension: string;
  sizeBytes: number;
  offset?: number;
  limit?: number;
}): Promise<string> {
  const attachment = syntheticReadAttachment(params);
  const extractedText = await extractHarnessAttachmentText({
    attachment,
    absolutePath: params.absolutePath,
  });
  if (!extractedText) {
    throw new Error(`Unable to extract readable content from ${params.displayPath}`);
  }
  const truncated = truncateDocumentText(extractedText);
  const numbered = renderNumberedReadOutput({
    headerLines: [
      `[Document: ${attachment.name}]`,
      `Mime-Type: ${attachment.mime_type}`,
      `Path: ${params.displayPath}`,
      "",
    ],
    bodyLines: splitLogicalLines(normalizeToLF(truncated.text)),
    offset: params.offset,
    limit: params.limit,
    emptyMessage: "[document contained no readable text]",
    unitLabel: "lines",
  });
  if (!truncated.truncated) {
    return numbered;
  }
  return `${numbered}\n[document text truncated for read output]`;
}

function renderBinaryReadOutput(params: {
  displayPath: string;
  extension: string;
  sizeBytes: number;
}): string {
  const details = [
    `[Binary file: ${params.displayPath}]`,
    `Size: ${formatSize(params.sizeBytes)}`,
  ];
  if (params.extension) {
    details.push(`Extension: ${params.extension}`);
  }
  details.push(
    "This file type is not readable as plain text here. The read tool supports text files, directories, images, PDFs, DOCX, PPTX, XLSX, and XLS files.",
  );
  return details.join("\n");
}

type ResolvedArchiveReadPath = {
  absolutePath: string;
  archiveDisplayPath: string;
  archiveSubPath: string;
};

async function resolveArchiveReadPath(rawPath: string, cwd: string): Promise<ResolvedArchiveReadPath | null> {
  const candidates = parseArchivePathCandidates(rawPath);
  for (const candidate of candidates) {
    const absolutePath = resolveReadPath(candidate.archivePath, cwd);
    try {
      const stats = await fs.stat(absolutePath);
      if (!stats.isFile()) {
        continue;
      }
      return {
        absolutePath,
        archiveDisplayPath: normalizeDisplayPath(cwd, absolutePath),
        archiveSubPath: candidate.archivePath === rawPath ? "" : candidate.subPath,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        continue;
      }
      throw error;
    }
  }
  return null;
}

export function createPiHashlineToolDefinitions(cwd: string, store = new HashlineSnapshotStore()): ToolDefinition[] {
  const baseReadTool = createReadToolDefinition(cwd);
  const {
    renderCall: _baseWriteRenderCall,
    renderResult: _baseWriteRenderResult,
    ...baseWriteTool
  } = createWriteToolDefinition(cwd);

  const readTool = defineTool({
    ...baseReadTool,
    description:
      "Read files, directories, and common documents. Editable text results are returned as snapshot-tagged, line-numbered hashline output (`¶path#TAG` then `N:text`) so follow-up tools can refer back to the exact file view you read. The path may include line selectors like `src/app.ts:40-90,140-170` for targeted rereads. Plain code reads may return structural summaries that keep declarations and elide large bodies; re-read those ranges with selectors or offset/limit before changing them. Directories return numbered entry listings. Images are returned inline as attachments. PDFs, DOCX, PPTX, XLSX, and XLS files are converted into readable text output.",
    promptSnippet: "Read snapshot-tagged file contents for precise edits and full-file rewrites",
    promptGuidelines: [
      "Use read before editing. For exact replacement edits, copy the needed old text from read output; for full rewrites, you may paste hashline read output into write and it will strip the display prefixes automatically.",
      "For targeted rereads, prefer path selectors like `path/to/file.ts:40-90` or `path/to/file.ts:40-90,140-170`.",
      "Use offset/limit to continue large files instead of re-reading from the top.",
      "If read returns a structural summary with `[lines A-B elided]`, do a targeted follow-up read with a line selector before editing inside the elided body.",
      "If you copy numbered read output into a full-file rewrite, the write tool will strip the hashline header and line prefixes automatically.",
    ],
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const rawPath = String((params as { path: string }).path ?? "").trim();
      const explicitOffset = typeof (params as { offset?: number }).offset === "number"
        ? (params as { offset?: number }).offset
        : undefined;
      const explicitLimit = typeof (params as { limit?: number }).limit === "number"
        ? (params as { limit?: number }).limit
        : undefined;
      const resolvedArchivePath = await resolveArchiveReadPath(rawPath, cwd);
      const pathForSelectorSplit = resolvedArchivePath ? resolvedArchivePath.archiveSubPath : rawPath;
      const splitPath = splitPathAndSelector(pathForSelectorSplit);
      const selectorRanges = splitPath.selector ? parseLineRanges(splitPath.selector) : null;
      if (splitPath.selector && !selectorRanges) {
        throw new Error(`Invalid line selector in path ${JSON.stringify(rawPath)}.`);
      }
      if (selectorRanges && (explicitOffset !== undefined || explicitLimit !== undefined)) {
        throw new Error("Use either path selectors or offset/limit for read, not both in the same call.");
      }
      if (resolvedArchivePath) {
        const archive = await openArchive(resolvedArchivePath.absolutePath);
        const archiveNode = archive.getNode(splitPath.path);
        if (!archiveNode) {
          throw new Error(`Archive path not found: ${rawPath}`);
        }
        if (archiveNode.isDirectory) {
          if (selectorRanges) {
            throw new Error(`Line-range selectors require a file inside the archive, not directory ${JSON.stringify(rawPath)}.`);
          }
          return {
            content: [{
              type: "text",
              text: renderArchiveDirectoryReadOutput({
                archiveDisplayPath: resolvedArchivePath.archiveDisplayPath,
                subPath: splitPath.path,
                entries: archive.listDirectory(splitPath.path),
                offset: explicitOffset,
                limit: explicitLimit,
              }),
            }],
            details: undefined,
          };
        }
        const archiveFile = await archive.readFile(splitPath.path);
        const memberDisplayPath = `${resolvedArchivePath.archiveDisplayPath}:${archiveFile.path}`;
        const memberExtension = path.extname(archiveFile.path).toLowerCase();
        const memberAbsolutePath = `${resolvedArchivePath.absolutePath}:${archiveFile.path}`;
        const memberBuffer = Buffer.from(archiveFile.bytes);
        if (isLikelyBinaryBuffer(memberBuffer) || HASHLINE_DOCUMENT_MIME_TYPES.has(memberExtension)) {
          return {
            content: [{
              type: "text",
              text: renderBinaryReadOutput({
                displayPath: memberDisplayPath,
                extension: memberExtension,
                sizeBytes: archiveFile.size,
              }),
            }],
            details: undefined,
          };
        }
        const rawContent = memberBuffer.toString("utf-8");
        const { text } = stripBom(rawContent);
        const normalizedText = normalizeToLF(text);
        const tag = store.record({
          absolutePath: memberAbsolutePath,
          displayPath: memberDisplayPath,
          normalizedText,
        });
        const selectedRange = selectorRanges?.length === 1 ? selectorRangeToOffsetLimit(selectorRanges[0]!) : null;
        const offset = selectedRange?.offset ?? explicitOffset;
        const limit = selectedRange?.limit ?? explicitLimit;
        const outputText = (() => {
          const allLines = splitLogicalLines(normalizedText);
          if (selectorRanges && selectorRanges.length > 1) {
            return renderHashlineMultiRangeReadOutput({
              displayPath: memberDisplayPath,
              tag,
              allLines,
              ranges: selectorRanges,
            });
          }
          return maybeRenderStructuralSummary({
            displayPath: memberDisplayPath,
            extension: memberExtension,
            sizeBytes: archiveFile.size,
            normalizedText,
            tag,
            offset,
            limit,
          }) ?? renderHashlineReadOutput({
            displayPath: memberDisplayPath,
            tag,
            allLines,
            offset,
            limit,
          });
        })();
        return {
          content: [{ type: "text", text: outputText }],
          details: undefined,
        };
      }
      const absolutePath = resolveReadPath(splitPath.path, cwd);
      const stats = await fs.stat(absolutePath);
      const displayPath = normalizeDisplayPath(cwd, absolutePath);
      if (stats.isDirectory()) {
        if (selectorRanges) {
          throw new Error(`Line-range selectors require a regular file, not directory ${JSON.stringify(displayPath)}.`);
        }
        return {
          content: [{
            type: "text",
            text: await renderDirectoryReadOutput({
              absolutePath,
              displayPath,
              offset: explicitOffset,
              limit: explicitLimit,
            }),
          }],
          details: undefined,
        };
      }
      const extension = path.extname(absolutePath).toLowerCase();
      if (HASHLINE_IMAGE_EXTENSIONS.has(extension)) {
        return baseReadTool.execute(toolCallId, params, signal, onUpdate, ctx);
      }
      if (HASHLINE_DOCUMENT_MIME_TYPES.has(extension)) {
        if (selectorRanges) {
          throw new Error(`Line-range selectors are only supported for plain text code reads, not ${JSON.stringify(displayPath)}.`);
        }
        return {
          content: [{
            type: "text",
            text: await renderDocumentReadOutput({
              absolutePath,
              displayPath,
              extension,
              sizeBytes: stats.size,
              offset: explicitOffset,
              limit: explicitLimit,
            }),
          }],
          details: undefined,
        };
      }
      const rawBuffer = await fs.readFile(absolutePath);
      if (isLikelyBinaryBuffer(rawBuffer)) {
        return {
          content: [{
            type: "text",
            text: renderBinaryReadOutput({
              displayPath,
              extension,
              sizeBytes: stats.size,
            }),
          }],
          details: undefined,
        };
      }
      const rawContent = rawBuffer.toString("utf-8");
      const { text } = stripBom(rawContent);
      const normalizedText = normalizeToLF(text);
      const tag = store.record({ absolutePath, displayPath, normalizedText });
      const selectedRange = selectorRanges?.length === 1 ? selectorRangeToOffsetLimit(selectorRanges[0]!) : null;
      const offset = selectedRange?.offset ?? explicitOffset;
      const limit = selectedRange?.limit ?? explicitLimit;
      const outputText = (() => {
        const allLines = splitLogicalLines(normalizedText);
        if (selectorRanges && selectorRanges.length > 1) {
          return renderHashlineMultiRangeReadOutput({
            displayPath,
            tag,
            allLines,
            ranges: selectorRanges,
          });
        }
        return maybeRenderStructuralSummary({
          displayPath,
          extension,
          sizeBytes: stats.size,
          normalizedText,
          tag,
          offset,
          limit,
        }) ?? renderHashlineReadOutput({
          displayPath,
          tag,
          allLines,
          offset,
          limit,
        });
      })();
      return {
        content: [{ type: "text", text: outputText }],
        details: undefined,
      };
    },
  });

  const writeTool = defineTool({
    ...baseWriteTool,
    description:
      "Write content to a file. Creates the file if it doesn't exist and overwrites it if it does. If the content was copied from hashline read output (`¶path#TAG` and `N:text`), those display prefixes are stripped automatically before writing.",
    promptSnippet: "Create or overwrite files, including content copied from hashline read output",
    promptGuidelines: [
      "Use write for new files or complete rewrites.",
      "If you copied content from hashline read output, you may paste it directly; write will strip the `¶path#TAG` header and numbered line prefixes before writing.",
      "Do not write structural summary placeholders like `[lines A-B elided]`; re-read those ranges first.",
    ],
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const pathValue = String((params as { path?: string }).path ?? "");
      const contentValue = String((params as { content?: string }).content ?? "");
      const { text: cleanContent, stripped } = stripWriteContentWithPotentialLooseHeader(contentValue);
      const result = await baseWriteTool.execute(
        toolCallId,
        { ...(isRecord(params) ? params : {}), path: pathValue, content: cleanContent } as never,
        signal,
        onUpdate,
        ctx,
      );
      if (stripped) {
        const block = result.content.find((entry) => entry.type === "text");
        if (block && "text" in block && typeof block.text === "string") {
          block.text += "\nNote: auto-stripped hashline display prefixes from content before writing.";
        }
      }
      return result;
    },
  });

  return [readTool, writeTool];
}
