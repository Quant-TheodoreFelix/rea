import { expect, it } from "vitest";

import { RegularFileSymlinkRefusalError } from "../filesystem/RegularFile.js";
import {
  regularFileSymlinkRecovery,
  resolvedRegularFileRemediation,
} from "./StableArtifactFailure.js";

const selected = "/local/targets/one-link.gguf";
const real = "/local/targets/real.gguf";
const openFailure = Object.assign(new Error("open ELOOP"), {
  code: "ELOOP",
  errno: -62,
  syscall: "open",
});

it("offers the resolved file only for the caller-selected refused symlink", () => {
  const refusal = new RegularFileSymlinkRefusalError(
    selected,
    { kind: "regular-file", resolvedPath: real },
    { cause: openFailure },
  );
  expect(regularFileSymlinkRecovery(refusal, selected)).toEqual({
    remediationAction: resolvedRegularFileRemediation(real),
  });
  expect(
    regularFileSymlinkRecovery(refusal, "/local/targets/other.gguf"),
  ).toEqual({});
  expect(refusal.cause).toBe(openFailure);
  expect(refusal.errno).toBe(-62);
  expect(refusal.syscall).toBe("open");
});

it.each([
  { kind: "loop", linkTarget: "loop-b.gguf" },
  { kind: "dangling", linkTarget: "/local/targets/missing.gguf" },
  { kind: "non-regular-target", resolvedPath: "/local/targets" },
  {
    kind: "unresolved",
    linkTarget: "/local/locked/real.gguf",
    cause: Object.assign(new Error("lookup EACCES"), { code: "EACCES" }),
  },
] as const)("offers no retry path for a $kind refusal", (resolution) => {
  const refusal = new RegularFileSymlinkRefusalError(selected, resolution, {
    cause: openFailure,
  });
  expect(regularFileSymlinkRecovery(refusal, selected)).toEqual({});
  expect(refusal.code).toBe("ELOOP");
});

it("offers nothing for an error that is not a symlink refusal", () => {
  expect(regularFileSymlinkRecovery(openFailure, selected)).toEqual({});
});
