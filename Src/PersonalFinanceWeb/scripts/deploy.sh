#!/usr/bin/env bash
# Usage: scripts/deploy.sh [dev|prod] [--apply]
# Tests and builds the site, then plans (and with --apply, applies) Terraform. The API must be deployed first
# (config.json comes from its outputs). After an apply the CloudFront cache of the page is invalidated.
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
    aws cloudfront create-invalidation --distribution-id "$(terraform output -raw distribution_id)" --paths "/index.html" "/" >/dev/null
    "$repo_root/Scripts/tag-deployment.sh" "personalfinance-web-$environment" Src/PersonalFinanceWeb
fi
