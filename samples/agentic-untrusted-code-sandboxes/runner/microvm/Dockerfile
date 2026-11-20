# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# MicroVM image code artifact for the microvm backend (spec 3.5, ADR-0024).
# The microvm backend stages a zip with this file at its root and the
# runner sources under runner/, and AWS::Lambda::MicrovmImage builds it on
# the al2023-1 base (ARM_64). Placeholder: the runner
# owner pins python3 to an exact package version here.
FROM public.ecr.aws/lambda/microvms:al2023-minimal@sha256:3e45d46e969eb0d34ea954aff12747e15ca3f4a594788812c7218445777fa4bc
RUN dnf install -y python3 && dnf clean all
WORKDIR /opt/runner
COPY runner/runner.py ./
EXPOSE 8080 9000
CMD ["python3", "-I", "/opt/runner/runner.py"]
