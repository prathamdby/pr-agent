#!/usr/bin/env bash
# Required-check gate. `check` must succeed on every pull request. Path-selected
# jobs must succeed; unselected jobs may skip. `commit-messages` skips on a push
# to main.
set -euo pipefail

: "${CHANGES_RESULT:?}"
: "${CHECK_RESULT:?}"
: "${COMMIT_MESSAGES_RESULT:?}"
: "${INTEGRATION_RESULT:?}"
: "${DOCKER_RESULT:?}"
: "${SITE_RESULT:?}"
: "${BACKEND_SELECTED:?}"
: "${SITE_SELECTED:?}"

echo "changes=${CHANGES_RESULT} check=${CHECK_RESULT} commit-messages=${COMMIT_MESSAGES_RESULT} integration=${INTEGRATION_RESULT} docker=${DOCKER_RESULT} site=${SITE_RESULT} backend=${BACKEND_SELECTED} site_filter=${SITE_SELECTED}"

if [ "$CHANGES_RESULT" != "success" ]; then
  echo "gate: failing on changes=${CHANGES_RESULT}"
  exit 1
fi
if [ "$CHECK_RESULT" != "success" ]; then
  echo "gate: check must succeed, got ${CHECK_RESULT}"
  exit 1
fi
case "$COMMIT_MESSAGES_RESULT" in
  success|skipped) ;;
  *)
    echo "gate: failing on commit-messages=${COMMIT_MESSAGES_RESULT}"
    exit 1
    ;;
esac

require_selected() {
  name="$1"
  result="$2"
  selected="$3"
  if [ "$selected" = "true" ]; then
    if [ "$result" != "success" ]; then
      echo "gate: $name selected but result=$result"
      exit 1
    fi
  else
    case "$result" in
      success|skipped) ;;
      *)
        echo "gate: failing on $name=$result"
        exit 1
        ;;
    esac
  fi
}

require_selected integration "$INTEGRATION_RESULT" "$BACKEND_SELECTED"
require_selected docker "$DOCKER_RESULT" "$BACKEND_SELECTED"
require_selected site "$SITE_RESULT" "$SITE_SELECTED"
echo "gate green"
