# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# The tenants a platform-mode run drives (docs/stress-test.spec.md §3.3, §4.2; stress/README.md,
# "Platform mode: manifests"). The slice seeds nothing in this mode: it reads what the other
# slices made and keeps the tenants it can drive.
#
#   jq -n --slurpfile cp control-plane.json --slurpfile ti tenant-identity.json \
#     --argjson active <tenants the tier drives> --arg scale <tier> -f platform-tenants.jq
#
# The control plane's steady set (`seeded` in control-plane.json) is the platform's tenants;
# `churn` and `extra` belong to the control-plane scenarios and are never driven here. A
# steady tenant is driven when tenant-identity.json lists it with an admin user; the users are
# the ones that file lists. Everything else is refused, by tenant and reason:
#
#   no-identity-tenant   tenant-identity.json does not list the control plane's tenant
#   no-user              it lists the tenant with no admin user name
#
# `ignored` lists the identity tenants the control plane does not place (the identity slice's
# own probe tenants): not refused, only not part of the platform's steady set.
#
# The answer holds `manifest` (the shape k6's `loadManifest` reads, first `active` tenants
# flagged active), `refused` and `ignored`. Ids and user names only: never a token or a password.

($cp[0].seeded // []) as $steady
| (($ti[0].seeded // []) | map({key: .tenantId, value: .}) | from_entries) as $identity
| ($steady | map(. as $id | ($identity[$id] // null) as $t
    | if $t == null then {tenantId: $id, reason: "no-identity-tenant"}
      elif (($t.admin.username // "") | length) == 0 then {tenantId: $id, reason: "no-user"}
      else {tenantId: $id, tenant: $t} end)) as $checked
| {
    manifest: {
      scale: $scale,
      tenants: ($checked | map(select(has("tenant"))) | to_entries
        | map(.key as $i | .value.tenant as $t
          | {tenantId: $t.tenantId, admin: {username: $t.admin.username}, users: [($t.users // [])[] | {username: .username}], active: ($i < $active)})),
    },
    refused: ($checked | map(select(has("tenant") | not))),
    ignored: (($ti[0].seeded // []) | map(select(.tenantId as $id | ($steady | index($id)) == null) | {tenantId, reason: "not-in-control-plane"}))
  }
