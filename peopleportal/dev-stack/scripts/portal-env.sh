#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=peopleportal/dev-stack/scripts/common.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"
load_env
write_env=false
case "${1:-}" in
  '') [[ $# -eq 0 ]] || die "Usage: $0 [--write-env]" ;;
  --write-env) [[ $# -eq 1 ]] || die "Usage: $0 [--write-env]"; write_env=true ;;
  *) die "Usage: $0 [--write-env]" ;;
esac
gitea_token=$(<"$STACK_DIR/.gitea-token")
ui_env=''
if [[ $PORTAL_PORT != 3000 ]]; then
  ui_env="PP_DEV_PORTAL_PORT=$PORTAL_PORT"
fi
if [[ $WEBUI_PORT != 5173 ]]; then
  ui_env="${ui_env:+$ui_env$'\n'}PP_DEV_WEBUI_PORT=$WEBUI_PORT"
fi

block=$(cat <<EOF
# LOCAL development credentials. Do not commit or share this output.
NODE_ENV=development
PORT=$PORTAL_PORT
PEOPLEPORTAL_AUTHENTIK_TOKEN=$AUTHENTIK_BOOTSTRAP_TOKEN
PEOPLEPORTAL_AUTHENTIK_ENDPOINT=$AUTHENTIK_URL
PEOPLEPORTAL_OIDC_DSCVURL=$AUTHENTIK_URL/application/o/people-portal/.well-known/openid-configuration
PEOPLEPORTAL_OIDC_CLIENTID=$PORTAL_OIDC_CLIENT_ID
PEOPLEPORTAL_OIDC_CLIENTSECRET=$PORTAL_OIDC_CLIENT_SECRET
PEOPLEPORTAL_BASE_URL=$PORTAL_BASE_URL
PEOPLEPORTAL_TOKEN_SECRET=$PORTAL_TOKEN_SECRET
PEOPLEPORTAL_MONGO_URL=mongodb://127.0.0.1:$MONGO_PORT/people-portal?replicaSet=ppdev&directConnection=true
PEOPLEPORTAL_REDIS_URL=redis://127.0.0.1:$REDIS_PORT
PEOPLEPORTAL_GITEA_ENDPOINT=$GITEA_URL
PEOPLEPORTAL_GITEA_TOKEN=$gitea_token
PEOPLEPORTAL_GITEA_WEBHOOK_SECRET=$GITEA_WEBHOOK_SECRET
# Gitea is inside Docker; localhost there is not the application host.
PEOPLEPORTAL_WEBHOOK_URL=http://host.docker.internal:$PORTAL_PORT
PEOPLEPORTAL_SMTP_HOST=127.0.0.1
PEOPLEPORTAL_SMTP_PORT=$SMTP_PORT
PEOPLEPORTAL_SMTP_SECURE=false
PEOPLEPORTAL_SMTP_DEFAULTFROM=portal@example.invalid
PEOPLEPORTAL_SMTP_USER=dev
PEOPLEPORTAL_SMTP_PASS=dev
# Slack requires nonempty settings at startup. These do not call a real workspace.
PEOPLEPORTAL_SLACK_BOT_TOKEN=xoxb-local-placeholder
PEOPLEPORTAL_SLACK_INVITE_URL=https://example.invalid/local-slack
AWS_REGION=$AWS_REGION
AWS_ACCESS_KEY_ID=$S3_ACCESS_KEY
AWS_SECRET_ACCESS_KEY=$S3_SECRET_KEY
S3_BUCKET_NAME=$S3_BUCKET_NAME
# Follow-up: the server does not yet consume endpoint/path-style or AWS_ENABLED.
# No S3 service is included; uploads and AWS account features are unsupported.
S3_ENDPOINT=$S3_ENDPOINT
S3_FORCE_PATH_STYLE=true
AWS_ENABLED=false
AWS_ORG_ROOT_ID=dev-placeholder
AWS_NONPROD_OU_ID=dev-placeholder
AWS_MANAGEMENT_ACCOUNT_ID=000000000000
AWS_ADMIN_ROLE_NAME=AppDevNonProductionRole
AWS_DEFAULT_BUDGET_AMOUNT=0
AWS_BILLING_ALERT_EMAIL=dev@example.invalid
PHOTO_CHECK_ENABLED=false
EOF
)
if [[ -n $ui_env ]]; then
  block="$block"$'\n'"$ui_env"
fi
if [[ $write_env == true ]]; then
  target="$STACK_DIR/../server/.env.development"
  # noclobber creates only if absent, also refusing dangling symlinks. Never read
  # or replace an existing portal env file. Printing still works on a second run.
  if [[ -e $target || -L $target ]]; then
    echo 'Existing peopleportal/server/.env.development preserved; compare the printed block if needed.' >&2
  else
    (set -o noclobber; printf '%s\n' "$block" >"$target")
    chmod 600 "$target"
    echo 'Created peopleportal/server/.env.development (mode 600).' >&2
  fi
  target="$STACK_DIR/../webui/.env.development.local"
  if [[ -n $ui_env ]]; then
    if [[ -e $target || -L $target ]]; then
      echo 'Existing peopleportal/webui/.env.development.local preserved; compare its PP_DEV_* values with the printed block.' >&2
    else
      (set -o noclobber; printf '%s\n' "$ui_env" >"$target")
      chmod 600 "$target"
      echo 'Created peopleportal/webui/.env.development.local with alternate ports (mode 600).' >&2
    fi
  fi
fi
echo "Ready: authentik $AUTHENTIK_URL | Gitea $GITEA_URL | Mailpit http://$PUBLIC_HOST:$MAILPIT_PORT" >&2
echo 'Log in as akadmin; password is AUTHENTIK_BOOTSTRAP_PASSWORD in dev-stack/.env.' >&2
echo 'Paste the following into peopleportal/server/.env, or use --write-env for .env.development:' >&2
if [[ -n $ui_env ]]; then
  echo 'Also copy the PP_DEV_* lines into peopleportal/webui/.env.development.local, or use --write-env.' >&2
fi
printf '%s\n' "$block"
