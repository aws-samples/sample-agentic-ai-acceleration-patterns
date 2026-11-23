#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Spike SD-1 and SD-3 (stress ADR-0022, docs/stress-dashboard.design.md section 12): a sink in
# the platform account, a link and metric filters in a cell account, and a read of the cell
# account's metrics from the platform account.
#
#   PLATFORM_PROFILE=<platform profile> CELL_PROFILE=<cell profile> CELL_ACCOUNT=<12 digits> AWS_REGION=<Region> \
#     sd1.sh up | drive | read | down
#
# `up` deploys the sink and then the link, and prints each stack's seconds. `drive` writes log
# lines into the cell's log group and invokes its function. `read` asks the platform account for
# the cell metrics by account id. `down` deletes the link stack, then the sink stack (the link
# before the sink, or the cell account is left with a dangling link), and prints the seconds.
# The cell account is a test account; the stacks are named StressDashSpike*.

set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${PLATFORM_PROFILE:?}" "${CELL_PROFILE:?}" "${CELL_ACCOUNT:?}" "${AWS_REGION:?}"
SINK_STACK=StressDashSpikeSink
LINK_STACK=StressDashSpikeLink
export AWS_DEFAULT_REGION="$AWS_REGION"

plat() { aws --profile "$PLATFORM_PROFILE" "$@"; }
cell() { aws --profile "$CELL_PROFILE" "$@"; }

seconds_since() { echo $(( $(date +%s) - $1 )); }

who() {
  echo "platform: $(plat sts get-caller-identity --query Account --output text)"
  echo "cell:     $(cell sts get-caller-identity --query Account --output text)"
}

case "${1:-}" in
  up)
    who
    t0=$(date +%s)
    plat cloudformation deploy --stack-name "$SINK_STACK" --template-file "${here}/sink.yaml" \
      --parameter-overrides CellAccountId="$CELL_ACCOUNT" --no-fail-on-empty-changeset
    echo "sink_deploy_seconds=$(seconds_since "$t0")"
    sink="$(plat cloudformation describe-stacks --stack-name "$SINK_STACK" --query "Stacks[0].Outputs[?OutputKey=='SinkArn'].OutputValue" --output text)"
    t0=$(date +%s)
    cell cloudformation deploy --stack-name "$LINK_STACK" --template-file "${here}/link.yaml" \
      --parameter-overrides SinkArn="$sink" --capabilities CAPABILITY_IAM --no-fail-on-empty-changeset \
      --tags stress:part=account-base
    echo "link_deploy_seconds=$(seconds_since "$t0")"
    ;;
  drive)
    who
    group=/stress-dashboard-spike/ingress
    stream="spike-$(date +%s)"
    cell logs create-log-stream --log-group-name "$group" --log-stream-name "$stream"
    now_ms=$(( $(date +%s) * 1000 ))
    events="["
    for i in $(seq 1 30); do
      status=200
      [ $((i % 5)) -eq 0 ] && status=429
      if [ "$status" = 200 ]; then
        line="{\"level\":\"INFO\",\"message\":\"request served\",\"status\":200,\"totalMs\":$((100 + i * 10)),\"ttfbMs\":$((50 + i))}"
      else
        line="{\"level\":\"WARN\",\"message\":\"request refused\",\"status\":429,\"reason\":\"rate\"}"
      fi
      events+="{\"timestamp\":$((now_ms + i * 100)),\"message\":$(printf '%s' "$line" | jq -Rs .)},"
    done
    for s in sts kms kms; do
      line="{\"level\":\"WARN\",\"message\":\"sdk retried\",\"service\":\"$s\",\"attempts\":2}"
      events+="{\"timestamp\":$((now_ms + 4000)),\"message\":$(printf '%s' "$line" | jq -Rs .)},"
    done
    events="${events%,}]"
    cell logs put-log-events --log-group-name "$group" --log-stream-name "$stream" --log-events "$events" --query rejectedLogEventsInfo
    fn="$(cell cloudformation describe-stacks --stack-name "$LINK_STACK" --query "Stacks[0].Outputs[?OutputKey=='FunctionName'].OutputValue" --output text)"
    for i in $(seq 1 12); do
      cell lambda invoke --function-name "$fn" --payload '{}' --cli-binary-format raw-in-base64-out /dev/null > /dev/null
    done
    echo "driven: 30 request lines (24 served, 6 refused), 3 retry lines, 12 invocations at $(date -u +%FT%TZ)"
    ;;
  read)
    who
    start="$(date -u -d '-40 minutes' +%FT%TZ)"
    end="$(date -u -d '+2 minutes' +%FT%TZ)"
    query="$(cat <<EOF
[
 {"Id":"served","AccountId":"${CELL_ACCOUNT}","MetricStat":{"Metric":{"Namespace":"StressCell","MetricName":"IngressRequests","Dimensions":[{"Name":"Status","Value":"200"}]},"Period":60,"Stat":"Sum"},"ReturnData":true},
 {"Id":"refused","AccountId":"${CELL_ACCOUNT}","MetricStat":{"Metric":{"Namespace":"StressCell","MetricName":"IngressRequests","Dimensions":[{"Name":"Status","Value":"429"}]},"Period":60,"Stat":"Sum"},"ReturnData":true},
 {"Id":"total","AccountId":"${CELL_ACCOUNT}","MetricStat":{"Metric":{"Namespace":"StressCell","MetricName":"IngressRequests"},"Period":60,"Stat":"Sum"},"ReturnData":true},
 {"Id":"p95","AccountId":"${CELL_ACCOUNT}","MetricStat":{"Metric":{"Namespace":"StressCell","MetricName":"IngressServedMs"},"Period":60,"Stat":"p95"},"ReturnData":true},
 {"Id":"p99","AccountId":"${CELL_ACCOUNT}","MetricStat":{"Metric":{"Namespace":"StressCell","MetricName":"IngressServedMs"},"Period":60,"Stat":"p99"},"ReturnData":true},
 {"Id":"kms","AccountId":"${CELL_ACCOUNT}","MetricStat":{"Metric":{"Namespace":"StressCell","MetricName":"SdkRetryLines","Dimensions":[{"Name":"Service","Value":"kms"}]},"Period":60,"Stat":"Sum"},"ReturnData":true},
 {"Id":"lambda","AccountId":"${CELL_ACCOUNT}","MetricStat":{"Metric":{"Namespace":"AWS/Lambda","MetricName":"Invocations"},"Period":60,"Stat":"Sum"},"ReturnData":true}
]
EOF
)"
    plat cloudwatch get-metric-data --metric-data-queries "$query" --start-time "$start" --end-time "$end" \
      --query "MetricDataResults[].[Id,StatusCode,sum(Values)]" --output text
    echo "-- list-metrics with linked accounts"
    plat cloudwatch list-metrics --namespace StressCell --include-linked-accounts --owning-account "$CELL_ACCOUNT" \
      --query "Metrics[].[MetricName,join(',',Dimensions[].Value)]" --output text
    ;;
  down)
    who
    t0=$(date +%s)
    cell cloudformation delete-stack --stack-name "$LINK_STACK"
    cell cloudformation wait stack-delete-complete --stack-name "$LINK_STACK"
    echo "link_destroy_seconds=$(seconds_since "$t0")"
    t0=$(date +%s)
    plat cloudformation delete-stack --stack-name "$SINK_STACK"
    plat cloudformation wait stack-delete-complete --stack-name "$SINK_STACK"
    echo "sink_destroy_seconds=$(seconds_since "$t0")"
    ;;
  *)
    echo "usage: sd1.sh up | drive | read | down" >&2
    exit 2
    ;;
esac
