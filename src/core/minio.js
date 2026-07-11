import { Client as MinioClient } from "minio";
import { CliError } from "./errors.js";

const DEFAULT_OBJECT_PREFIX = "pragma-design-context";

export function resolveMinioPublishConfig(options, { credentialsRequired = true } = {}) {
  const endpoint = String(options["minio-endpoint"] || options.minioEndpoint || process.env.PRAGMA_MINIO_ENDPOINT || "").trim();
  const bucket = String(options["minio-bucket"] || options.minioBucket || process.env.PRAGMA_MINIO_BUCKET || "").trim();
  const region = String(options["minio-region"] || options.minioRegion || process.env.PRAGMA_MINIO_REGION || "us-east-1").trim();
  const objectPrefix = normalizeObjectPrefix(options["minio-object-prefix"] || options.minioObjectPrefix || process.env.PRAGMA_MINIO_OBJECT_PREFIX || DEFAULT_OBJECT_PREFIX);
  const accessKeyEnv = String(options["minio-access-key-env"] || options.minioAccessKeyEnv || "PRAGMA_MINIO_PUBLISH_ACCESS_KEY");
  const secretKeyEnv = String(options["minio-secret-key-env"] || options.minioSecretKeyEnv || "PRAGMA_MINIO_PUBLISH_SECRET_KEY");
  if (!endpoint) throw new CliError("PRAGMA_MINIO_ENDPOINT or --minio-endpoint is required when publishing packages over the threshold.");
  if (!bucket) throw new CliError("PRAGMA_MINIO_BUCKET or --minio-bucket is required when publishing packages over the threshold.");
  const parsedEndpoint = parseMinioEndpoint(endpoint);
  const accessKey = process.env[accessKeyEnv]?.trim();
  const secretKey = process.env[secretKeyEnv]?.trim();
  if (credentialsRequired && (!accessKey || !secretKey)) {
    throw new CliError(`MinIO publisher credentials are required in ${accessKeyEnv} and ${secretKeyEnv}.`);
  }
  return {
    endpoint,
    bucket,
    region,
    objectPrefix,
    accessKey,
    secretKey,
    clientOptions: {
      endPoint: parsedEndpoint.hostname,
      port: parsedEndpoint.port,
      useSSL: parsedEndpoint.useSSL,
      pathStyle: true,
      region,
      ...(accessKey && secretKey ? { accessKey, secretKey } : {})
    }
  };
}

export function pragmaContextObjectKey({ objectPrefix = DEFAULT_OBJECT_PREFIX, repo, designIssue, version, fileName = "context.zip" }) {
  const prefix = normalizeObjectPrefix(objectPrefix);
  const repoPath = String(repo || "").split("/").map(objectKeySegment).join("/");
  if (!repoPath.includes("/")) throw new CliError("manifest.issue.repo must use owner/repo format for MinIO publication.");
  const issueNumber = Number(designIssue);
  if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) throw new CliError("A positive Design Issue number is required for MinIO publication.");
  return `${prefix}/${repoPath}/issue-${issueNumber}/${objectKeySegment(version)}/${objectKeySegment(fileName)}`;
}

export async function uploadImmutableMinioObject({ config, bucket, objectKey, zipPath, checksum, sizeBytes, client }) {
  const minio = client || new MinioClient(config.clientOptions);
  try {
    const existing = await minio.statObject(bucket, objectKey);
    const existingChecksum = metadataChecksum(existing.metaData);
    if (existing.size === sizeBytes && existingChecksum === checksum) return { reused: true };
    throw new CliError(`MinIO object already exists with different content: s3://${bucket}/${objectKey}`);
  } catch (error) {
    if (error instanceof CliError) throw error;
    if (!isMissingObject(error)) throw new CliError(`MinIO object preflight failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  await minio.fPutObject(bucket, objectKey, zipPath, {
    "Content-Type": "application/zip",
    "X-Amz-Meta-Pragma-Sha256": checksum
  });
  return { reused: false };
}

export async function statMinioObject({ config, bucket, objectKey, client }) {
  const minio = client || new MinioClient(config.clientOptions);
  return minio.statObject(bucket, objectKey);
}

function parseMinioEndpoint(value) {
  let endpoint;
  try {
    endpoint = new URL(value);
  } catch {
    throw new CliError("MinIO endpoint must be an absolute HTTP(S) URL.");
  }
  if (!/^https?:$/.test(endpoint.protocol) || endpoint.pathname !== "/" || endpoint.search || endpoint.hash) {
    throw new CliError("MinIO endpoint must contain only scheme, host, and optional port.");
  }
  return {
    hostname: endpoint.hostname,
    port: endpoint.port ? Number(endpoint.port) : endpoint.protocol === "https:" ? 443 : 80,
    useSSL: endpoint.protocol === "https:"
  };
}

function normalizeObjectPrefix(value) {
  const normalized = String(value || "").replace(/^\/+|\/+$/g, "");
  if (!normalized || normalized.split("/").some((segment) => !/^[A-Za-z0-9._-]+$/.test(segment))) {
    throw new CliError("MinIO object prefix contains an unsafe segment.");
  }
  return normalized;
}

function objectKeySegment(value) {
  const normalized = String(value || "");
  if (normalized === "." || normalized === ".." || !/^[A-Za-z0-9._-]+$/.test(normalized)) throw new CliError("MinIO object identity contains an unsafe segment.");
  return normalized;
}

function metadataChecksum(metadata) {
  if (!metadata || typeof metadata !== "object") return undefined;
  const entries = Object.entries(metadata);
  return entries.find(([key]) => key.toLowerCase().replace(/^x-amz-meta-/, "") === "pragma-sha256")?.[1];
}

function isMissingObject(error) {
  const code = error && typeof error === "object" ? error.code : undefined;
  return code === "NoSuchKey" || code === "NotFound" || code === "NoSuchObject";
}
