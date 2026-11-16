set -euo pipefail

case "${TARGET_ENV:-}" in
  staging)
    test "${PROJECT_ID:-}" = spain-nextgen-staging
    [[ "${CALLBACK_SECRET_VERSION:-}" =~ ^[1-9][0-9]*$ ]] || exit 1
    [[ "${EMBED_SECRET_VERSION:-}" =~ ^[1-9][0-9]*$ ]] || exit 1
    printf 'CALLBACK_SECRET_MAPPING=,BIQ_THEME_JOB_RESULT_TOKEN=BIQ_THEME_JOB_RESULT_TOKEN:%s\n' "$CALLBACK_SECRET_VERSION"
    printf 'PINNED_EMBED_VERSION=%s\n' "$EMBED_SECRET_VERSION"
    ;;
  production)
    printf 'CALLBACK_SECRET_MAPPING=\nPINNED_EMBED_VERSION=latest\n'
    ;;
  *) exit 1 ;;
esac
