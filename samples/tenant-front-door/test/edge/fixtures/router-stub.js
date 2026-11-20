// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// Stand-in for the router (build slice S1, src/router/router.js): every
// ROUTER_TOKENS literal, so the stacks' substitution is tested without it.
const APP_DOMAIN = "__TFD_APP_DOMAIN__";
const ADDRESSING = "__TFD_ADDRESSING__";
const TENANT_CLAIM = "__TFD_TENANT_CLAIM__";
const AGENT_INGRESS = "__TFD_AGENT_INGRESS__";
const RESERVED_LABELS = "__TFD_RESERVED_LABELS__";

function handler(event) {
  void APP_DOMAIN; void ADDRESSING; void TENANT_CLAIM; void AGENT_INGRESS; void RESERVED_LABELS;
  return event.request;
}
