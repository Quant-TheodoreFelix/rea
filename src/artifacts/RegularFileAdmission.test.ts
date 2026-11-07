import type { BigIntStats, Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import {
  isSelectedRegularFileError,
  NonRegularFileReadError,
  openRegularFile,
  RegularFileAdmissionFailure,
  RegularFileOperationCancelled,
  RegularFileSymlinkRefusalError,
  resolveRefusedSymlink,
  sameRegularFileState,
} from "../filesystem/RegularFile.js";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";

const { mockOpen } = vi.hoisted(() => ({ mockOpen: vi.fn() }));

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  open: mockOpen,
}));

afterEach(() => mockOpen.mockReset());

it("returns the original validated metadata snapshot with its actual descriptor", async () => {
  const { open } =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  const root = await createTestTempDirectory("rea-admission-snapshot-");
  const path = join(root, "selected.bin");
  const original = Buffer.from("admitted α测试\0\n");
  await writeFile(path, original);
  let validated: Stats | undefined;
  let opened: FileHandle | undefined;
  mockOpen.mockImplementationOnce(async (...args: Parameters<typeof open>) => {
    const handle = await open(...args);
    opened = handle;
    const stat = handle.stat.bind(handle);
    vi.spyOn(handle, "stat").mockImplementationOnce(async () => {
      validated = await stat();
      return validated;
    });
    return handle;
  });
  const descriptor = await openRegularFile(path, { symlinks: "reject" });
  try {
    expect(descriptor.handle).toBe(opened);
    expect(descriptor.initial).toBe(validated);
    expect(descriptor.initial.size).toBe(original.length);
    await writeFile(
      path,
      "a later, longer replacement extent on the same inode",
    );
    expect(descriptor.initial).toBe(validated);
    expect(descriptor.initial.size).toBe(original.length);
    expect(descriptor.handle.stat).toHaveBeenCalledOnce();
  } finally {
    await descriptor.handle.close();
  }
});

it.each(["cancellation after open", "non-regular metadata", "stat failure"])(
  "retains the exact owner when close fails after %s",
  async (failureCase) => {
    const closeFailure = new Error("native close failed");
    const statFailure = new Error("descriptor stat failed");
    const cancellation = new Error("cancelled after open");
    const controller = new AbortController();
    const file = {
      fd: 17,
      stat: vi.fn(async () => {
        if (failureCase === "cancellation after open") {
          controller.abort(cancellation);
          return { isFile: () => true } as Stats;
        }
        if (failureCase === "non-regular metadata")
          return {
            isFile: () => false,
            isDirectory: () => false,
          } as Stats;
        throw statFailure;
      }),
      close: vi.fn(async () => {
        file.fd = -1;
        throw closeFailure;
      }),
    };
    mockOpen.mockResolvedValue(file as unknown as FileHandle);

    const cause = await openRegularFile("/selected/input", {
      symlinks: "reject",
      signal: controller.signal,
    }).catch((failure: unknown) => failure);

    expect(cause).toBeInstanceOf(RegularFileAdmissionFailure);
    if (!(cause instanceof RegularFileAdmissionFailure))
      throw new Error("Expected an admission failure that retains its owner");
    expect(cause.owner.handle).toBe(file);
    expect(cause.cleanupCause).toBe(closeFailure);
    expect(file.close).toHaveBeenCalledTimes(1);
    await expect(cause.owner.close()).rejects.toBe(closeFailure);
    expect(file.close).toHaveBeenCalledTimes(1);

    if (failureCase === "non-regular metadata")
      expect(cause.cause).toBeInstanceOf(NonRegularFileReadError);
    else if (failureCase === "stat failure")
      expect(cause.cause).toBe(statFailure);
    else {
      expect(cause.cause).toBeInstanceOf(RegularFileOperationCancelled);
      expect(cause.cause).toMatchObject({ reason: cancellation });
    }
  },
);

it("compares available nanosecond timestamps without rounding away source changes", () => {
  const before = {
    dev: 1n,
    ino: 2n,
    size: 3n,
    mode: 0o100400n,
    mtimeMs: 10n,
    ctimeMs: 20n,
    mtimeNs: 10_000_001n,
    ctimeNs: 20_000_001n,
    isFile: () => true,
  } as BigIntStats;
  expect(sameRegularFileState(before, { ...before })).toBe(true);
  expect(
    sameRegularFileState(before, { ...before, mtimeNs: before.mtimeNs + 1n }),
  ).toBe(false);
  expect(
    sameRegularFileState(before, { ...before, ctimeNs: before.ctimeNs + 1n }),
  ).toBe(false);
});

it.each([
  ["EACCES", -13, "keeps"],
  ["ENXIO", -6, "reclassifies"],
] as const)(
  "%s from opening a non-regular path: admission %s the failure",
  async (code, errno, outcome) => {
    const failure = Object.assign(new Error(`open ${code}`), { code, errno });
    mockOpen.mockRejectedValue(failure);
    // The selected path itself is a directory that stat can still describe.
    const cause = await openRegularFile(tmpdir(), { symlinks: "follow" }).catch(
      (rejected: unknown) => rejected,
    );
    if (outcome === "keeps") expect(cause).toBe(failure);
    else expect(cause).toBeInstanceOf(NonRegularFileReadError);
  },
);

it("preserves the non-regular admission failure when cancellation arrives during its metadata probe", async () => {
  const controller = new AbortController();
  const cancellation = new Error("cancelled during probe");
  mockOpen.mockImplementation(async () => {
    // The probe stats the path after this rejection; abort before it settles.
    queueMicrotask(() => controller.abort(cancellation));
    throw Object.assign(new Error("open ENXIO"), { code: "ENXIO", errno: -6 });
  });
  await expect(
    openRegularFile(tmpdir(), {
      symlinks: "follow",
      signal: controller.signal,
    }),
  ).rejects.toBeInstanceOf(NonRegularFileReadError);
});

/** Run one admission against the real filesystem despite the mocked `open`. */
const openRealFile = async (
  path: string,
  symlinks: "follow" | "reject" = "reject",
): Promise<unknown> => {
  const { open } =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  mockOpen.mockImplementationOnce(async (...args: Parameters<typeof open>) =>
    open(...args),
  );
  return openRegularFile(path, { symlinks }).catch(
    (failure: unknown) => failure,
  );
};

/** The host's refusal stays the cause; the code keeps the #6004 classification. */
const symlinkRefusal = (cause: unknown): RegularFileSymlinkRefusalError => {
  if (!(cause instanceof RegularFileSymlinkRefusalError))
    throw new Error(`Expected a typed symlink refusal: ${String(cause)}`);
  expect(cause.code).toBe("ELOOP");
  expect(isSelectedRegularFileError(cause)).toBe(true);
  expect(cause.cause).toMatchObject({ code: "ELOOP", syscall: "open" });
  return cause;
};

const symlinkTest = it.skipIf(process.platform === "win32");

symlinkTest(
  "refuses a single selected symlink with its resolved regular file",
  async () => {
    const root = await createTestTempDirectory("rea-admission-symlink-");
    const real = join(root, "real.bin");
    await writeFile(real, "regular file bytes");
    const link = join(root, "one-link.bin");
    await symlink(real, link);

    const cause = symlinkRefusal(await openRealFile(link));
    expect(cause.path).toBe(link);
    expect(cause.resolution).toEqual({
      kind: "regular-file",
      resolvedPath: real,
    });
    expect(cause.message).toContain(real);
    expect(typeof cause.errno).toBe("number");
    expect(cause.cause).toMatchObject({
      errno: cause.errno,
      syscall: cause.syscall,
      path: link,
    });
    expect(await resolveRefusedSymlink(real)).toBeUndefined();
    expect(
      await resolveRefusedSymlink(join(root, "missing.bin")),
    ).toBeUndefined();
  },
);

symlinkTest("distinguishes a symlink loop from a single link", async () => {
  const root = await createTestTempDirectory("rea-admission-loop-");
  await symlink("loop-b.bin", join(root, "loop-a.bin"));
  await symlink("loop-a.bin", join(root, "loop-b.bin"));

  const cause = symlinkRefusal(await openRealFile(join(root, "loop-a.bin")));
  expect(cause.resolution).toEqual({ kind: "loop", linkTarget: "loop-b.bin" });
});

symlinkTest("names the missing target of a dangling symlink", async () => {
  const root = await createTestTempDirectory("rea-admission-dangling-");
  const missing = join(root, "no-such-file.bin");
  const link = join(root, "dangling.bin");
  await symlink(missing, link);

  const cause = symlinkRefusal(await openRealFile(link));
  expect(cause.resolution).toEqual({ kind: "dangling", linkTarget: missing });
});

symlinkTest(
  "names the resolved target when a symlink points at a directory",
  async () => {
    const root = await createTestTempDirectory("rea-admission-link-dir-");
    const directory = join(root, "real-dir");
    await mkdir(directory);
    const link = join(root, "link-dir");
    await symlink(directory, link);

    const cause = symlinkRefusal(await openRealFile(link));
    expect(cause.resolution).toEqual({
      kind: "non-regular-target",
      resolvedPath: directory,
    });
  },
);

symlinkTest(
  "keeps the refusal typed when the link's target path crosses a regular file",
  async () => {
    const root = await createTestTempDirectory("rea-admission-link-enotdir-");
    const real = join(root, "real.bin");
    await writeFile(real, "regular file bytes");
    const through = join(real, "inner.bin");
    const link = join(root, "through-file.bin");
    await symlink(through, link);

    const cause = symlinkRefusal(await openRealFile(link));
    expect(cause.resolution).toMatchObject({
      kind: "unresolved",
      linkTarget: through,
      cause: { code: "ENOTDIR" },
    });
    expect(cause.message).toContain("ENOTDIR");
  },
);

it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "keeps the refusal typed when the link's target is not traversable",
  async () => {
    const root = await createTestTempDirectory("rea-admission-link-eacces-");
    const locked = join(root, "locked");
    await mkdir(locked);
    const target = join(locked, "real.bin");
    await writeFile(target, "regular file bytes");
    const link = join(root, "locked-link.bin");
    await symlink(target, link);
    await chmod(locked, 0o000);
    try {
      const cause = symlinkRefusal(await openRealFile(link));
      expect(cause.resolution).toMatchObject({
        kind: "unresolved",
        linkTarget: target,
        cause: { code: "EACCES" },
      });
      expect(cause.message).toContain("EACCES");
    } finally {
      await chmod(locked, 0o755);
    }
  },
);

symlinkTest(
  "keeps the raw errno when a loop sits in a parent component",
  async () => {
    const root = await createTestTempDirectory("rea-admission-parent-loop-");
    await symlink("loop-b", join(root, "loop-a"));
    await symlink("loop-a", join(root, "loop-b"));

    const cause = await openRealFile(join(root, "loop-a", "file.bin"));
    expect(cause).not.toBeInstanceOf(RegularFileSymlinkRefusalError);
    expect(cause).toMatchObject({ code: "ELOOP" });
    expect(isSelectedRegularFileError(cause)).toBe(true);
  },
);

symlinkTest("keeps the raw loop errno when symlinks are followed", async () => {
  const root = await createTestTempDirectory("rea-admission-follow-loop-");
  await symlink("loop-b.bin", join(root, "loop-a.bin"));
  await symlink("loop-a.bin", join(root, "loop-b.bin"));

  const cause = await openRealFile(join(root, "loop-a.bin"), "follow");
  expect(cause).not.toBeInstanceOf(RegularFileSymlinkRefusalError);
  expect(cause).toMatchObject({ code: "ELOOP" });
});
