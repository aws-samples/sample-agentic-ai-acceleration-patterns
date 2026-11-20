# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Runner container image for the nitro and agentcore backends (spec 3.5,
# ADR-0024). COPY-only, so one file builds arm64 and amd64 without
# emulation.
# The build context is runner/ (lib/handlers/runner/ from the package).
# Placeholder: the runner owner fills the COPY list.
# TARGETPLATFORM is set by the build (linux/arm64 for agentcore, the
# architecture of nitro.instanceTypes for nitro); the base is a multi-arch
# index pinned by digest.
ARG TARGETPLATFORM
FROM --platform=$TARGETPLATFORM public.ecr.aws/docker/library/python:3.13-slim@sha256:e48f59cdba69a3cbd9ed2cf0f348d90d45a8d350d98134cf1070bc106ee9ed90
WORKDIR /opt/runner
COPY runner.py ./
EXPOSE 8080 8443
ENTRYPOINT ["python3", "-I", "/opt/runner/runner.py"]
