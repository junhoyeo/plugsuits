import { lstat, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { tool } from "ai";
import { z } from "zod";
import { assertWriteSafety } from "../utils/safety-utils";
import WRITE_FILE_DESCRIPTION from "./write-file.txt";

const inputSchema = z.object({
  path: z.string().describe("File path (absolute or relative)"),
  content: z.string().describe("Content to write"),
});

export type WriteFileInput = z.infer<typeof inputSchema>;

export interface WriteFileOptions {
  /** Override project root for safety checks (defaults to process.cwd()). */
  rootDir?: string;
}

export async function executeWriteFile(
  { path, content }: WriteFileInput,
  options?: WriteFileOptions
): Promise<string> {
  // C-1 + C-2: Path traversal and symlink safety checks
  const safePath = await assertWriteSafety(path, options?.rootDir);

  const dir = dirname(safePath);
  if (dir !== ".") {
    await mkdir(dir, { recursive: true });
  }

  // H-1: Use lstat (not stat) to avoid following symlinks for existence check,
  // then atomic temp-file + rename to eliminate TOCTOU race window.
  let existed = false;
  try {
    const stats = await lstat(safePath);
    existed = true;
    // Belt-and-suspenders: reject symlinks even after assertWriteSafety
    if (stats.isSymbolicLink()) {
      throw new Error(
        `Refusing to write through symlink: '${path}'. ` +
          "Use the real path instead."
      );
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("symlink")) {
      throw error;
    }
    // ENOENT is expected for new files
    existed = false;
  }

  // Atomic write: write to temp file, then rename onto target.
  // rename() replaces the directory entry atomically on POSIX,
  // so even if a symlink is swapped in between lstat and rename,
  // the rename overwrites the symlink itself (does not follow it).
  const tmpSuffix = `.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const tmpPath = `${safePath}${tmpSuffix}`;
  try {
    await writeFile(tmpPath, content, "utf-8");
    await rename(tmpPath, safePath);
  } catch (error) {
    // Clean up temp file on failure
    try {
      await unlink(tmpPath);
    } catch {
      /* ignore cleanup errors */
    }
    throw error;
  }

  const lines = content.split("\n");
  const lineCount = lines.length;
  const byteCount = Buffer.byteLength(content, "utf-8");
  const fileName = basename(path);
  const action = existed ? "overwrote" : "created";

  const output = [
    `OK - ${action} ${fileName}`,
    `bytes: ${byteCount}, lines: ${lineCount}`,
  ];

  return output.join("\n");
}

export const writeFileTool = tool({
  description: WRITE_FILE_DESCRIPTION,
  inputSchema,
  execute: (input) => executeWriteFile(input),
});
