// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as logs from 'aws-cdk-lib/aws-logs';
import { CELL_DIMENSIONS, CELL_NAMESPACE, addCellMetricFilters } from '../application/cell-metrics';

function synth(interceptors = 2): { template: Template; ids: Record<string, string> } {
  const stack = new Stack(new App(), 'Cell');
  const group = (id: string): logs.LogGroup => new logs.LogGroup(stack, id);
  const access = group('Access');
  const ingress = group('Ingress');
  const authorizer = group('Authorizer');
  const interceptorGroups = Array.from({ length: interceptors }, (_, i) => group(`Interceptor${i}`));
  addCellMetricFilters(stack, { access, ingress, authorizer, interceptors: interceptorGroups });
  const template = Template.fromStack(stack);
  const ids = Object.fromEntries([['access', access], ['ingress', ingress], ['authorizer', authorizer], ...interceptorGroups.map((g, i) => [`interceptor${i}`, g])].map(([k, g]) => [k as string, stack.resolve((g as logs.LogGroup).logGroupName).Ref as string]));
  return { template, ids };
}

interface Transformation {
  MetricNamespace: string;
  MetricName: string;
  MetricValue: string;
  Dimensions?: { Key: string; Value: string }[];
}
type Filter = { Properties: { LogGroupName: { Ref: string }; FilterPattern: string; MetricTransformations: Transformation[] } };

function filters(template: Template): Filter[] {
  return Object.values(template.findResources('AWS::Logs::MetricFilter')) as unknown as Filter[];
}

describe('the cell metric filters of the run dashboard (stress ADR-0022, design §3.2)', () => {
  const { template, ids } = synth();
  const all = filters(template);
  const transform = (f: Filter) => f.Properties.MetricTransformations[0]!;

  it('publishes into StressCell only', () => {
    expect(all.length).toBeGreaterThan(10);
    for (const f of all) expect(transform(f).MetricNamespace).toBe(CELL_NAMESPACE);
  });

  it('carries no tenant, user, agent or token dimension, and no more than three dimensions', () => {
    for (const f of all) {
      const dims = transform(f).Dimensions ?? [];
      expect(dims.length).toBeLessThanOrEqual(3);
      for (const d of dims) expect(CELL_DIMENSIONS as readonly string[]).toContain(d.Key);
      expect(JSON.stringify(dims)).not.toMatch(/tenant|user|agent|token/i);
    }
  });

  it('puts the sdk retried filter on the ingress, the authoriser and both interceptor log groups', () => {
    const retried = all.filter((f) => transform(f).MetricName === 'SdkRetryLines' && (transform(f).Dimensions ?? []).length > 0);
    const expected = [ids.ingress, ids.authorizer, ids.interceptor0, ids.interceptor1];
    expect(retried.map((f) => f.Properties.LogGroupName.Ref).sort()).toEqual(expected.sort());
    for (const f of retried) {
      expect(f.Properties.FilterPattern).toBe('{ $.message = "sdk retried" }');
      expect(transform(f).Dimensions).toEqual([{ Key: 'Service', Value: '$.service' }]);
    }
  });

  it('gives a breakdown and a total beside it, so the dashboard can draw either', () => {
    for (const name of ['IngressRequests', 'IngressRefused', 'AuthorizerRefused', 'SdkRetryLines']) {
      const mine = all.filter((f) => transform(f).MetricName === name);
      expect(mine.some((f) => (transform(f).Dimensions ?? []).length === 0)).toBe(true);
      expect(mine.some((f) => (transform(f).Dimensions ?? []).length > 0)).toBe(true);
    }
  });

  it('reads the served time and the first byte from the ingress log, and the status from the access log', () => {
    const by = (name: string) => all.filter((f) => transform(f).MetricName === name);
    expect(by('IngressServedMs').map((f) => [f.Properties.LogGroupName.Ref, transform(f).MetricValue])).toEqual([[ids.ingress, '$.totalMs']]);
    expect(by('IngressTtfbMs').map((f) => transform(f).MetricValue)).toEqual(['$.ttfbMs']);
    expect(by('IngressRequests').every((f) => f.Properties.LogGroupName.Ref === ids.access)).toBe(true);
  });

  it('keys the authoriser refusal on the reason only, because one of its lines has no status', () => {
    const f = all.find((x) => x.Properties.LogGroupName.Ref === ids.authorizer && transform(x).MetricName === 'AuthorizerRefused' && transform(x).Dimensions !== undefined)!;
    expect(transform(f).Dimensions).toEqual([{ Key: 'Reason', Value: '$.reason' }]);
  });

  it('adds one interceptor filter pair for each tools gateway', () => {
    expect(filters(synth(1).template).filter((f) => transform(f).MetricName === 'SdkRetryLines').length).toBe(6);
    expect(filters(synth(3).template).filter((f) => transform(f).MetricName === 'SdkRetryLines').length).toBe(10);
  });
});
