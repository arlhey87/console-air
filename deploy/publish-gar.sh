#!/bin/bash
# Build the image, push it to Google Artifact Registry and roll it out on GKE.
# All environment-specific values come from deploy/deploy.env (gitignored);
# see deploy/deploy.env.example. Usage: sh deploy/publish-gar.sh <VERSION>
set -euo pipefail

VERSION="${1:-}"
if [ -z "$VERSION" ]; then
  echo "Usage: sh deploy/publish-gar.sh <VERSION>   (e.g. 1.1.1-canary)" >&2
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
export REPLICAS
export IMAGE_NAME="${GAR_DOMAIN}/${GCLOUD_PROJECT}/${GAR_REPOSITORY}/${IMAGE}:${VERSION}"
export CLOUDSDK_CORE_DISABLE_PROMPTS=1

echo "Building ${IMAGE_NAME} (BASE_PATH='${BASE_PATH:-}')..."
$DOCKER build -f deploy/Dockerfile --build-arg BASE_PATH="${BASE_PATH:-}" -t "${IMAGE_NAME}" .

echo "Pushing to ${GAR_DOMAIN}..."
if [ -n "${GAR_SA_KEY_FILE:-}" ]; then
  $DOCKER login -u _json_key --password-stdin "https://${GAR_DOMAIN}" < "${GAR_SA_KEY_FILE}"
fi
$DOCKER push "${IMAGE_NAME}"
if [ -n "${GAR_SA_KEY_FILE:-}" ]; then
  $DOCKER logout "${GAR_DOMAIN}"
fi

echo "Rolling out on ${GKE_CLUSTER}..."
gcloud container clusters get-credentials "${GKE_CLUSTER}" --location "${GKE_LOCATION}" --project "${GCLOUD_PROJECT}"
envsubst '${IMAGE_NAME} ${REPLICAS}' < "${K8S_MANIFEST}" | kubectl apply -f -

echo "Done: ${IMAGE_NAME}"
