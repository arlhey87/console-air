#!/bin/bash
# Build the image, push it to Google Artifact Registry and roll it out on GKE.
# All environment-specific values come from deploy/deploy.env (gitignored);
# see deploy/deploy.env.example. Usage: bash deploy/publish-gar.sh <VERSION>
# DRY_RUN=1 bash deploy/publish-gar.sh <VERSION> checks gcloud, the kube context and the manifest only.
#
# The target never depends on whatever gcloud configuration or kubectl context happens to be active:
# gcloud is pinned through CLOUDSDK_* variables (the global active configuration is left untouched)
# and kubectl always runs with an explicit --context, restoring the previous current-context on exit.
set -euo pipefail

VERSION="${1:-}"
if [ -z "$VERSION" ]; then
  echo "Usage: bash deploy/publish-gar.sh <VERSION>   (e.g. 1.1.1-canary)" >&2
  exit 1
fi

ENV_FILE="${DEPLOY_ENV_FILE:-deploy/deploy.env}"
if [ ! -f "$ENV_FILE" ]; then
  echo "Missing $ENV_FILE — copy deploy/deploy.env.example and fill it in." >&2
  exit 1
fi
# shellcheck disable=SC1090
. "$ENV_FILE"

for var in GCLOUD_PROJECT GAR_LOCATION GAR_REPOSITORY IMAGE GKE_CLUSTER GKE_LOCATION K8S_MANIFEST REPLICAS; do
  value="${!var:-}"
  if [ -z "$value" ] || [[ "$value" == \<*\> ]]; then
    echo "$var is not set in $ENV_FILE" >&2
    exit 1
  fi
done

DOCKER="${DOCKER:-docker}"
GAR_DOMAIN="${GAR_LOCATION}-docker.pkg.dev"
KUBE_CONTEXT="${KUBE_CONTEXT:-gke_${GCLOUD_PROJECT}_${GKE_LOCATION}_${GKE_CLUSTER}}"
export REPLICAS
export IMAGE_NAME="${GAR_DOMAIN}/${GCLOUD_PROJECT}/${GAR_REPOSITORY}/${IMAGE}:${VERSION}"
export CLOUDSDK_CORE_DISABLE_PROMPTS=1
# Git Bash (MSYS) rewrites arguments that start with "/" into Windows paths when calling a Windows
# executable such as wsl.exe, so `--build-arg BASE_PATH=/akash-console` reached the build mangled
# and Next rejected the redirect routes. Applied to docker only: the gcloud wrapper relies on the
# conversion, so it must not be disabled globally.
docker_cli() { MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' $DOCKER "$@"; }

# --- gcloud: pin configuration, account and project for this process only ---------------------
if [ -n "${GCLOUD_CONFIGURATION:-}" ]; then
  if ! gcloud config configurations describe "$GCLOUD_CONFIGURATION" >/dev/null 2>&1; then
    echo "gcloud configuration '$GCLOUD_CONFIGURATION' does not exist (gcloud config configurations list)." >&2
    exit 1
  fi
  export CLOUDSDK_ACTIVE_CONFIG_NAME="$GCLOUD_CONFIGURATION"
fi
if [ -n "${GCLOUD_ACCOUNT:-}" ]; then
  export CLOUDSDK_CORE_ACCOUNT="$GCLOUD_ACCOUNT"
fi
export CLOUDSDK_CORE_PROJECT="$GCLOUD_PROJECT"

GCLOUD_ACTIVE_ACCOUNT="$(gcloud config get-value account 2>/dev/null | tr -d '\r')"
if [ -z "$GCLOUD_ACTIVE_ACCOUNT" ]; then
  echo "No gcloud account resolved for configuration '${CLOUDSDK_ACTIVE_CONFIG_NAME:-<active>}'." >&2
  exit 1
fi

echo "gcloud  configuration=${CLOUDSDK_ACTIVE_CONFIG_NAME:-<active>} account=${GCLOUD_ACTIVE_ACCOUNT} project=${GCLOUD_PROJECT}"
echo "kubectl context=${KUBE_CONTEXT}"
echo "image   ${IMAGE_NAME}"

# --- kubectl: fetch credentials, check the context, restore the caller's context on exit -------
# Windows builds of gcloud/kubectl may end lines with a carriage return, which breaks exact comparisons.
PREVIOUS_KUBE_CONTEXT="$(kubectl config current-context 2>/dev/null | tr -d '\r' || true)"
restore_kube_context() {
  if [ -n "$PREVIOUS_KUBE_CONTEXT" ] && [ "$PREVIOUS_KUBE_CONTEXT" != "$KUBE_CONTEXT" ]; then
    kubectl config use-context "$PREVIOUS_KUBE_CONTEXT" >/dev/null && echo "Restored kubectl context: $PREVIOUS_KUBE_CONTEXT"
  fi
}
trap restore_kube_context EXIT

gcloud container clusters get-credentials "${GKE_CLUSTER}" --location "${GKE_LOCATION}" --project "${GCLOUD_PROJECT}"
if ! kubectl config get-contexts -o name | tr -d '\r' | grep -qx "$KUBE_CONTEXT"; then
  echo "kubectl context '$KUBE_CONTEXT' not found after get-credentials; set KUBE_CONTEXT in $ENV_FILE." >&2
  exit 1
fi
kubectl --context "$KUBE_CONTEXT" get namespace default >/dev/null

if [ "${DRY_RUN:-}" = "1" ]; then
  echo "DRY_RUN=1: validating the rendered manifest on ${KUBE_CONTEXT} (server dry-run); no build, push or apply."
  envsubst '${IMAGE_NAME} ${REPLICAS}' < "${K8S_MANIFEST}" | kubectl --context "$KUBE_CONTEXT" apply --dry-run=server -f -
  exit 0
fi

# --- build & push -------------------------------------------------------------------------------
echo "Building ${IMAGE_NAME} (BASE_PATH='${BASE_PATH:-}')..."
docker_cli build -f deploy/Dockerfile --build-arg BASE_PATH="${BASE_PATH:-}" -t "${IMAGE_NAME}" .

echo "Pushing to ${GAR_DOMAIN}..."
if [ -n "${GAR_SA_KEY_FILE:-}" ]; then
  docker_cli login -u _json_key --password-stdin "https://${GAR_DOMAIN}" < "${GAR_SA_KEY_FILE}"
fi
docker_cli push "${IMAGE_NAME}"
if [ -n "${GAR_SA_KEY_FILE:-}" ]; then
  docker_cli logout "${GAR_DOMAIN}"
fi

# --- roll out -----------------------------------------------------------------------------------
echo "Rolling out on ${KUBE_CONTEXT}..."
envsubst '${IMAGE_NAME} ${REPLICAS}' < "${K8S_MANIFEST}" | kubectl --context "$KUBE_CONTEXT" apply -f -

echo "Done: ${IMAGE_NAME}"
