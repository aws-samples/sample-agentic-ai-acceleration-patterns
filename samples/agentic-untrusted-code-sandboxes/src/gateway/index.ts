// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// The gateway entry (spec §3.3, ADR-0017): `RunCodeToolTarget` and its
// props, which put the core behind agentic-runtime-isolation's tools
// gateway. This directory is the only part of src/ (with the demo app files)
// that may import agentic-runtime-isolation.

export { RunCodeToolTarget, type RunCodeToolTargetProps } from './run-code-tool.cdk';
export { DEFAULT_TARGET_NAME, RUN_CODE_TOOL } from './tool-schema';
