import { describe, expect, test } from "bun:test";
import { buildOperationsManifest, createDryRunReport, createManifestReport, serializeManifestReport } from "../src/index.ts";
import type { OperationsManifest } from "@subpolar/contracts";

const input = {
  operationId: "backup:one", generatedAt: "2026-09-20T00:00:00.000Z",
  migration: { fromFormat: "backup/v1", toFormat: "backup/v2", compatibility: "backward", steps: [] },
  backup: { backupId: "b1", createdAt: "2026-09-20T00:00:00.000Z", artifacts: [{ id: "db", class: "database", path: "backup/db", mediaType: "application/octet-stream", sizeBytes: 10, checksum: `sha256:${"b".repeat(64)}`, createdAt: "2026-09-20T00:00:00.000Z", encrypted: true }] },
  restore: { mode: "merge", dryRun: true, overwrite: false, requiresApproval: false },
  retention: { category: "archive", retainForSeconds: 3600, tombstones: true },
  limits: { maxArtifacts: 10, maxArtifactBytes: 1000, maxTotalBytes: 2000, maxMigrationSteps: 10, maxDiagnosticEntries: 5 },
  truncation: { maxBytes: 500, marker: "[truncated]" }, timeouts: { migrationSeconds: 10, backupSeconds: 20, restoreSeconds: 30 }, diagnostics: [],
} satisfies Omit<OperationsManifest, "format" | "version">;

describe("operations consumer", () => {
  test("emits a validated manifest and stable serialization", () => {
    const manifest = buildOperationsManifest(input);
    expect(createManifestReport(input).valid).toBe(true);
    expect(serializeManifestReport(manifest)).toBe(serializeManifestReport({ ...manifest, limits: { ...manifest.limits } }));
  });

  test("refuses invalid limits and secret-bearing artifacts", () => {
    const invalid = { ...input, limits: { ...input.limits, maxArtifacts: 0 }, backup: { ...input.backup, artifacts: [{ ...input.backup.artifacts[0], path: "backup/token" }] } };
    const report = createManifestReport(invalid);
    expect(report.valid).toBe(false);
    expect(report.errors.join(" ")).not.toContain("token");
    expect(createDryRunReport({ operation: "backup", manifest: invalid }).refusal?.code).toBe("SECRET_BEARING_ARTIFACT");
  });

  test("refuses unsupported migration versions and destructive restore without approval", () => {
    const unsupported = { ...input, migration: { ...input.migration, toFormat: "backup/v9" } };
    expect(createDryRunReport({ operation: "migration", manifest: unsupported }).refusal?.code).toBe("MIGRATION_VERSION_UNSUPPORTED");
    const restore = { ...input, restore: { mode: "replace" as const, dryRun: true, overwrite: true, requiresApproval: true, approvalId: "approval-1" } };
    expect(createDryRunReport({ operation: "restore", manifest: restore }).refusal?.code).toBe("DESTRUCTIVE_RESTORE_APPROVAL_REQUIRED");
    expect(createDryRunReport({ operation: "restore", manifest: restore, approved: true }).performed).toBe(false);
  });
});
