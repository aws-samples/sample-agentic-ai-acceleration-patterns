// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The edge stack (spec §3.1, ADR-0010): `us-east-1`, because CloudFront
 * takes its certificate and its web ACL only from there. It holds the ACM
 * certificate for `appDomain` (and `*.<appDomain>` in `host` mode),
 * validated by DNS in the deployer's zone, and the CloudFront-scope web ACL
 * with the rate rules of ADR-0009 and ADR-0021.
 */

import { Stack, StackProps } from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';
import { ResolvedInputs } from './inputs';

/** The response header that names the rate rule that answered (ADR-0021). */
export const RATE_RULE_HEADER = 'x-tfd-rate-rule';

/** WAF's rate window for the `*Per5Min` inputs. */
const RATE_WINDOW_SECONDS = 300;

/** The custom 429 body both rate rules answer with (§5.3: static, `no-store`). */
const TOO_MANY_REQUESTS_BODY = 'TooManyRequests';

export interface EdgeStackProps extends StackProps {
  readonly inputs: ResolvedInputs;
}

export class EdgeStack extends Stack {
  /** ARN of the `appDomain` certificate, in `us-east-1`. */
  public readonly certificateArn: string;
  /** ARN of the CloudFront-scope web ACL. */
  public readonly webAclArn: string;

  constructor(scope: Construct, id: string, props: EdgeStackProps) {
    super(scope, id, props);
    const { inputs } = props;

    const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', {
      hostedZoneId: inputs.hostedZone.zoneId,
      zoneName: inputs.hostedZone.zoneName,
    });
    // One validation record covers both names (spike S-1).
    const certificate = new acm.Certificate(this, 'Certificate', {
      domainName: inputs.appDomain,
      subjectAlternativeNames: inputs.addressing === 'host' ? [`*.${inputs.appDomain}`] : undefined,
      validation: acm.CertificateValidation.fromDns(zone),
    });
    this.certificateArn = certificate.certificateArn;

    const webAcl = new wafv2.CfnWebACL(this, 'WebAcl', {
      scope: 'CLOUDFRONT',
      defaultAction: { allow: {} },
      description: 'Tenant front door rate rules, per host and client IP in host mode, ADR-0009 and ADR-0021',
      visibilityConfig: visibility(`${this.stackName}-web-acl`),
      customResponseBodies: {
        [TOO_MANY_REQUESTS_BODY]: { contentType: 'APPLICATION_JSON', content: '{"message":"Too many requests"}' },
      },
      rules: inputs.addressing === 'host' ? hostModeRateRules(inputs.ipRequestsPer5Min, inputs.tenantRequestsPer5Min) : [],
    });
    this.webAclArn = webAcl.attrArn;
  }
}

/**
 * `host` mode's two rate rules, both scoped down to `/api/*` and
 * `/agents/*` so SPA loads are not counted (spike S-6): first per client IP
 * and host (ADR-0021), then per host (ADR-0009). `single` mode has none:
 * the cell limits each verified tenant (ADR-0009).
 */
export function hostModeRateRules(ipLimit: number, hostLimit: number): wafv2.CfnWebACL.RuleProperty[] {
  const lowerCaseHost: wafv2.CfnWebACL.RateBasedStatementCustomKeyProperty = {
    header: { name: 'host', textTransformations: [{ priority: 0, type: 'LOWERCASE' }] },
  };
  return [
    rateRule('PerIpPerHost', 0, ipLimit, [lowerCaseHost, { ip: {} }], 'ip'),
    rateRule('PerHost', 1, hostLimit, [lowerCaseHost], 'host'),
  ];
}

type CustomKey = wafv2.CfnWebACL.RateBasedStatementCustomKeyProperty;

function rateRule(name: string, priority: number, limit: number, customKeys: CustomKey[], ruleTag: string): wafv2.CfnWebACL.RuleProperty {
  return {
    name,
    priority,
    statement: {
      rateBasedStatement: {
        limit,
        evaluationWindowSec: RATE_WINDOW_SECONDS,
        aggregateKeyType: 'CUSTOM_KEYS',
        customKeys,
        scopeDownStatement: {
          orStatement: {
            statements: ['/api/', '/agents/'].map((prefix) => ({
              byteMatchStatement: {
                fieldToMatch: { uriPath: {} },
                positionalConstraint: 'STARTS_WITH',
                searchString: prefix,
                textTransformations: [{ priority: 0, type: 'NONE' }],
              },
            })),
          },
        },
      },
    },
    action: {
      block: {
        customResponse: {
          responseCode: 429,
          customResponseBodyKey: TOO_MANY_REQUESTS_BODY,
          responseHeaders: [
            { name: RATE_RULE_HEADER, value: ruleTag },
            { name: 'cache-control', value: 'no-store' },
          ],
        },
      },
    },
    visibilityConfig: visibility(name),
  };
}

function visibility(metricName: string): wafv2.CfnWebACL.VisibilityConfigProperty {
  return { cloudWatchMetricsEnabled: true, metricName: metricName.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 128), sampledRequestsEnabled: true };
}
