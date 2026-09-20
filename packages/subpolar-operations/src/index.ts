import {
  OPERATIONS_MANIFEST_FORMAT,
  OPERATIONS_MANIFEST_VERSION,
  serializeOperationsManifest,
  stableSerialize,
  validateOperationsManifest,
  type ManifestValidationResult,
  type OperationsManifest,
} from "@subpolar/contracts";

const SUPPORTED_MIGRATION_FORMATS = new Set(["backup/v1", "backup/v2"]);

export type ManifestInput = Omit<OperationsManifest, "format" | "version">;

export interface ManifestReport {
  valid: boolean;
  errors: readonly string[];
  manifest?: OperationsManifest;
  serialization?: string;
}

export interface DryRunRequest {
  operation: "migration" | "backup" | "restore";
  manifest: unknown;
  approved?: boolean;
}

export interface DryRunReport {
  operation: DryRunRequest["operation"];
  dryRun: true;
  performed: false;
  valid: boolean;
  errors: readonly string[];
  planned: {
    migrationSteps: number;
    backupArtifacts: number;
    totalBackupBytes: number;
  };
  refusal?: {
    code: "INVALID_MANIFEST" | "SECRET_BEARING_ARTIFACT" | "MIGRATION_VERSION_UNSUPPORTED" | "DESTRUCTIVE_RESTORE_APPROVAL_REQUIRED";
    message: string;
  };
}

function migrationErrors(manifest: unknown): string[] {
  if (!manifest || typeof manifest !== "object") return [];
  const migration = (manifest as { migration?: unknown }).migration;
  if (!migration || typeof migration !== "object") return [];
  const candidate = migration as { fromFormat?: unknown; toFormat?: unknown };
  const errors: string[] = [];
  if (typeof candidate.fromFormat === "string" && !SUPPORTED_MIGRATION_FORMATS.has(candidate.fromFormat)) {
    errors.push("migration.fromFormat is unsupported");
  }
  if (typeof candidate.toFormat === "string" && !SUPPORTED_MIGRATION_FORMATS.has(candidate.toFormat)) {
    errors.push("migration.toFormat is unsupported");
  }
  return errors;
}

function validationReport(value: unknown): ManifestReport {
  const result: ManifestValidationResult = validateOperationsManifest(value);
  const errors = [...result.errors, ...migrationErrors(value)];
  if (errors.length > 0) return { valid: false, errors };
  const manifest = value as OperationsManifest;
  return { valid: true, errors: [], manifest, serialization: serializeOperationsManifest(manifest) };
}

export function buildOperationsManifest(input: ManifestInput): OperationsManifest {
  const manifest = {
    format: OPERATIONS_MANIFEST_FORMAT,
    version: OPERATIONS_MANIFEST_VERSION,
    ...input,
  } as OperationsManifest;
  const report = validationReport(manifest);
  if (!report.valid) throw new TypeError(`invalid operations manifest: ${report.errors.join("; ")}`);
  return manifest;
}

export function createManifestReport(input: ManifestInput | unknown): ManifestReport {
  if (!input || typeof input !== "object") return validationReport(input);
  const candidate = input as Record<string, unknown>;
  const manifest = "format" in candidate || "version" in candidate
    ? input
    : { format: OPERATIONS_MANIFEST_FORMAT, version: OPERATIONS_MANIFEST_VERSION, ...candidate };
  return validationReport(manifest);
}

export function validateManifestReport(manifest: unknown): ManifestReport {
  return validationReport(manifest);
}

export function createDryRunReport(request: DryRunRequest): DryRunReport {
  const report = createManifestReport(request.manifest);
  const manifest = report.manifest;
  const artifacts = manifest?.backup.artifacts ?? [];
  const planned = {
    migrationSteps: manifest?.migration.steps.length ?? 0,
    backupArtifacts: artifacts.length,
    totalBackupBytes: artifacts.reduce((total: number, artifact: OperationsManifest["backup"]["artifacts"][number]) => total + artifact.sizeBytes, 0),
  };
  if (!report.valid || !manifest) {
    const secret = report.errors.some((error) => error.includes("may not contain secrets"));
    const unsupported = report.errors.some((error) => error.includes("migration.") && error.includes("unsupported"));
    return {
      operation: request.operation, dryRun: true, performed: false, valid: false,
      errors: report.errors, planned,
      refusal: { code: secret ? "SECRET_BEARING_ARTIFACT" : unsupported ? "MIGRATION_VERSION_UNSUPPORTED" : "INVALID_MANIFEST", message: secret ? "Secret-bearing backup artifacts are refused" : unsupported ? "The migration version is unsupported" : "The operations manifest is invalid" },
    };
  }
  const destructiveRestore = request.operation === "restore" && (manifest.restore.mode !== "merge" || manifest.restore.overwrite);
  if (destructiveRestore && (!manifest.restore.requiresApproval || request.approved !== true)) {
    return {
      operation: request.operation, dryRun: true, performed: false, valid: false,
      errors: ["destructive restore requires explicit approval"], planned,
      refusal: { code: "DESTRUCTIVE_RESTORE_APPROVAL_REQUIRED", message: "Destructive restore is refused without explicit approval" },
    };
  }
  return { operation: request.operation, dryRun: true, performed: false, valid: true, errors: [], planned };
}

export function serializeManifestReport(manifest: OperationsManifest): string {
  return stableSerialize(manifest);
}
