// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The `allowedOrigins` list the integration app deploys every stack with
 * (spec §10 step 7, ADR-0040). The e2e suite runs the CORS checks only
 * against a stack whose `AllowedOrigins` output is exactly this list joined
 * with `,`. Reserved `example.com` names: no page there is ever served.
 */
export const E2E_ALLOWED_ORIGINS = ['https://app.example.com', 'https://*.tenants.example.com'] as const;
