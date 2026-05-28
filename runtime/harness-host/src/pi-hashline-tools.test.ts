import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createPiHashlineToolDefinitions } from "./pi-hashline-tools.js";

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

test("hashline edit applies anchored patches and returns the next snapshot tag", async () => {
  await withTempWorkspace(async (workspaceDir) => {
    const filePath = path.join(workspaceDir, "greet.ts");
    await fs.writeFile(
      filePath,
      'export function greet(name: string): string {\n  return `Hello, ${name}!`;\n}\n',
      "utf-8",
    );

    const [readTool, editTool] = createPiHashlineToolDefinitions(workspaceDir);
    const readResult = await readTool.execute(
      "call-1",
      { path: "greet.ts" },
      undefined,
      undefined,
      {} as never,
    );
    const header = extractHashlineHeader(firstTextBlock(readResult));
    const editInput = [
      header,
      "1 3",
      "&1",
      '+  if (!name) return "Hello, stranger!";',
      "&2..3",
    ].join("\n");

    const editResult = await editTool.execute(
      "call-2",
      { input: editInput },
      undefined,
      undefined,
      {} as never,
    );

    assert.equal(
      await fs.readFile(filePath, "utf-8"),
      'export function greet(name: string): string {\n  if (!name) return "Hello, stranger!";\n  return `Hello, ${name}!`;\n}\n',
    );
    assert.match(firstTextBlock(editResult), /^Updated greet\.ts\.\nNext snapshot: ¶greet\.ts#[0-9A-F]{3}$/m);
    assert.match(
      String((editResult.details as { diff?: string } | undefined)?.diff ?? ""),
      /\+2   if \(!name\) return "Hello, stranger!";/,
    );
  });
});

test("hashline edit rejects stale snapshot tags after the file changes", async () => {
  await withTempWorkspace(async (workspaceDir) => {
    const filePath = path.join(workspaceDir, "counter.ts");
    await fs.writeFile(filePath, "let count = 1;\n", "utf-8");

    const [readTool, editTool] = createPiHashlineToolDefinitions(workspaceDir);
    const readResult = await readTool.execute(
      "call-1",
      { path: "counter.ts" },
      undefined,
      undefined,
      {} as never,
    );
    const header = extractHashlineHeader(firstTextBlock(readResult));

    await fs.writeFile(filePath, "let count = 2;\n", "utf-8");

    await assert.rejects(
      editTool.execute(
        "call-2",
        { input: `${header}\n1\n+let count = 3;` },
        undefined,
        undefined,
        {} as never,
      ),
      /Stale hashline snapshot/,
    );
  });
});

test("hashline edit preflights multi-file patches before writing", async () => {
  await withTempWorkspace(async (workspaceDir) => {
    const firstPath = path.join(workspaceDir, "first.ts");
    const secondPath = path.join(workspaceDir, "second.ts");
    await fs.writeFile(firstPath, "const first = 1;\n", "utf-8");
    await fs.writeFile(secondPath, "const second = 2;\n", "utf-8");

    const [readTool, editTool] = createPiHashlineToolDefinitions(workspaceDir);
    const firstHeader = extractHashlineHeader(firstTextBlock(await readTool.execute(
      "call-1",
      { path: "first.ts" },
      undefined,
      undefined,
      {} as never,
    )));
    const secondHeader = extractHashlineHeader(firstTextBlock(await readTool.execute(
      "call-2",
      { path: "second.ts" },
      undefined,
      undefined,
      {} as never,
    )));

    await fs.writeFile(secondPath, "const second = 20;\n", "utf-8");

    const multiFilePatch = [
      firstHeader,
      "1",
      "+const first = 10;",
      "",
      secondHeader,
      "1",
      "+const second = 30;",
    ].join("\n");

    await assert.rejects(
      editTool.execute(
        "call-3",
        { input: multiFilePatch },
        undefined,
        undefined,
        {} as never,
      ),
      /Stale hashline snapshot/,
    );
    assert.equal(await fs.readFile(firstPath, "utf-8"), "const first = 1;\n");
  });
});
