import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createCodingTools } from "@mariozechner/pi-coding-agent";
import JSZip from "jszip";

import { createPiHashlineToolDefinitions } from "./pi-hashline-tools.js";

function createPdfBuffer(text: string): Buffer {
  const escapedText = text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const stream = `BT\n/F1 24 Tf\n72 120 Td\n(${escapedText}) Tj\nET`;
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n",
    `4 0 obj\n<< /Length ${Buffer.byteLength(stream, "utf8")} >>\nstream\n${stream}\nendstream\nendobj\n`,
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
  ];

  let output = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(output, "utf8"));
    output += object;
  }
  const xrefOffset = Buffer.byteLength(output, "utf8");
  output += `xref\n0 ${objects.length + 1}\n`;
  output += "0000000000 65535 f \n";
  for (const offset of offsets.slice(1)) {
    output += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(output, "utf8");
}

async function createDocxBuffer(lines: string[]): Promise<Buffer> {
  const zip = new JSZip();
  const body = lines.map((line) => `<w:p><w:r><w:t>${line}</w:t></w:r></w:p>`).join("");
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
  );
  return Buffer.from(await zip.generateAsync({ type: "uint8array" }));
}

async function createZipBuffer(entries: Array<{ path: string; content: string | Uint8Array }>): Promise<Buffer> {
  const zip = new JSZip();
  for (const entry of entries) {
    zip.file(entry.path, entry.content);
  }
  return Buffer.from(await zip.generateAsync({ type: "uint8array" }));
}

async function withTempWorkspace(fn: (workspaceDir: string) => Promise<void>) {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-hashline-tools-"));
  try {
    await fn(workspaceDir);
  } finally {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  }
}

function firstTextBlock(result: { content: Array<{ type: string; text?: string }> }): string {
  const block = result.content.find((entry) => entry.type === "text");
  assert.ok(block?.text);
  return block.text;
}

function extractHashlineHeader(text: string): string {
  const header = text.split("\n").find((line) => line.startsWith("¶"));
  assert.ok(header);
  return header;
}

function createSummarizableTsFile(): string {
  const sections: string[] = [];
  for (let index = 0; index < 20; index += 1) {
    sections.push(
      [
        `export function example${index}(input: string): string {`,
        `  const normalized = input.trim();`,
        `  const fallback = normalized || "item-${index}";`,
        `  const upper = fallback.toUpperCase();`,
        `  const suffix = upper.slice(0, 4);`,
        `  return \`${index}:\${suffix}\`;`,
        `}`,
        "",
      ].join("\n"),
    );
  }
  return sections.join("\n");
}

test("hashline read emits snapshot-tagged numbered output", async () => {
  await withTempWorkspace(async (workspaceDir) => {
    await fs.writeFile(
      path.join(workspaceDir, "example.ts"),
      'const first = 1;\nconst second = 2;\nconst third = 3;\n',
      "utf-8",
    );

    const [readTool] = createPiHashlineToolDefinitions(workspaceDir);
    const result = await readTool.execute(
      "call-1",
      { path: "example.ts", offset: 2, limit: 2 },
      undefined,
      undefined,
      {} as never,
    );
    const text = firstTextBlock(result);

    assert.match(text, /^¶example\.ts#[0-9A-F]{3}$/m);
    assert.match(text, /^2:const second = 2;$/m);
    assert.match(text, /^3:const third = 3;$/m);
  });
});

test("hashline read lists directory entries with pagination support", async () => {
  await withTempWorkspace(async (workspaceDir) => {
    await fs.mkdir(path.join(workspaceDir, "docs", "reports"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "docs", "notes.md"), "# notes\n", "utf-8");
    await fs.writeFile(path.join(workspaceDir, "docs", "todo.txt"), "ship it\n", "utf-8");

    const [readTool] = createPiHashlineToolDefinitions(workspaceDir);
    const result = await readTool.execute(
      "call-1",
      { path: "docs", offset: 2, limit: 1 },
      undefined,
      undefined,
      {} as never,
    );
    const text = firstTextBlock(result);

    assert.match(text, /^\[Directory: docs\]$/m);
    assert.match(text, /^Entries: 3$/m);
    assert.match(text, /^2:reports\/$/m);
    assert.match(text, /\[Showing entries 2-2 of 3\. Use offset=3 to continue\.\]$/m);
  });
});

test("hashline read extracts PDF content into readable text", async () => {
  await withTempWorkspace(async (workspaceDir) => {
    await fs.writeFile(path.join(workspaceDir, "summary.pdf"), createPdfBuffer("Hello PDF"));

    const [readTool] = createPiHashlineToolDefinitions(workspaceDir);
    const result = await readTool.execute(
      "call-1",
      { path: "summary.pdf" },
      undefined,
      undefined,
      {} as never,
    );
    const text = firstTextBlock(result);

    assert.match(text, /^\[Document: summary\.pdf\]$/m);
    assert.match(text, /^Mime-Type: application\/pdf$/m);
    assert.match(text, /^1:<pdf filename="summary\.pdf" pages="1">$/m);
    assert.match(text, /Hello PDF/);
  });
});

test("hashline read extracts DOCX content into readable text", async () => {
  await withTempWorkspace(async (workspaceDir) => {
    await fs.writeFile(
      path.join(workspaceDir, "notes.docx"),
      await createDocxBuffer(["Quarterly plan", "Ship the feature"]),
    );

    const [readTool] = createPiHashlineToolDefinitions(workspaceDir);
    const result = await readTool.execute(
      "call-1",
      { path: "notes.docx" },
      undefined,
      undefined,
      {} as never,
    );
    const text = firstTextBlock(result);

    assert.match(text, /^\[Document: notes\.docx\]$/m);
    assert.match(text, /^Mime-Type: application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document$/m);
    assert.match(text, /Quarterly plan/);
    assert.match(text, /Ship the feature/);
  });
});

test("hashline read lists archive root entries", async () => {
  await withTempWorkspace(async (workspaceDir) => {
    await fs.writeFile(
      path.join(workspaceDir, "bundle.zip"),
      await createZipBuffer([
        { path: "src/index.ts", content: "export const answer = 42;\n" },
        { path: "README.md", content: "# bundled\n" },
      ]),
    );

    const [readTool] = createPiHashlineToolDefinitions(workspaceDir);
    const result = await readTool.execute(
      "call-1",
      { path: "bundle.zip" },
      undefined,
      undefined,
      {} as never,
    );
    const text = firstTextBlock(result);

    assert.match(text, /^\[Archive directory: bundle\.zip:\/\]$/m);
    assert.match(text, /^Entries: 2$/m);
    assert.match(text, /^1:README\.md$/m);
    assert.match(text, /^2:src\/$/m);
  });
});

test("hashline read reads archive member text files with hashline headers", async () => {
  await withTempWorkspace(async (workspaceDir) => {
    await fs.writeFile(
      path.join(workspaceDir, "bundle.zip"),
      await createZipBuffer([
        {
          path: "src/index.ts",
          content: "export const answer = 42;\nconsole.log(answer);\n",
        },
      ]),
    );

    const [readTool] = createPiHashlineToolDefinitions(workspaceDir);
    const result = await readTool.execute(
      "call-1",
      { path: "bundle.zip:src/index.ts" },
      undefined,
      undefined,
      {} as never,
    );
    const text = firstTextBlock(result);

    assert.match(text, /^¶bundle\.zip:src\/index\.ts#[0-9A-F]{3}$/m);
    assert.match(text, /^1:export const answer = 42;$/m);
    assert.match(text, /^2:console\.log\(answer\);$/m);
  });
});

test("hashline read supports line selectors inside archive members", async () => {
  await withTempWorkspace(async (workspaceDir) => {
    await fs.writeFile(
      path.join(workspaceDir, "bundle.zip"),
      await createZipBuffer([
        {
          path: "src/index.ts",
          content: "line 1\nline 2\nline 3\nline 4\n",
        },
      ]),
    );

    const [readTool] = createPiHashlineToolDefinitions(workspaceDir);
    const result = await readTool.execute(
      "call-1",
      { path: "bundle.zip:src/index.ts:2-3" },
      undefined,
      undefined,
      {} as never,
    );
    const text = firstTextBlock(result);

    assert.match(text, /^¶bundle\.zip:src\/index\.ts#[0-9A-F]{3}$/m);
    assert.match(text, /^2:line 2$/m);
    assert.match(text, /^3:line 3$/m);
    assert.doesNotMatch(text, /^1:line 1$/m);
    assert.doesNotMatch(text, /^4:line 4$/m);
  });
});

test("hashline read reports unsupported binary files instead of decoding garbage", async () => {
  await withTempWorkspace(async (workspaceDir) => {
    await fs.writeFile(path.join(workspaceDir, "archive.bin"), Buffer.from([0x00, 0x01, 0x02, 0x03]));

    const [readTool] = createPiHashlineToolDefinitions(workspaceDir);
    const result = await readTool.execute(
      "call-1",
      { path: "archive.bin" },
      undefined,
      undefined,
      {} as never,
    );
    const text = firstTextBlock(result);

    assert.match(text, /^\[Binary file: archive\.bin\]$/m);
    assert.match(text, /^Extension: \.bin$/m);
    assert.match(text, /supports text files, directories, images, PDFs, DOCX, PPTX, XLSX, and XLS files\./);
  });
});

test("hashline read structurally summarizes long code files and adds targeted reread hints", async () => {
  await withTempWorkspace(async (workspaceDir) => {
    await fs.writeFile(path.join(workspaceDir, "summary-target.ts"), createSummarizableTsFile(), "utf-8");

    const [readTool] = createPiHashlineToolDefinitions(workspaceDir);
    const result = await readTool.execute(
      "call-1",
      { path: "summary-target.ts" },
      undefined,
      undefined,
      {} as never,
    );
    const text = firstTextBlock(result);

    assert.match(text, /^¶summary-target\.ts#[0-9A-F]{3}$/m);
    assert.match(text, /^1:export function example0\(input: string\): string \{$/m);
    assert.match(text, /^\[lines 2-6 elided\]$/m);
    assert.match(text, /^7:\}$/m);
    assert.match(
      text,
      /\[\d+ lines elided; re-read needed ranges(?: with|, e\.g\.) summary-target\.ts:2-6/,
    );
    assert.doesNotMatch(text, /2:  const normalized = input\.trim\(\);/);
  });
});

test("hashline read supports single-range path selectors", async () => {
  await withTempWorkspace(async (workspaceDir) => {
    await fs.writeFile(
      path.join(workspaceDir, "example.ts"),
      'const first = 1;\nconst second = 2;\nconst third = 3;\nconst fourth = 4;\n',
      "utf-8",
    );

    const [readTool] = createPiHashlineToolDefinitions(workspaceDir);
    const result = await readTool.execute(
      "call-1",
      { path: "example.ts:2-3" },
      undefined,
      undefined,
      {} as never,
    );
    const text = firstTextBlock(result);

    assert.match(text, /^¶example\.ts#[0-9A-F]{3}$/m);
    assert.match(text, /^2:const second = 2;$/m);
    assert.match(text, /^3:const third = 3;$/m);
    assert.doesNotMatch(text, /^1:const first = 1;$/m);
    assert.doesNotMatch(text, /^4:const fourth = 4;$/m);
  });
});

test("hashline read supports multi-range path selectors", async () => {
  await withTempWorkspace(async (workspaceDir) => {
    await fs.writeFile(
      path.join(workspaceDir, "example.ts"),
      [
        "line 1",
        "line 2",
        "line 3",
        "line 4",
        "line 5",
        "line 6",
        "",
      ].join("\n"),
      "utf-8",
    );

    const [readTool] = createPiHashlineToolDefinitions(workspaceDir);
    const result = await readTool.execute(
      "call-1",
      { path: "example.ts:2-3,6-6" },
      undefined,
      undefined,
      {} as never,
    );
    const text = firstTextBlock(result);

    assert.match(text, /^¶example\.ts#[0-9A-F]{3}$/m);
    assert.match(text, /^2:line 2$/m);
    assert.match(text, /^3:line 3$/m);
    assert.match(text, /^6:line 6$/m);
    assert.match(text, /^\u2026$/m);
    assert.doesNotMatch(text, /^4:line 4$/m);
    assert.doesNotMatch(text, /^5:line 5$/m);
  });
});

test("hashline read bypasses structural summaries when offset or limit is provided", async () => {
  await withTempWorkspace(async (workspaceDir) => {
    await fs.writeFile(path.join(workspaceDir, "summary-target.ts"), createSummarizableTsFile(), "utf-8");

    const [readTool] = createPiHashlineToolDefinitions(workspaceDir);
    const result = await readTool.execute(
      "call-1",
      { path: "summary-target.ts", offset: 2, limit: 3 },
      undefined,
      undefined,
      {} as never,
    );
    const text = firstTextBlock(result);

    assert.match(text, /^2:  const normalized = input\.trim\(\);$/m);
    assert.match(text, /^3:  const fallback = normalized \|\| "item-0";$/m);
    assert.match(text, /^4:  const upper = fallback\.toUpperCase\(\);$/m);
    assert.doesNotMatch(text, /\[lines 2-6 elided\]/);
    assert.doesNotMatch(text, /re-read needed ranges using offset\/limit/);
  });
});

test("hashline write strips copied read prefixes before rewriting file content", async () => {
  await withTempWorkspace(async (workspaceDir) => {
    const sourcePath = path.join(workspaceDir, "source.ts");
    const targetPath = path.join(workspaceDir, "target.ts");
    await fs.writeFile(
      sourcePath,
      'export const answer = 42;\nconsole.log(answer);\n',
      "utf-8",
    );

    const [readTool, writeTool] = createPiHashlineToolDefinitions(workspaceDir);
    const readResult = await readTool.execute(
      "call-1",
      { path: "source.ts" },
      undefined,
      undefined,
      {} as never,
    );
    const content = firstTextBlock(readResult);
    const writeResult = await writeTool.execute(
      "call-2",
      { path: "target.ts", content },
      undefined,
      undefined,
      {} as never,
    );

    assert.equal(
      await fs.readFile(targetPath, "utf-8"),
      'export const answer = 42;\nconsole.log(answer);',
    );
    assert.match(
      firstTextBlock(writeResult),
      /^Successfully wrote \d+ bytes to target\.ts\nNote: auto-stripped hashline display prefixes from content before writing\.$/m,
    );
  });
});

test("base edit remains the exact-replacement tool after hashline read/write overrides", async () => {
  await withTempWorkspace(async (workspaceDir) => {
    const filePath = path.join(workspaceDir, "greet.ts");
    await fs.writeFile(
      filePath,
      'export function greet(name: string): string {\n  return `Hello, ${name}!`;\n}\n',
      "utf-8",
    );

    const [readTool] = createPiHashlineToolDefinitions(workspaceDir);
    const readResult = await readTool.execute(
      "call-1",
      { path: "greet.ts" },
      undefined,
      undefined,
      {} as never,
    );
    const text = firstTextBlock(readResult);
    assert.match(text, /^¶greet\.ts#[0-9A-F]{3}$/m);
    assert.match(text, /^2:  return `Hello, \$\{name\}!`;$/m);

    const editTool = createCodingTools(workspaceDir).find((tool) => tool.name === "edit");
    assert.ok(editTool, "expected the base exact-replacement edit tool");

    const editResult = await editTool.execute(
      "call-2",
      {
        path: "greet.ts",
        edits: [
          {
            oldText: "  return `Hello, ${name}!`;",
            newText: '  if (!name) return "Hello, stranger!";\n  return `Hello, ${name}!`;',
          },
        ],
      },
      undefined,
      undefined,
    );

    assert.equal(
      await fs.readFile(filePath, "utf-8"),
      'export function greet(name: string): string {\n  if (!name) return "Hello, stranger!";\n  return `Hello, ${name}!`;\n}\n',
    );
    assert.match(firstTextBlock(editResult), /^Successfully replaced 1 block\(s\) in greet\.ts\.$/m);
    assert.match(
      String((editResult.details as { diff?: string } | undefined)?.diff ?? ""),
      /\+2   if \(!name\) return "Hello, stranger!";/,
    );
  });
});
