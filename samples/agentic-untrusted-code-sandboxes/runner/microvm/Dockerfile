# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# MicroVM image code artifact for the microvm backend (spec 3.5, ADR-0024).
# The microvm backend stages a zip with this file at its root and the
# runner sources under runner/, and AWS::Lambda::MicrovmImage builds it on
# the al2023-1 base (ARM_64). The base image is pinned by digest and the
# only package is python3 at an exact version (the AL2023 package of the
# base's release, 2023.12.20261102), so the build pulls nothing else.
FROM public.ecr.aws/lambda/microvms:al2023-minimal@sha256:3e45d46e969eb0d34ea954aff12747e15ca3f4a594788812c7218445777fa4bc
RUN dnf install -y python3-3.9.25-1.amzn2023.0.11 && dnf clean all
ENV RUNNER_BACKEND=microvm
WORKDIR /opt/runner
COPY runner/__init__.py runner/runner.py runner/wire.py runner/sizing.py runner/seccomp.py runner/job.py runner/server.py ./
EXPOSE 8080 9000
CMD ["python3", "-I", "/opt/runner/runner.py"]
