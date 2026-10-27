# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
"""Cognito V2 trigger for synthetic validation identities, not production users.

The administrator creates these users. Entitlements come from this fixed
fixture rather than caller metadata or editable Cognito attributes.
"""

SCOPES = {
    "a-shopping": ("tenant-a", "shopping-001"),
    "a-support": ("tenant-a", "support-001"),
    "b-shopping": ("tenant-b", "shopping-001"),
}


def handler(event, _context):
    """Add issuer-controlled scopes to a Cognito access token."""
    username = event.get("userName")
    if username not in SCOPES:
        raise ValueError("Identity has no validation entitlement")
    actor, session = SCOPES[username]
    event["response"] = {
        "claimsAndScopeOverrideDetails": {
            "accessTokenGeneration": {
                "claimsToAddOrOverride": {
                    "memory_actor": actor,
                    "memory_session": session,
                    "memory_namespace": f"/tenants/{actor}/shared/",
                }
            }
        }
    }
    return event
