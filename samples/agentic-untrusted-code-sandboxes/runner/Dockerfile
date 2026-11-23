# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Runner container image for the nitro and agentcore backends (spec 3.5,
# ADR-0024). COPY-only, so one file builds arm64 and amd64 without
# emulation.
# The build context is runner/ (lib/handlers/runner/ from the package).
# The build sets the platform (linux/arm64 for agentcore, the architecture
# of nitro.instanceTypes for nitro) with --platform; the base is a
# multi-arch index pinned by digest, so FROM picks that platform's image.
# The base carries the openssl binary the nitro runner uses for its
# certificate.
# The backend sets RUNNER_BACKEND (nitro or agentcore) in the container
# environment (ADR-0037).
FROM public.ecr.aws/docker/library/python:3.13-slim@sha256:e48f59cdba69a3cbd9ed2cf0f348d90d45a8d350d98134cf1070bc106ee9ed90
WORKDIR /opt/runner
COPY __init__.py runner.py wire.py sizing.py seccomp.py job.py server.py ./
EXPOSE 8080 8443
ENTRYPOINT ["python3", "-I", "/opt/runner/runner.py"]
