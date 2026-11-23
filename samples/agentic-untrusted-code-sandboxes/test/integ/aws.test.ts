// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { execFile } from 'node:child_process';
import { Aws, redact } from './aws';
import { unavailableReason } from './leftovers';

jest.mock('node:child_process', () => ({ execFile: jest.fn() }));

type Callback = (error: Error | null, stdout?: string, stderr?: string) => void;

/** The shape `execFile` gives a failed process: an error with the process's `stderr` and exit `code`. */
const failWith = (stderr: string, code: number | string): void => {
  (execFile as unknown as jest.Mock).mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Callback) => {
    cb(Object.assign(new Error(`Command failed: aws sts get-caller-identity\n${stderr}`), { stderr, code }));
  });
};

const failure = async (args: string[]): Promise<Error & { stderr?: string }> => {
  const e = await new Aws('eu-west-1').cli(args).then(() => undefined, (err: unknown) => err);
  return e as Error & { stderr?: string };
};

describe('aws.cli', () => {
  test('keeps the CLI stderr on the error, and names the service and operation but not the arguments', async () => {
    failWith('Unable to locate credentials.', 255);
    const e = await failure(['route53resolver', 'get-firewall-rule-group', '--firewall-rule-group-id', 'rslvr-frg-1']);
    expect(e.stderr).toBe('Unable to locate credentials.');
    expect(e.message).toBe('aws route53resolver get-firewall-rule-group failed: Unable to locate credentials.');
    expect(unavailableReason(e)).toBe('no credentials found');
  });

  test('a missing aws binary is a check that could not run', async () => {
    (execFile as unknown as jest.Mock).mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Callback) => {
      // The shape a promisified execFile gives a process that never started: an empty stderr and stdout.
      cb(Object.assign(new Error('spawn aws ENOENT'), { code: 'ENOENT', stdout: '', stderr: '' }));
    });
    const e = await failure(['sts', 'get-caller-identity']);
    expect(unavailableReason(e)).toBe('the aws CLI could not be started');
  });

  test('replaces ARNs and account ids in the cause', async () => {
    const id = '1'.repeat(12);
    const key = `AKIA${'B'.repeat(16)}`;
    failWith(`An error occurred (AccessDeniedException): User: arn:aws:sts::${id}:assumed-role/Role/session is not authorized; account ${id}; key ${key}`, 254);
    const e = await failure(['service-quotas', 'get-service-quota']);
    expect(e.message).toBe('aws service-quotas get-service-quota failed: An error occurred (AccessDeniedException): User: <arn> is not authorized; account <account>; key <key>');
    expect(e.stderr).not.toContain(id);
    expect(e.stderr).not.toContain(key);
    expect(unavailableReason(e)).toBe('access denied');
  });

  test('a process stopped by a signal, with no stderr, is described without its command line', async () => {
    (execFile as unknown as jest.Mock).mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Callback) => {
      cb(Object.assign(new Error('Command failed: aws route53resolver get-firewall-rule-group --firewall-rule-group-id rslvr-frg-1'), { code: null, signal: 'SIGKILL', stderr: '' }));
    });
    const e = await failure(['route53resolver', 'get-firewall-rule-group', '--firewall-rule-group-id', 'rslvr-frg-1']);
    expect(e.message).toBe('aws route53resolver get-firewall-rule-group failed: the aws CLI exited with signal SIGKILL');
  });

  test('the cause is read from the whole stderr, and the message carries its first 2000 characters', async () => {
    failWith(`${'Traceback line\n'.repeat(200)}An error occurred (ExpiredToken) when calling the GetServiceQuota operation`, 255);
    const e = await failure(['service-quotas', 'get-service-quota']);
    expect(e.message.length).toBe('aws service-quotas get-service-quota failed: '.length + 2000);
    expect(e.message).not.toContain('ExpiredToken');
    expect(unavailableReason(e)).toBe('the credentials expired');
  });
});

describe('redact', () => {
  const id = '1'.repeat(12);
  test.each([
    ['an ASIA access key id', `key ASIA${'C'.repeat(16)} used`, 'key <key> used'],
    ['an aws-cn ARN', `on arn:aws-cn:iam::${id}:role/R.`, 'on <arn>'],
    ['a session token', `token IQoJ${'b'.repeat(60)} sent`, 'token <token> sent'],
    ['the X-Amz query values of a presigned URL', 'https://h/?X-Amz-Security-Token=abc%2F&X-Amz-Signature=def', 'https://h/?X-Amz-Security-Token=<redacted>&X-Amz-Signature=<redacted>'],
    ['a secret key', `secret ${'A'.repeat(20)}/${'b'.repeat(19)} end`, 'secret <secret> end'],
    ['an account id glued to a word', `Role_${id}x`, 'Role_<account>x'],
  ])('replaces %s', (_shape, text, expected) => {
    expect(redact(text)).toBe(expected);
  });

  test('leaves a 13-digit number alone', () => {
    expect(redact(`${id}3`)).toBe(`${id}3`);
  });
});
