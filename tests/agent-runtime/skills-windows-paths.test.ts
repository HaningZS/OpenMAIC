import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const actualSkillsRoot = join(process.cwd(), 'skills/agent-runtime');
const windowsSkillsRoot = 'C:\\repo\\OpenMAIC\\skills\\agent-runtime';

function windowsPath(value: string) {
  const normalized = value.replaceAll('\\', '/');
  if (normalized.startsWith(actualSkillsRoot)) {
    return `${windowsSkillsRoot}${normalized.slice(actualSkillsRoot.length).replaceAll('/', '\\')}`;
  }
  return value.replaceAll('/', '\\');
}

function nativePath(value: string) {
  const normalized = value.replaceAll('\\', '/');
  const normalizedWindowsRoot = windowsSkillsRoot.replaceAll('\\', '/');
  if (normalized.startsWith(normalizedWindowsRoot)) {
    return `${actualSkillsRoot}${normalized.slice(normalizedWindowsRoot.length)}`;
  }
  return normalized;
}

type TestStats = Awaited<ReturnType<typeof lstat>>;

function windowsFileInfo(path: string, stats: TestStats) {
  const windowsStylePath = windowsPath(path);
  const kind = stats.isFile()
    ? 'file'
    : stats.isDirectory()
      ? 'directory'
      : stats.isSymbolicLink()
        ? 'symlink'
        : 'other';
  return {
    // pi-agent-core 0.78.0 derives this with a forward-slash-only split.
    name: windowsStylePath.replace(/\/+$/, '').split('/').pop() ?? windowsStylePath,
    path: windowsStylePath,
    kind,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
  };
}

function fileFailure(error: unknown, path: string) {
  const cause = error as NodeJS.ErrnoException;
  return {
    ok: false as const,
    error: {
      code: cause.code === 'ENOENT' ? 'not_found' : 'unknown',
      message: cause.message ?? String(error),
      path,
    },
  };
}

/**
 * Simulate the path-shaped results returned by NodeExecutionEnv on Windows.
 * Files are still read from this checkout, so the regression is deterministic
 * on every CI host and exercises OpenMAIC's real listSkills() boundary.
 */
class WindowsPathNodeExecutionEnv {
  cwd: string;

  constructor(options: { cwd: string }) {
    this.cwd = windowsPath(options.cwd);
  }

  async fileInfo(path: string) {
    const resolved = nativePath(path);
    try {
      return { ok: true as const, value: windowsFileInfo(resolved, await lstat(resolved)) };
    } catch (error) {
      return fileFailure(error, path);
    }
  }

  async listDir(path: string) {
    const resolved = nativePath(path);
    try {
      const entries = await readdir(resolved, { withFileTypes: true });
      const value = await Promise.all(
        entries.map(async (entry) => {
          const entryPath = join(resolved, entry.name);
          return windowsFileInfo(entryPath, await lstat(entryPath));
        }),
      );
      return { ok: true as const, value };
    } catch (error) {
      return fileFailure(error, path);
    }
  }

  async readTextFile(path: string) {
    const resolved = nativePath(path);
    try {
      return { ok: true as const, value: await readFile(resolved, 'utf8') };
    } catch (error) {
      return fileFailure(error, path);
    }
  }
}

describe('Windows built-in skill discovery', () => {
  afterEach(() => {
    vi.doUnmock('@earendil-works/pi-agent-core/node');
    vi.doUnmock('@/lib/logger');
    vi.resetModules();
  });

  it('loads every shipped skill when Node reports backslash-separated paths', async () => {
    vi.doMock('@earendil-works/pi-agent-core/node', () => ({
      NodeExecutionEnv: WindowsPathNodeExecutionEnv,
    }));
    vi.doMock('@/lib/logger', () => ({
      createLogger: () => ({
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      }),
    }));
    const { listSkills } = await import('@/lib/server/agent-runtime/skills');
    const expectedIds = (await readdir(actualSkillsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    const loaded = await listSkills();

    expect(loaded.map((skill) => skill.id).sort()).toEqual(expectedIds);
    expect(loaded.every((skill) => !skill.filePath.includes('\\'))).toBe(true);
  });
});
