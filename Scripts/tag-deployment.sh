#!/usr/bin/env bash
# Bash equivalent of tag-deployment.ps1.
# Usage: tag-deployment.sh <system>-<component>-<environment> [repo-relative app folders...]
# Marks the current commit as deployed: an annotated tag, moved on every deploy (git tag --force).
# The tag is skipped (with a warning) when any of the folders has uncommitted changes, because the tag would then
# point at code that differs from what was deployed. Never fails the deployment that called it.
set -uo pipefail

tag="${1:-}"
shift || true
if [[ ! "$tag" =~ ^[a-z0-9]+(-[a-z0-9]+)+$ ]]; then
    echo "WARNING: Deployment tag '$tag' is not of the form <system>-<component>-<environment>." >&2
    exit 0
fi
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! commit="$(git -C "$repo_root" rev-parse --verify HEAD 2>/dev/null)"; then
    echo "WARNING: Deployment tag $tag was not written: the Git commit could not be resolved." >&2
    exit 0
fi

status_arguments=(-C "$repo_root" status --porcelain=v1 --untracked-files=all)
if (($#)); then status_arguments+=(-- "$@"); fi
if ! changes="$(git "${status_arguments[@]}")"; then
    echo "WARNING: Deployment tag $tag was not written: the Git worktree could not be inspected." >&2
    exit 0
fi
if [[ -n "$changes" ]]; then
    printf 'WARNING: Deployment tag %s was not written: the deployed code has uncommitted changes:\n%s\n' "$tag" "$changes" >&2
    exit 0
fi

stamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
if ! git -C "$repo_root" tag --annotate --force "$tag" --message "$tag deployed $stamp from $commit" "$commit" >/dev/null; then
    echo "WARNING: Deployment tag $tag was not written: git tag failed." >&2
    exit 0
fi
echo "Tagged: $tag -> ${commit:0:7}"
exit 0
