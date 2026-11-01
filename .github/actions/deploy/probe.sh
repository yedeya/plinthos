#!/usr/bin/env bash
# The deploy lane's trust probe (docs/lanes.md, "The trust probe"). Run outside every
# environment, it tries to obtain each listed environment's AWS credential exactly as a deploy
# does, with this job's GitHub OIDC token, and writes one answer per environment to
# $RUNNER_TEMP/kanon-deploy-probe.json:
#
# - refused: STS answered AccessDenied, which is what the role's trust condition on the
#   environment's subject must do outside that environment;
# - obtained: STS handed out a credential, so the role trusts more than its environment;
# - unconfigured: no role is configured for the environment, or the attempt failed in any other
#   way (no OIDC token, an invalid token or ARN, an unreachable STS).
#
# It holds a credential for no longer than it takes to discard it, and prints neither the token
# nor the credential. tests/infra/deploy-probe.test.ts runs it against stand-ins for curl and aws.
set -uo pipefail

out="${RUNNER_TEMP:?RUNNER_TEMP is unset}/kanon-deploy-probe.json"
region="${PLINTHOS_AWS_REGION:-us-east-1}"

# The role each environment deploys with. Plinthos has one environment, production.
role_for() {
  case "$1" in
    production) printf '%s' "${AWS_DEPLOY_ROLE_ARN:-}" ;;
    *) printf '' ;;
  esac
}

answer_for() {
  local environment="$1" role token result
  role="$(role_for "$environment")"
  if [ -z "$role" ]; then
    echo "::warning::no deploy role is configured for $environment: set AWS_DEPLOY_ROLE_ARN (docs/deploy.md)" >&2
    echo unconfigured
    return
  fi
  if [ -z "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ] || [ -z "${ACTIONS_ID_TOKEN_REQUEST_TOKEN:-}" ]; then
    echo "::warning::this job can't request an OIDC token (id-token: write)" >&2
    echo unconfigured
    return
  fi
  token="$(curl -sS --fail --max-time 20 \
    -H "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \
    "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=sts.amazonaws.com" | jq -r '.value // empty')" || token=""
  if [ -z "$token" ]; then
    echo "::warning::the OIDC token request failed" >&2
    echo unconfigured
    return
  fi
  if result="$(aws sts assume-role-with-web-identity \
    --region "$region" \
    --role-arn "$role" \
    --role-session-name "kanon-deploy-probe" \
    --duration-seconds 900 \
    --web-identity-token "$token" \
    --query 'AssumedRoleUser.AssumedRoleId' --output text 2>&1)"; then
    echo "::error::$environment's deploy role handed a credential to a job outside the environment: its trust policy must name only that environment's subject" >&2
    echo obtained
  elif printf '%s' "$result" | grep -q 'AccessDenied'; then
    echo refused
  else
    echo "::warning::the probe of $environment's role failed for another reason than a refusal" >&2
    echo unconfigured
  fi
}

answers="{}"
environments="${ENVIRONMENTS:-}"
for environment in ${environments//,/ }; do
  answer="$(answer_for "$environment")"
  answers="$(jq -c --arg env "$environment" --arg answer "$answer" '. + {($env): $answer}' <<<"$answers")"
done
printf '%s\n' "$answers" > "$out"
echo "probe: $answers"
