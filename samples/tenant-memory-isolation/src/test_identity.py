# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
"""Cognito V2 trigger for synthetic validation identities, not production users.

The administrator creates these users. Entitlements come from this fixed
fixture rather than caller metadata or editable Cognito attributes.
"""
import re

SCOPES = {
    "a-shopping": ("tenant-a", "shopping-001"),
    "a-support": ("tenant-a", "support-001"),
    "b-shopping": ("tenant-b", "shopping-001"),
}
SEGMENT = re.compile(r"[a-z0-9][a-z0-9-]{0,62}")


def scope_claims(tenant_id, session_id):
    """Derive actor, session, and namespace claims from one tenant id (T-1).

    Cedar compares each claim with the request but cannot tie the claims to
    each other, so they are built together here: the namespace is always the
    actor's own shared path, and neither value can span a path segment.
    """
    if not SEGMENT.fullmatch(tenant_id) or not SEGMENT.fullmatch(session_id):
        raise ValueError("Tenant and session ids must be single lowercase path segments")
    return {
        "memory_actor": tenant_id,
        "memory_session": session_id,
        "memory_namespace": f"/tenants/{tenant_id}/shared/",
    }


def handler(event, _context):
    """Add issuer-controlled scopes to a Cognito access token."""
    username = event.get("userName")
    if username not in SCOPES:
        raise ValueError("Identity has no validation entitlement")
    event["response"] = {
        "claimsAndScopeOverrideDetails": {
            "accessTokenGeneration": {"claimsToAddOrOverride": scope_claims(*SCOPES[username])}
        }
    }
    return event
