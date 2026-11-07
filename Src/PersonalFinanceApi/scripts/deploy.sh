#!/usr/bin/env bash
# Usage: scripts/deploy.sh [dev|prod] [--apply]
# Lints, tests and builds the API, then plans (and with --apply, applies) Terraform. Deploy before the web.
# PERSONALFINANCE_MCP_SIGNING_SECRET (and optional PERSONALFINANCE_API_KEYS) come from the environment or
# doc/secrets.local.txt; the deploy fails without the signing secret.
set -euo pipefail

environment="dev"
apply=false
for argument in "$@"; do
    case "$argument" in
        dev|prod) environment="$argument" ;;
        --apply) apply=true ;;
        *) echo "Unknown argument: $argument (expected dev|prod and optionally --apply)" >&2; exit 2 ;;
    esac
done

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "$root/../.." && pwd)"
secrets_path="$repo_root/doc/secrets.local.txt"

secret() {
    local name="$1" required="$2"
    if [[ -n "${!name:-}" ]]; then printf '%s' "${!name}"; return; fi
    if [[ -f "$secrets_path" ]]; then
        local value
        value="$(sed -n -E "s/^[[:space:]]*${name}[[:space:]]*=[[:space:]]*(.+)$/\1/p" "$secrets_path" | head -n 1 | tr -d '\r' | sed -E 's/[[:space:]]+$//')"
        if [[ -n "$value" ]]; then printf '%s' "$value"; return; fi
    fi
    if [[ "$required" == "required" ]]; then echo "$name is required. Set it in the environment or add it to doc/secrets.local.txt" >&2; return 1; fi
}

TF_VAR_mcp_signing_secret="$(secret PERSONALFINANCE_MCP_SIGNING_SECRET required)"
TF_VAR_api_keys="$(secret PERSONALFINANCE_API_KEYS optional)"
export TF_VAR_mcp_signing_secret TF_VAR_api_keys
if [[ -z "${DEPLOY_FROM:-}" ]]; then
    if [[ "$(hostname)" == "cobalt" ]]; then DEPLOY_FROM="cobalt"; else DEPLOY_FROM="desktop"; fi
fi
export DEPLOY_FROM

cd "$root"
npm run lint
npm test
npm run build

cd "$root/infra"
terraform init -input=false
if terraform workspace list | sed -E 's/^[* ]+//' | grep -Fxq "$environment"; then terraform workspace select "$environment"; else terraform workspace new "$environment"; fi
terraform plan -var-file "$environment.tfvars" -out "$environment.tfplan"
if $apply; then
    terraform apply "$environment.tfplan"
    "$repo_root/Scripts/tag-deployment.sh" "personalfinance-api-$environment" Src/PersonalFinanceApi
fi
