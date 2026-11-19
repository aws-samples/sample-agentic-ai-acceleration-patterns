// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// Stand-in for the registrar function (build slice S3,
// src/registrar/registrar.function.ts), so the stacks synthesise without it.
export const handler = async (): Promise<{ statusCode: number; body: string }> => ({
  statusCode: 503,
  body: '{"message":"registrar stub"}',
});
