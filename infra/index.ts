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
const sshSourceRanges = config.getObject<string[]>("sshSourceRanges") || ["0.0.0.0/0"];

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
  /** OpenAI API key — stored in GCP Secret Manager */
  openaiApiKey?: string;
}

// ---------------------------------------------------------------------------
// Shared networking
// ---------------------------------------------------------------------------

const network = new gcp.compute.Network("paperclip-network", {
  autoCreateSubnetworks: false,
  project,
});

const subnet = new gcp.compute.Subnetwork("paperclip-subnet", {
  ipCidrRange: "10.0.0.0/16",
  region,
  network: network.id,
  project,
  privateIpGoogleAccess: true, // Allow VMs to reach GCP APIs without external IP
});

// Cloud NAT for outbound internet (so VMs without public IPs can pull images, etc.)
const router = new gcp.compute.Router("paperclip-router", {
  network: network.id,
  region,
  project,
});

new gcp.compute.RouterNat("paperclip-nat", {
  router: router.name,
  region,
  project,
  natIpAllocateOption: "AUTO_ONLY",
  sourceSubnetworkIpRangesToNat: "ALL_SUBNETWORKS_ALL_IP_RANGES",
});

const firewallHttp = new gcp.compute.Firewall("paperclip-allow-http", {
  network: network.id,
  project,
  allows: [{ protocol: "tcp", ports: ["80", "443"] }],
  sourceRanges: ["0.0.0.0/0"],
  targetTags: ["paperclip-server"],
});

const firewallSsh = new gcp.compute.Firewall("paperclip-allow-ssh", {
  network: network.id,
  project,
  allows: [{ protocol: "tcp", ports: ["22"] }],
  sourceRanges: sshSourceRanges,
  targetTags: ["paperclip-server"],
});

// Allow GCP health checks to reach VMs
const firewallHealthCheck = new gcp.compute.Firewall("paperclip-allow-healthcheck", {
  network: network.id,
  project,
  allows: [{ protocol: "tcp", ports: ["3100"] }],
  // GCP health check probe IP ranges
  sourceRanges: ["130.211.0.0/22", "35.191.0.0/16"],
  targetTags: ["paperclip-server"],
});

// ---------------------------------------------------------------------------
// Shared Artifact Registry
// ---------------------------------------------------------------------------

const registry = new gcp.artifactregistry.Repository("paperclip-registry", {
  repositoryId: "paperclip",
  format: "DOCKER",
  location: region,
  project,
});

// ---------------------------------------------------------------------------
// Disk snapshot schedule (shared policy, applied per-tenant disk)
// ---------------------------------------------------------------------------

const snapshotPolicy = new gcp.compute.ResourcePolicy("paperclip-snapshot-policy", {
  name: "paperclip-daily-snapshot",
  region,
  project,
  snapshotSchedulePolicy: {
    schedule: {
      dailySchedule: { daysInCycle: 1, startTime: "03:00" },
    },
    retentionPolicy: {
      maxRetentionDays: 14,
      onSourceDiskDelete: "KEEP_AUTO_SNAPSHOTS",
    },
    snapshotProperties: {
      storageLocations: [region],
      labels: { managed_by: "pulumi" },
    },
  },
});

// ---------------------------------------------------------------------------
// Per-tenant resources
// ---------------------------------------------------------------------------

interface TenantOutputs {
  vmIp: pulumi.Output<string>;
  bucketName: pulumi.Output<string>;
  instanceGroupManager: pulumi.Output<string>;
  domain: string;
}

const tenantOutputs: Record<string, TenantOutputs> = {};

for (const tenant of tenants) {
  const t = tenant.name;
  const machineType = tenant.machineType || "e2-small";
  const diskSizeGb = tenant.diskSizeGb || 20;
  const bucketRegion = tenant.bucketRegion || region;
  const domain = tenant.domain || `${t}.paperclip.example.com`;

  // -----------------------------------------------------------------------
  // Per-tenant service account (isolation: each tenant VM gets its own SA)
  // -----------------------------------------------------------------------

  const sa = new gcp.serviceaccount.Account(`${t}-sa`, {
    accountId: `paperclip-${t}`,
    displayName: `Paperclip ${t} VM`,
    project,
  });

  // Pull images from Artifact Registry
  new gcp.artifactregistry.RepositoryIamMember(`${t}-registry-reader`, {
    repository: registry.name,
    location: region,
    project,
    role: "roles/artifactregistry.reader",
    member: pulumi.interpolate`serviceAccount:${sa.email}`,
  });

  // Write logs to Cloud Logging
  new gcp.projects.IAMMember(`${t}-log-writer`, {
    project,
    role: "roles/logging.logWriter",
    member: pulumi.interpolate`serviceAccount:${sa.email}`,
  });

  // Write metrics to Cloud Monitoring
  new gcp.projects.IAMMember(`${t}-metric-writer`, {
    project,
    role: "roles/monitoring.metricWriter",
    member: pulumi.interpolate`serviceAccount:${sa.email}`,
  });

  // -----------------------------------------------------------------------
  // GCS bucket (backups + S3-compatible file storage)
  // -----------------------------------------------------------------------

  const bucket = new gcp.storage.Bucket(`${t}-bucket`, {
    name: `paperclip-${t}-${project}`,
    location: bucketRegion,
    project,
    uniformBucketLevelAccess: true,
    versioning: { enabled: true },
    lifecycleRules: [
      {
        action: { type: "Delete" },
        condition: { age: 90, withState: "ARCHIVED" },
      },
    ],
  });

  // Only this tenant's SA can access its bucket
  new gcp.storage.BucketIAMMember(`${t}-bucket-access`, {
    bucket: bucket.name,
    role: "roles/storage.objectAdmin",
    member: pulumi.interpolate`serviceAccount:${sa.email}`,
  });

  // HMAC key for S3-compatible access
  const hmacKey = new gcp.storage.HmacKey(`${t}-hmac`, {
    serviceAccountEmail: sa.email,
    project,
  });

  // -----------------------------------------------------------------------
  // Secrets — per-tenant, only accessible by tenant's SA
  // -----------------------------------------------------------------------

  const betterAuthSecret = new random.RandomPassword(`${t}-auth-secret`, {
    length: 48,
    special: false,
  });

  const masterKey = new random.RandomBytes(`${t}-master-key`, {
    length: 32,
  });

  const secrets: Record<string, pulumi.Output<string>> = {
    "better-auth-secret": betterAuthSecret.result,
    "master-key": masterKey.base64,
    "hmac-access-key-id": hmacKey.accessId,
    "hmac-secret-key": hmacKey.secret,
  };

  if (tenant.anthropicApiKey) {
    secrets["anthropic-key"] = pulumi.output(tenant.anthropicApiKey);
  }
  if (tenant.openaiApiKey) {
    secrets["openai-key"] = pulumi.output(tenant.openaiApiKey);
  }

  for (const [suffix, value] of Object.entries(secrets)) {
    const secret = new gcp.secretmanager.Secret(`${t}-${suffix}`, {
      secretId: `paperclip-${t}-${suffix}`,
      project,
      replication: { auto: {} },
    });

    new gcp.secretmanager.SecretVersion(`${t}-${suffix}-v1`, {
      secret: secret.id,
      secretData: value,
    });

    // Only this tenant's SA can read its secrets
    new gcp.secretmanager.SecretIamMember(`${t}-${suffix}-access`, {
      secretId: secret.id,
      project,
      role: "roles/secretmanager.secretAccessor",
      member: pulumi.interpolate`serviceAccount:${sa.email}`,
    });
  }

  // -----------------------------------------------------------------------
  // Persistent disk + snapshot schedule
  // -----------------------------------------------------------------------

  const dataDisk = new gcp.compute.Disk(`${t}-data-disk`, {
    name: `paperclip-${t}-data`,
    size: diskSizeGb,
    type: "pd-balanced",
    zone,
    project,
    resourcePolicies: [snapshotPolicy.id],
  });

  // -----------------------------------------------------------------------
  // Static IP
  // -----------------------------------------------------------------------

  const ip = new gcp.compute.Address(`${t}-ip`, {
    name: `paperclip-${t}-ip`,
    region,
    project,
  });

  // -----------------------------------------------------------------------
  // Startup script
  // -----------------------------------------------------------------------

  const startupScript = pulumi.interpolate`#!/bin/bash
set -euo pipefail
exec > >(logger -t paperclip-startup) 2>&1

PROJECT="${project}"
TENANT="${t}"
REGION="${region}"
DOMAIN="${domain}"
BUCKET="${bucket.name}"
IMAGE="${region}-docker.pkg.dev/${project}/paperclip/paperclip:latest"
MOUNT="/mnt/paperclip"
DEVICE="/dev/disk/by-id/google-paperclip-${t}-data"

# ---------- Helper ----------
fetch_secret() {
  gcloud secrets versions access latest --secret="$1" --project="$PROJECT"
}

# ---------- Data disk ----------
if ! blkid "$DEVICE" &>/dev/null; then
  mkfs.ext4 -m 0 -F -E lazy_itable_init=0,lazy_journal_init=0 "$DEVICE"
fi

mkdir -p "$MOUNT"
if ! mountpoint -q "$MOUNT"; then
  mount -o discard,defaults "$DEVICE" "$MOUNT"
fi
grep -q "$MOUNT" /etc/fstab || \
  echo "$DEVICE $MOUNT ext4 discard,defaults,nofail 0 2" >> /etc/fstab

mkdir -p "$MOUNT/data" "$MOUNT/caddy-data" "$MOUNT/caddy-config"
chown 1000:1000 "$MOUNT/data"

# ---------- Install Docker (Debian) ----------
if ! command -v docker &>/dev/null; then
  apt-get update -qq
  apt-get install -y -qq docker.io docker-compose-plugin cron
  systemctl enable --now docker cron
fi

# ---------- Authenticate to Artifact Registry ----------
gcloud auth configure-docker "$REGION-docker.pkg.dev" --quiet

# ---------- Fetch secrets ----------
BETTER_AUTH_SECRET=$(fetch_secret "paperclip-$TENANT-better-auth-secret")
MASTER_KEY=$(fetch_secret "paperclip-$TENANT-master-key")
HMAC_ACCESS_KEY=$(fetch_secret "paperclip-$TENANT-hmac-access-key-id")
HMAC_SECRET_KEY=$(fetch_secret "paperclip-$TENANT-hmac-secret-key")

ANTHROPIC_KEY=""
ANTHROPIC_KEY=$(fetch_secret "paperclip-$TENANT-anthropic-key" 2>/dev/null) || true

OPENAI_KEY=""
OPENAI_KEY=$(fetch_secret "paperclip-$TENANT-openai-key" 2>/dev/null) || true

# ---------- Caddy reverse proxy (auto TLS) ----------
cat > "$MOUNT/Caddyfile" <<CADDY
$DOMAIN {
  reverse_proxy paperclip:3100
}
CADDY

# ---------- Docker network ----------
docker network create paperclip-net 2>/dev/null || true

# ---------- Pull image ----------
docker pull "$IMAGE" || true

# ---------- Stop existing containers ----------
docker rm -f paperclip caddy 2>/dev/null || true

# ---------- Start Paperclip ----------
docker run -d \
  --name paperclip \
  --network paperclip-net \
  --restart unless-stopped \
  --memory 1536m \
  --cpus 1.5 \
  -v "$MOUNT/data:/paperclip" \
  -e HOST=0.0.0.0 \
  -e PORT=3100 \
  -e PAPERCLIP_HOME=/paperclip \
  -e PAPERCLIP_DEPLOYMENT_MODE=authenticated \
  -e PAPERCLIP_DEPLOYMENT_EXPOSURE=public \
  -e PAPERCLIP_PUBLIC_URL="https://$DOMAIN" \
  -e BETTER_AUTH_SECRET="$BETTER_AUTH_SECRET" \
  -e PAPERCLIP_SECRETS_MASTER_KEY="$MASTER_KEY" \
  -e PAPERCLIP_SECRETS_STRICT_MODE=true \
  -e PAPERCLIP_STORAGE_PROVIDER=s3 \
  -e PAPERCLIP_STORAGE_S3_BUCKET="$BUCKET" \
  -e PAPERCLIP_STORAGE_S3_REGION=auto \
  -e PAPERCLIP_STORAGE_S3_ENDPOINT=https://storage.googleapis.com \
  -e PAPERCLIP_STORAGE_S3_FORCE_PATH_STYLE=true \
  -e AWS_ACCESS_KEY_ID="$HMAC_ACCESS_KEY" \
  -e AWS_SECRET_ACCESS_KEY="$HMAC_SECRET_KEY" \
  -e PAPERCLIP_DB_BACKUP_ENABLED=true \
  -e PAPERCLIP_DB_BACKUP_INTERVAL_MINUTES=60 \
  -e PAPERCLIP_DB_BACKUP_RETENTION_DAYS=30 \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_KEY" \
  -e OPENAI_API_KEY="$OPENAI_KEY" \
  "$IMAGE"

# ---------- Start Caddy (TLS termination) ----------
docker run -d \
  --name caddy \
  --network paperclip-net \
  --restart unless-stopped \
  -p 80:80 \
  -p 443:443 \
  -v "$MOUNT/Caddyfile:/etc/caddy/Caddyfile:ro" \
  -v "$MOUNT/caddy-data:/data" \
  -v "$MOUNT/caddy-config:/config" \
  caddy:2-alpine

# ---------- Backup sync cron ----------
cat > /etc/cron.d/paperclip-backup-sync <<CRON
# Sync Paperclip SQL dumps to GCS every hour at minute 30
30 * * * * root gsutil -m rsync -r "$MOUNT/data/instances/default/data/backups/" "gs://$BUCKET/backups/" 2>&1 | logger -t paperclip-backup
CRON
chmod 644 /etc/cron.d/paperclip-backup-sync

echo "Paperclip startup complete for tenant $TENANT"
`;

  // -----------------------------------------------------------------------
  // Instance template + Managed Instance Group (auto-healing)
  // -----------------------------------------------------------------------

  const healthCheck = new gcp.compute.HealthCheck(`${t}-health-check`, {
    name: `paperclip-${t}-hc`,
    project,
    checkIntervalSec: 30,
    timeoutSec: 10,
    healthyThreshold: 2,
    unhealthyThreshold: 3,
    httpHealthCheck: {
      port: 3100,
      requestPath: "/api/health",
    },
  });

  const instanceTemplate = new gcp.compute.InstanceTemplate(`${t}-template`, {
    namePrefix: `paperclip-${t}-`,
    machineType,
    project,
    tags: ["paperclip-server"],

    disks: [
      {
        boot: true,
        autoDelete: true,
        sourceImage: "projects/debian-cloud/global/images/family/debian-12",
        diskSizeGb: 10,
        diskType: "pd-balanced",
      },
    ],

    networkInterfaces: [
      {
        subnetwork: subnet.id,
        accessConfigs: [{ natIp: ip.address }],
      },
    ],

    serviceAccount: {
      email: sa.email,
      scopes: ["cloud-platform"],
    },

    metadata: {
      "startup-script": startupScript,
    },

    scheduling: {
      automaticRestart: true,
      onHostMaintenance: "MIGRATE",
    },

    labels: {
      tenant: t,
      managed_by: "pulumi",
    },
  });

  // MIG with size=1 gives auto-healing: if health check fails, VM is recreated
  const mig = new gcp.compute.InstanceGroupManager(`${t}-mig`, {
    name: `paperclip-${t}-mig`,
    zone,
    project,
    baseInstanceName: `paperclip-${t}`,
    targetSize: 1,

    versions: [{ instanceTemplate: instanceTemplate.selfLinkUnique }],

    autoHealingPolicies: {
      healthCheck: healthCheck.id,
      initialDelaySec: 300, // 5 min grace for Paperclip to start + embedded PG init
    },

    statefulDisks: [
      {
        deviceName: `paperclip-${t}-data`,
        deleteRule: "NEVER",
      },
    ],

    statefulExternalIps: [
      {
        interfaceName: "nic0",
        deleteRule: "NEVER",
      },
    ],
  });

  // Attach the persistent disk to the MIG as a stateful per-instance config
  new gcp.compute.PerInstanceConfig(`${t}-stateful-disk`, {
    zone,
    project,
    instanceGroupManager: mig.name,
    name: `paperclip-${t}-stateful`,
    preservedState: {
      disks: {
        [`paperclip-${t}-data`]: {
          source: dataDisk.selfLink,
          mode: "READ_WRITE",
        },
      },
      externalIps: {
        nic0: {
          autoDelete: "NEVER",
          ipAddress: {
            address: ip.selfLink,
          },
        },
      },
    },
  });

  tenantOutputs[t] = {
    vmIp: ip.address,
    bucketName: bucket.name,
    instanceGroupManager: mig.selfLink,
    domain,
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
      domain: out.domain,
      mig: out.instanceGroupManager,
    },
  ]),
);
