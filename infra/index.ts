import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";
import * as random from "@pulumi/random";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const config = new pulumi.Config();
const gcpConfig = new pulumi.Config("gcp");

const project = gcpConfig.require("project");
const region = gcpConfig.get("region") || "us-central1";
const zone = gcpConfig.get("zone") || "us-central1-a";

// Tenant definitions — add tenants here
const tenants: TenantConfig[] = config.requireObject("tenants");

interface TenantConfig {
  /** Unique tenant slug (alphanumeric + hyphens). Used for resource naming. */
  name: string;
  /** GCE machine type. Default: e2-small */
  machineType?: string;
  /** Persistent disk size in GB for Paperclip data. Default: 20 */
  diskSizeGb?: number;
  /** GCS bucket region for backups/storage. Default: same as VM region */
  bucketRegion?: string;
  /** Custom domain for this tenant (e.g. tenant-a.paperclip.example.com) */
  domain?: string;
  /** Anthropic API key — stored in GCP Secret Manager */
  anthropicApiKey?: string;
}

// ---------------------------------------------------------------------------
// Shared resources
// ---------------------------------------------------------------------------

// VPC network shared by all tenant VMs
const network = new gcp.compute.Network("paperclip-network", {
  autoCreateSubnetworks: false,
  project,
});

const subnet = new gcp.compute.Subnetwork("paperclip-subnet", {
  ipCidrRange: "10.0.0.0/16",
  region,
  network: network.id,
  project,
});

// Allow HTTP/HTTPS + SSH
const firewallHttp = new gcp.compute.Firewall("paperclip-allow-http", {
  network: network.id,
  project,
  allows: [
    { protocol: "tcp", ports: ["80", "443"] },
  ],
  sourceRanges: ["0.0.0.0/0"],
  targetTags: ["paperclip-server"],
});

const firewallSsh = new gcp.compute.Firewall("paperclip-allow-ssh", {
  network: network.id,
  project,
  allows: [
    { protocol: "tcp", ports: ["22"] },
  ],
  sourceRanges: ["0.0.0.0/0"], // Narrow this to your IP in production
  targetTags: ["paperclip-server"],
});

// Artifact Registry for Paperclip Docker image
const registry = new gcp.artifactregistry.Repository("paperclip-registry", {
  repositoryId: "paperclip",
  format: "DOCKER",
  location: region,
  project,
});

// Service account for tenant VMs
const vmServiceAccount = new gcp.serviceaccount.Account("paperclip-vm-sa", {
  accountId: "paperclip-vm",
  displayName: "Paperclip VM Service Account",
  project,
});

// Grant VM service account access to pull images from Artifact Registry
new gcp.artifactregistry.RepositoryIamMember("paperclip-registry-reader", {
  repository: registry.name,
  location: region,
  project,
  role: "roles/artifactregistry.reader",
  member: pulumi.interpolate`serviceAccount:${vmServiceAccount.email}`,
});

// Grant VM service account access to Secret Manager
new gcp.projects.IAMMember("paperclip-vm-secret-accessor", {
  project,
  role: "roles/secretmanager.secretAccessor",
  member: pulumi.interpolate`serviceAccount:${vmServiceAccount.email}`,
});

// ---------------------------------------------------------------------------
// Per-tenant resources
// ---------------------------------------------------------------------------

interface TenantOutputs {
  vmIp: pulumi.Output<string>;
  bucketName: pulumi.Output<string>;
  vmName: pulumi.Output<string>;
}

const tenantOutputs: Record<string, TenantOutputs> = {};

for (const tenant of tenants) {
  const name = tenant.name;
  const machineType = tenant.machineType || "e2-small";
  const diskSizeGb = tenant.diskSizeGb || 20;
  const bucketRegion = tenant.bucketRegion || region;

  // -- GCS bucket for this tenant (backups + S3-compatible file storage) --
  const bucket = new gcp.storage.Bucket(`${name}-bucket`, {
    name: `paperclip-${name}-${project}`,
    location: bucketRegion,
    project,
    uniformBucketLevelAccess: true,
    versioning: { enabled: true },
    lifecycleRules: [
      {
        action: { type: "Delete" },
        condition: { age: 90 }, // Clean up old backup versions after 90 days
      },
    ],
  });

  // Grant VM service account write access to tenant bucket
  new gcp.storage.BucketIAMMember(`${name}-bucket-writer`, {
    bucket: bucket.name,
    role: "roles/storage.objectAdmin",
    member: pulumi.interpolate`serviceAccount:${vmServiceAccount.email}`,
  });

  // -- HMAC key for S3-compatible access to GCS --
  const hmacKey = new gcp.storage.HmacKey(`${name}-hmac`, {
    serviceAccountEmail: vmServiceAccount.email,
    project,
  });

  // -- Secrets in GCP Secret Manager --
  const betterAuthSecret = new random.RandomPassword(`${name}-auth-secret`, {
    length: 48,
    special: false,
  });

  const masterKeySecret = new random.RandomBytes(`${name}-master-key`, {
    length: 32,
  });

  // Store Better Auth secret
  const authSecretResource = new gcp.secretmanager.Secret(`${name}-better-auth-secret`, {
    secretId: `paperclip-${name}-better-auth-secret`,
    project,
    replication: { auto: {} },
  });

  new gcp.secretmanager.SecretVersion(`${name}-better-auth-secret-v1`, {
    secret: authSecretResource.id,
    secretData: betterAuthSecret.result,
  });

  // Store master encryption key
  const masterKeyResource = new gcp.secretmanager.Secret(`${name}-master-key`, {
    secretId: `paperclip-${name}-master-key`,
    project,
    replication: { auto: {} },
  });

  new gcp.secretmanager.SecretVersion(`${name}-master-key-v1`, {
    secret: masterKeyResource.id,
    secretData: masterKeySecret.base64,
  });

  // Store Anthropic API key if provided
  if (tenant.anthropicApiKey) {
    const anthropicSecretResource = new gcp.secretmanager.Secret(`${name}-anthropic-key`, {
      secretId: `paperclip-${name}-anthropic-key`,
      project,
      replication: { auto: {} },
    });

    new gcp.secretmanager.SecretVersion(`${name}-anthropic-key-v1`, {
      secret: anthropicSecretResource.id,
      secretData: tenant.anthropicApiKey,
    });
  }

  // -- Persistent disk for Paperclip data --
  const dataDisk = new gcp.compute.Disk(`${name}-data-disk`, {
    name: `paperclip-${name}-data`,
    size: diskSizeGb,
    type: "pd-balanced",
    zone,
    project,
  });

  // -- Static external IP --
  const ip = new gcp.compute.Address(`${name}-ip`, {
    name: `paperclip-${name}-ip`,
    region,
    project,
  });

  // -- Startup script --
  const startupScript = pulumi.interpolate`#!/bin/bash
set -euo pipefail

# Install Docker if not present
if ! command -v docker &> /dev/null; then
  curl -fsSL https://get.docker.com | sh
  systemctl enable docker
  systemctl start docker
fi

# Install gcloud auth helper for Artifact Registry
gcloud auth configure-docker ${region}-docker.pkg.dev --quiet

# Format and mount data disk (only on first boot)
DEVICE="/dev/disk/by-id/google-paperclip-${name}-data"
MOUNT="/mnt/paperclip"

if ! blkid "$DEVICE"; then
  mkfs.ext4 -m 0 -F -E lazy_itable_init=0,lazy_journal_init=0 "$DEVICE"
fi

mkdir -p "$MOUNT"
if ! mountpoint -q "$MOUNT"; then
  mount -o discard,defaults "$DEVICE" "$MOUNT"
fi

# Ensure mount persists across reboots
if ! grep -q "$MOUNT" /etc/fstab; then
  echo "$DEVICE $MOUNT ext4 discard,defaults,nofail 0 2" >> /etc/fstab
fi

mkdir -p "$MOUNT/data"
chown 1000:1000 "$MOUNT/data"

# Fetch secrets from Secret Manager
BETTER_AUTH_SECRET=$(gcloud secrets versions access latest --secret="paperclip-${name}-better-auth-secret" --project="${project}")
MASTER_KEY=$(gcloud secrets versions access latest --secret="paperclip-${name}-master-key" --project="${project}")

ANTHROPIC_KEY=""
if gcloud secrets versions access latest --secret="paperclip-${name}-anthropic-key" --project="${project}" 2>/dev/null; then
  ANTHROPIC_KEY=$(gcloud secrets versions access latest --secret="paperclip-${name}-anthropic-key" --project="${project}")
fi

# Pull and run Paperclip
IMAGE="${region}-docker.pkg.dev/${project}/paperclip/paperclip:latest"
docker pull "$IMAGE" || true

docker rm -f paperclip 2>/dev/null || true

docker run -d \
  --name paperclip \
  --restart unless-stopped \
  -p 80:3100 \
  -v "$MOUNT/data:/paperclip" \
  -e HOST=0.0.0.0 \
  -e PORT=3100 \
  -e PAPERCLIP_HOME=/paperclip \
  -e PAPERCLIP_DEPLOYMENT_MODE=authenticated \
  -e PAPERCLIP_DEPLOYMENT_EXPOSURE=public \
  -e PAPERCLIP_PUBLIC_URL="https://${tenant.domain || `${name}.paperclip.example.com`}" \
  -e BETTER_AUTH_SECRET="$BETTER_AUTH_SECRET" \
  -e PAPERCLIP_SECRETS_MASTER_KEY="$MASTER_KEY" \
  -e PAPERCLIP_STORAGE_PROVIDER=s3 \
  -e PAPERCLIP_STORAGE_S3_BUCKET="${bucket.name}" \
  -e PAPERCLIP_STORAGE_S3_REGION=auto \
  -e PAPERCLIP_STORAGE_S3_ENDPOINT=https://storage.googleapis.com \
  -e PAPERCLIP_STORAGE_S3_FORCE_PATH_STYLE=true \
  -e AWS_ACCESS_KEY_ID="${hmacKey.accessId}" \
  -e AWS_SECRET_ACCESS_KEY="${hmacKey.secret}" \
  -e PAPERCLIP_DB_BACKUP_ENABLED=true \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_KEY" \
  "$IMAGE"

# Setup backup sync cron — push SQL dumps to GCS every hour
cat > /etc/cron.d/paperclip-backup-sync << 'CRON'
0 * * * * root gsutil -m rsync -r /mnt/paperclip/data/instances/default/data/backups/ gs://${bucket.name}/backups/ 2>&1 | logger -t paperclip-backup
CRON
chmod 644 /etc/cron.d/paperclip-backup-sync
`;

  // -- Compute instance --
  const vm = new gcp.compute.Instance(`${name}-vm`, {
    name: `paperclip-${name}`,
    machineType,
    zone,
    project,
    tags: ["paperclip-server"],

    bootDisk: {
      initializeParams: {
        image: "projects/cos-cloud/global/images/family/cos-stable",
        size: 10,
        type: "pd-balanced",
      },
    },

    attachedDisks: [
      {
        source: dataDisk.selfLink,
        deviceName: `paperclip-${name}-data`,
      },
    ],

    networkInterfaces: [
      {
        subnetwork: subnet.id,
        accessConfigs: [
          { natIp: ip.address },
        ],
      },
    ],

    serviceAccount: {
      email: vmServiceAccount.email,
      scopes: ["cloud-platform"],
    },

    metadataStartupScript: startupScript,

    // Allow stopping for updates
    allowStoppingForUpdate: true,
  });

  tenantOutputs[name] = {
    vmIp: ip.address,
    bucketName: bucket.name,
    vmName: vm.name,
  };
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

export const registryUrl = pulumi.interpolate`${region}-docker.pkg.dev/${project}/paperclip`;

export const tenantInfo = Object.fromEntries(
  Object.entries(tenantOutputs).map(([name, out]) => [
    name,
    {
      ip: out.vmIp,
      bucket: out.bucketName,
      vm: out.vmName,
    },
  ]),
);
