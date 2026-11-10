<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
<!-- ASH v3.7.1 (awslabs/automated-security-helper@af1206a), container mode, run 2026-11-10 on the tree of this branch with cdk.out/ synthesised under the deployment profile. Findings are dispositioned in ../threat-model.md. -->
# ASH Security Scan Report

- **Report generated**: 2026-11-10T19:31:49+00:00
- **Time since scan**: 3 minutes

## Scan Metadata

- **Project**: ASH
- **Scan executed**: 2026-11-10T19:28:13+00:00
- **ASH version**: 3.7.1

## Summary

### Scanner Results

The table below shows findings by scanner, with status based on severity thresholds and dependencies:

- **Severity levels**:
  - **Suppressed (S)**: Findings that have been explicitly suppressed and don't affect scanner status
  - **Critical (C)**: Highest severity findings that require immediate attention
  - **High (H)**: Serious findings that should be addressed soon
  - **Medium (M)**: Moderate risk findings
  - **Low (L)**: Lower risk findings
  - **Info (I)**: Informational findings with minimal risk
- **Duration (Time)**: Time taken by the scanner to complete its execution
- **Actionable**: Number of findings at or above the threshold severity level that require attention
- **Result**:
  - **PASSED** = No findings at or above threshold
  - **FAILED** = Findings at or above threshold
  - **MISSING** = Required dependencies not available
  - **SKIPPED** = Scanner explicitly disabled
  - **ERROR** = Scanner execution error
- **Threshold**: The minimum severity level that will cause a scanner to fail
  - Thresholds: ALL, LOW, MEDIUM, HIGH, CRITICAL
  - Source: Values in parentheses indicate where the threshold is set:
    - `global` (global_settings section in the ASH_CONFIG used)
    - `config` (scanner config section in the ASH_CONFIG used)
    - `scanner` (default configuration in the plugin, if explicitly set)
- **Statistics calculation**:
  - All statistics are calculated from the final aggregated SARIF report
  - Suppressed findings are counted separately and do not contribute to actionable findings
  - Scanner status is determined by comparing actionable findings to the threshold

| Scanner | Suppressed | Critical | High | Medium | Low | Info | Actionable | Result | Threshold |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| bandit | 0 | 0 | 0 | 0 | 0 | 0 | 0 | PASSED | MEDIUM (global) |
| cdk-nag | 0 | 0 | 0 | 0 | 0 | 0 | 0 | ERROR | MEDIUM (global) |
| cfn-nag | 0 | 0 | 0 | 0 | 0 | 0 | 0 | PASSED | MEDIUM (global) |
| checkov | 0 | 5 | 0 | 0 | 0 | 0 | 5 | FAILED | MEDIUM (global) |
| detect-secrets | 0 | 0 | 0 | 0 | 0 | 0 | 0 | PASSED | MEDIUM (global) |
| grype | 0 | 0 | 0 | 1 | 0 | 0 | 1 | FAILED | MEDIUM (global) |
| npm-audit | 0 | 0 | 0 | 0 | 0 | 0 | 0 | PASSED | MEDIUM (global) |
| opengrep | 0 | 0 | 0 | 0 | 0 | 0 | 0 | PASSED | MEDIUM (global) |
| semgrep | 0 | 0 | 0 | 0 | 0 | 0 | 0 | PASSED | MEDIUM (global) |
| syft | 0 | 0 | 0 | 0 | 0 | 0 | 0 | PASSED | MEDIUM (global) |

### Top 2 Hotspots

Files with the highest number of security findings:

| Finding Count | File Location |
| ---: | --- |
| 5 | cdk.out/TenantMemoryIsolation.template.json |
| 1 | package-lock.json |

<h2>Detailed Findings</h2>

<details>
<summary>Show 6 actionable findings</summary>

### Finding 1: CKV_AWS_158

- **Severity**: HIGH
- **Scanner**: checkov
- **Rule ID**: CKV_AWS_158
- **Location**: cdk.out/TenantMemoryIsolation.template.json:3-19

**Description**:
Ensure that CloudWatch Log Group is encrypted by KMS

**Code Snippet**:
```
"PreTokenLogs7EABC296": {
   "Type": "AWS::Logs::LogGroup",
   "Properties": {
    "RetentionInDays": 7,
    "Tags": [
     {
      "Key": "sample",
      "Value": "tenant-memory-isolation"
     }
    ]
   },
   "UpdateReplacePolicy": "Delete",
   "DeletionPolicy": "Delete",
   "Metadata": {
    "aws:cdk:path": "TenantMemoryIsolation/PreTokenLogs/Resource"
   }
  },
```

---

### Finding 2: CKV_AWS_117

- **Severity**: HIGH
- **Scanner**: checkov
- **Rule ID**: CKV_AWS_117
- **Location**: cdk.out/TenantMemoryIsolation.template.json:86-128

**Description**:
Ensure that AWS Lambda function is configured inside a VPC

**Code Snippet**:
```
"PreTokenFunctionA92BCFD6": {
   "Type": "AWS::Lambda::Function",
   "Properties": {
    "Architectures": [
     "arm64"
    ],
    "Code": {
     "S3Bucket": "cdk-hnb659fds-assets-<account>-us-east-1",
     "S3Key": "11f10a819323bf63bd091b256ebcd7e547778161bea7af38e736de18160ea68c.zip"
    },
    "Description": "tenant-memory-isolation demo issuer: tenant_id claim from the immutable custom:tenantId attribute (ADR-0009)",
    "Handler": "index.handler",
    "LoggingConfig": {
     "LogGroup": {
      "Ref": "PreTokenLogs7EABC296"
     }
    },
    "MemorySize": 256,
    "Role": {
     "Fn::GetAtt": [
      "PreTokenRoleA77BE663",
      "Arn"
     ]
    },
    "Runtime": "nodejs24.x",
    "Tags": [
     {
      "Key": "sample",
      "Value": "tenant-memory-isolation"
     }
    ],
    "Timeout": 5
   },
   "DependsOn": [
    "PreTokenRoleA77BE663"
   ],
   "Metadata": {
    "aws:cdk:path": "TenantMemoryIsolation/PreTokenFunction/Resource",
    "aws:asset:path": "asset.11f10a819323bf63bd091b256ebcd7e547778161bea7af38e736de18160ea68c",
    "aws:asset:is-bundled": true,
    "aws:asset:property": "Code"
   }
  },
```

---

### Finding 3: CKV_AWS_116

- **Severity**: HIGH
- **Scanner**: checkov
- **Rule ID**: CKV_AWS_116
- **Location**: cdk.out/TenantMemoryIsolation.template.json:86-128

**Description**:
Ensure that AWS Lambda function is configured for a Dead Letter Queue(DLQ)

**Code Snippet**:
```
"PreTokenFunctionA92BCFD6": {
   "Type": "AWS::Lambda::Function",
   "Properties": {
    "Architectures": [
     "arm64"
    ],
    "Code": {
     "S3Bucket": "cdk-hnb659fds-assets-<account>-us-east-1",
     "S3Key": "11f10a819323bf63bd091b256ebcd7e547778161bea7af38e736de18160ea68c.zip"
    },
    "Description": "tenant-memory-isolation demo issuer: tenant_id claim from the immutable custom:tenantId attribute (ADR-0009)",
    "Handler": "index.handler",
    "LoggingConfig": {
     "LogGroup": {
      "Ref": "PreTokenLogs7EABC296"
     }
    },
    "MemorySize": 256,
    "Role": {
     "Fn::GetAtt": [
      "PreTokenRoleA77BE663",
      "Arn"
     ]
    },
    "Runtime": "nodejs24.x",
    "Tags": [
     {
      "Key": "sample",
      "Value": "tenant-memory-isolation"
     }
    ],
    "Timeout": 5
   },
   "DependsOn": [
    "PreTokenRoleA77BE663"
   ],
   "Metadata": {
    "aws:cdk:path": "TenantMemoryIsolation/PreTokenFunction/Resource",
    "aws:asset:path": "asset.11f10a819323bf63bd091b256ebcd7e547778161bea7af38e736de18160ea68c",
    "aws:asset:is-bundled": true,
    "aws:asset:property": "Code"
   }
  },
```

---

### Finding 4: CKV_AWS_115

- **Severity**: HIGH
- **Scanner**: checkov
- **Rule ID**: CKV_AWS_115
- **Location**: cdk.out/TenantMemoryIsolation.template.json:86-128

**Description**:
Ensure that AWS Lambda function is configured for function-level concurrent execution limit

**Code Snippet**:
```
"PreTokenFunctionA92BCFD6": {
   "Type": "AWS::Lambda::Function",
   "Properties": {
    "Architectures": [
     "arm64"
    ],
    "Code": {
     "S3Bucket": "cdk-hnb659fds-assets-<account>-us-east-1",
     "S3Key": "11f10a819323bf63bd091b256ebcd7e547778161bea7af38e736de18160ea68c.zip"
    },
    "Description": "tenant-memory-isolation demo issuer: tenant_id claim from the immutable custom:tenantId attribute (ADR-0009)",
    "Handler": "index.handler",
    "LoggingConfig": {
     "LogGroup": {
      "Ref": "PreTokenLogs7EABC296"
     }
    },
    "MemorySize": 256,
    "Role": {
     "Fn::GetAtt": [
      "PreTokenRoleA77BE663",
      "Arn"
     ]
    },
    "Runtime": "nodejs24.x",
    "Tags": [
     {
      "Key": "sample",
      "Value": "tenant-memory-isolation"
     }
    ],
    "Timeout": 5
   },
   "DependsOn": [
    "PreTokenRoleA77BE663"
   ],
   "Metadata": {
    "aws:cdk:path": "TenantMemoryIsolation/PreTokenFunction/Resource",
    "aws:asset:path": "asset.11f10a819323bf63bd091b256ebcd7e547778161bea7af38e736de18160ea68c",
    "aws:asset:is-bundled": true,
    "aws:asset:property": "Code"
   }
  },
```

---

### Finding 5: CKV_AWS_158

- **Severity**: HIGH
- **Scanner**: checkov
- **Rule ID**: CKV_AWS_158
- **Location**: cdk.out/TenantMemoryIsolation.template.json:733-750

**Description**:
Ensure that CloudWatch Log Group is encrypted by KMS

**Code Snippet**:
```
"TenantMemoryMemoryApplicationLogsE04BE8AB": {
   "Type": "AWS::Logs::LogGroup",
   "Properties": {
    "LogGroupName": "/aws/vendedlogs/bedrock-agentcore/memory/APPLICATION_LOGS/TenantMemoryIsolationTenantMemoryEAFBF637",
    "RetentionInDays": 30,
    "Tags": [
     {
      "Key": "sample",
      "Value": "tenant-memory-isolation"
     }
    ]
   },
   "UpdateReplacePolicy": "Delete",
   "DeletionPolicy": "Delete",
   "Metadata": {
    "aws:cdk:path": "TenantMemoryIsolation/TenantMemory/MemoryApplicationLogs/Resource"
   }
  },
```

---

### Finding 6: GHSA-g3hv-75wg-m249-minimatch

- **Severity**: MEDIUM
- **Scanner**: grype
- **Rule ID**: GHSA-g3hv-75wg-m249-minimatch
- **Location**: package-lock.json:1

**Description**:
A medium vulnerability in npm package: minimatch, version 10.2.6 was found at: /package-lock.json

</details>

---

*Report generated by [Automated Security Helper (ASH)](https://github.com/awslabs/automated-security-helper) at 2026-11-10T19:31:49+00:00*